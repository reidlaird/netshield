import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectWindowsSnapshot } from './src/windowsCollector.js';
import { diffConnections, publicRemoteConnections, isPrivateOrReservedIP } from './src/connectionUtils.js';
import { investigateIp, traceRoute } from './src/investigator.js';
import { openStore } from './src/store.js';
import { PacketSniffer } from './src/packetSniffer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3010);
const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });
const store = openStore(path.join(DATA_DIR, 'netshield.sqlite'));

let settings = store.updateSettings({});
let status = {
  collector: 'starting',
  lastError: '',
  collectedAt: '',
  adapters: [],
  routes: []
};
let currentConnections = [];
let connectionMap = new Map();
let pollTimer = null;

const connectionStats = new Map();
const globalDnsCache = new Map();
let activePortMap = new Map();

const packetSniffer = new PacketSniffer();
packetSniffer.on('packet', (pkt) => {
  if (pkt.domains.length && pkt.resolvedIps.length) {
    for (const ip of pkt.resolvedIps) {
      globalDnsCache.set(ip, pkt.domains[0]);
    }
  }

  if (!pkt.srcIp || !pkt.dstIp || !pkt.srcPort || !pkt.dstPort) return;

  let connId = null;
  let isOutbound = false;

  const outKey = `${pkt.proto}|${pkt.srcIp}|${pkt.srcPort}`;
  const inKey = `${pkt.proto}|${pkt.dstIp}|${pkt.dstPort}`;

  if (activePortMap.has(outKey)) {
    connId = activePortMap.get(outKey);
    isOutbound = true;
  } else if (activePortMap.has(inKey)) {
    connId = activePortMap.get(inKey);
    isOutbound = false;
  }

  if (connId) {
    const stats = connectionStats.get(connId);
    if (!stats) return;
    
    if (isOutbound) {
      stats.bytesOut += pkt.len;
    } else {
      stats.bytesIn += pkt.len;
    }

    for (const domain of pkt.domains) {
      stats.domains.add(domain);
    }
  }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => {
  res.json(buildState());
});

app.get('/api/connections', (_req, res) => {
  res.json(currentConnections);
});

app.get('/api/history', (req, res) => {
  res.json(store.getHistory(Number(req.query.limit || 500)));
});

app.get('/api/investigate/:ip', async (req, res) => {
  try {
    const investigation = await investigateIp(req.params.ip, { store });
    broadcast({ type: 'investigation_update', investigation });
    res.json(investigation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/routes', async (req, res) => {
  const target = String(req.body.target || '').trim();
  if (!target) return res.status(400).json({ error: 'target is required' });

  const route = await traceRoute(target, { store });
  broadcast({ type: 'route_update', route });
  res.json(route);
});

app.post('/api/settings', (req, res) => {
  settings = store.updateSettings(req.body || {});
  restartPolling();
  broadcast({ type: 'settings_update', settings });
  res.json(settings);
});

app.post('/api/history/clear', (_req, res) => {
  store.clearHistory();
  broadcast({ type: 'history_cleared' });
  res.json({ success: true });
});

// Saved trace reports: standalone HTML files kept in DATA_DIR/reports with a
// JSON metadata sidecar per report so the list survives restarts.
function isSafeReportId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');
}

function listReports() {
  const reports = [];
  for (const file of fs.readdirSync(REPORTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      reports.push(JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, file), 'utf8')));
    } catch {
      // Skip unreadable metadata rather than failing the whole list
    }
  }
  return reports.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

app.get('/api/reports', (_req, res) => {
  res.json(listReports());
});

