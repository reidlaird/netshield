import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectWindowsSnapshot } from './src/windowsCollector.js';
import { diffConnections, publicRemoteConnections } from './src/connectionUtils.js';
import { investigateIp, traceRoute } from './src/investigator.js';
import { openStore } from './src/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3010);
const DATA_DIR = path.join(__dirname, 'data');
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
      history: store.getHistory(250)
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
  return {
    status,
    settings,
    connections: currentConnections,
    publicConnections: publicRemoteConnections(currentConnections),
    historyCount: store.getHistory(1).length
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

    broadcast({
      type: changed.length ? 'connection_delta' : 'connection_snapshot',
      connections: currentConnections,
      added: diff.added,
      updated: diff.updated,
      closed: diff.closed,
      status
    });
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
});