app.post('/api/reports', (req, res) => {
  const { html, target, generatedAt, hopCount, processName } = req.body || {};
  if (typeof html !== 'string' || !html.trim()) return res.status(400).json({ error: 'html is required' });
  if (typeof target !== 'string' || !target.trim()) return res.status(400).json({ error: 'target is required' });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const safeTarget = target.replace(/[^a-zA-Z0-9.-]/g, '_');
  let id = `netshield-trace-${safeTarget}-${stamp}`;
  let suffix = 1;
  while (fs.existsSync(path.join(REPORTS_DIR, `${id}.html`))) {
    id = `netshield-trace-${safeTarget}-${stamp}-${suffix++}`;
  }

  const meta = {
    id,
    filename: `${id}.html`,
    target: target.trim(),
    generatedAt: typeof generatedAt === 'string' && generatedAt ? generatedAt : new Date().toISOString(),
    hopCount: Number(hopCount) || 0,
    processName: typeof processName === 'string' ? processName : '',
    sizeBytes: Buffer.byteLength(html, 'utf8')
  };
  fs.writeFileSync(path.join(REPORTS_DIR, `${id}.html`), html, 'utf8');
  fs.writeFileSync(path.join(REPORTS_DIR, `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
  broadcast({ type: 'reports_update', reports: listReports() });
  res.json(meta);
});

app.get('/api/reports/:id', (req, res) => {
  if (!isSafeReportId(req.params.id)) return res.status(400).json({ error: 'invalid report id' });
  const file = path.join(REPORTS_DIR, `${req.params.id}.html`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'report not found' });
  res.type('html').sendFile(file);
});

app.get('/api/reports/:id/download', (req, res) => {
  if (!isSafeReportId(req.params.id)) return res.status(400).json({ error: 'invalid report id' });
  const file = path.join(REPORTS_DIR, `${req.params.id}.html`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'report not found' });
  res.download(file, `${req.params.id}.html`);
});

app.delete('/api/reports/:id', (req, res) => {
  if (!isSafeReportId(req.params.id)) return res.status(400).json({ error: 'invalid report id' });
  const file = path.join(REPORTS_DIR, `${req.params.id}.html`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'report not found' });
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(REPORTS_DIR, `${req.params.id}.json`), { force: true });
  broadcast({ type: 'reports_update', reports: listReports() });
  res.json({ success: true });
});

const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
}

app.get('*', (_req, res) => {
  const indexPath = path.join(frontendDistPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send('NetShield Windows Connection Investigator is running. Start the Vite frontend with npm run dev --prefix frontend.');
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      ...buildState(),
      history: store.getHistory(250),
      reports: listReports()
    }
  }));

  ws.on('close', () => clients.delete(ws));
});

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function buildState() {
  const activeInvestigations = {};
  const statsPayload = {};
  for (const conn of currentConnections) {
    const inv = store.readInvestigation(conn.remoteAddress);
    if (inv) activeInvestigations[conn.remoteAddress] = inv;
    if (connectionStats.has(conn.id)) {
      const s = connectionStats.get(conn.id);
      statsPayload[conn.id] = { bytesIn: s.bytesIn, bytesOut: s.bytesOut, domains: Array.from(s.domains) };
    }
  }

  return {
    status,
    settings,
    connections: currentConnections,
    publicConnections: publicRemoteConnections(currentConnections),
    historyCount: store.getHistory(1).length,
    investigations: activeInvestigations,
    stats: statsPayload
  };
}

async function pollConnections() {
  try {
    const snapshot = await collectWindowsSnapshot();
    const visibleConnections = settings.selectedAdapter
      ? snapshot.connections.filter((connection) => connection.interfaceAlias === settings.selectedAdapter)
      : snapshot.connections;

    const diff = diffConnections(connectionMap, visibleConnections, snapshot.collectedAt);
    connectionMap = diff.nextMap;
    currentConnections = diff.snapshot;
    status = {
      collector: 'running',
      lastError: '',
      collectedAt: snapshot.collectedAt,
      adapters: snapshot.adapters,
      routes: snapshot.routes
    };

    const changed = [...diff.added, ...diff.updated, ...diff.closed];
    if (changed.length) {
      store.saveConnections(changed);
    }
    store.pruneHistory(settings.historyRetentionDays);

    activePortMap.clear();
    const statsPayload = {};
    for (const conn of currentConnections) {
      activePortMap.set(`${conn.protocol}|${conn.localAddress}|${conn.localPort}`, conn.id);
      
      if (!connectionStats.has(conn.id)) {
        connectionStats.set(conn.id, { bytesIn: 0, bytesOut: 0, domains: new Set() });
      }
      const stats = connectionStats.get(conn.id);
      if (globalDnsCache.has(conn.remoteAddress) && stats.domains.size === 0) {
        stats.domains.add(globalDnsCache.get(conn.remoteAddress));
      }
      
      statsPayload[conn.id] = {
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        domains: Array.from(stats.domains)
      };
    }

    broadcast({
      type: changed.length ? 'connection_delta' : 'connection_snapshot',
      connections: currentConnections,
      added: diff.added,
      updated: diff.updated,
      closed: diff.closed,
      status,
      stats: statsPayload
    });

    const newPublicIPs = new Set(
      diff.added
        .map(c => c.remoteAddress)
        .filter(ip => !isPrivateOrReservedIP(ip))
    );
    for (const ip of newPublicIPs) {
      // investigateIp handles caching internally; calling it unconditionally
      // lets stale or previously-failed lookups heal instead of sticking forever.
      investigateIp(ip, { store })
        .then(inv => broadcast({ type: 'investigation_update', investigation: inv }))
        .catch(e => console.error('Auto-investigate failed:', e.message));
    }
  } catch (error) {
    status = { ...status, collector: 'error', lastError: error.message };
    broadcast({ type: 'collector_error', status });
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollConnections, settings.pollIntervalMs);
  pollConnections();
}

server.listen(PORT, () => {
  console.log(`NetShield Windows Connection Investigator running on http://localhost:${PORT}`);
  restartPolling();
  packetSniffer.start();
});
