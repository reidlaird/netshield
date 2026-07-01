import { useEffect, useMemo, useRef, useState } from 'react';
import { WorldMapSvg } from './WorldMapSvg';
import './App.css';

type CollectorStatus = {
  collector: 'starting' | 'running' | 'error';
  lastError: string;
  collectedAt: string;
  adapters: Adapter[];
  routes: DefaultRoute[];
};

type Adapter = {
  interfaceAlias: string;
  ipv4: string[];
  ipv6: string[];
  gateway: string[];
};

type DefaultRoute = {
  destinationPrefix: string;
  gateway: string;
  interfaceAlias: string;
  routeMetric: number;
};

type Settings = {
  selectedAdapter: string;
  pollIntervalMs: number;
  historyRetentionDays: number;
  geoIpDatabasePath: string;
  optionalApisEnabled: boolean;
};

type Connection = {
  id: string;
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid: number;
  processName: string;
  processPath: string;
  interfaceAlias: string;
  gateway: string;
  firstSeen: string;
  lastSeen: string;
  status: 'open' | 'closed';
};

type Investigation = {
  ip: string;
  checkedAt: string;
  privateAddress: boolean;
  ptr: string[];
  dnsCacheHints: Array<{ Entry?: string; Name?: string; Type?: string; Data?: string }>;
  rdap: null | {
    handle?: string;
    name?: string;
    countryCode?: string;
    country?: string;
    asn?: string;
    links?: string[];
    error?: string;
  };
  owner?: null | {
    name: string;
    isp: string;
    asn: string;
    asname: string;
    error: string;
  };
  geo: {
    countryCode: string;
    country: string;
    city?: string;
    latitude: number | null;
    longitude: number | null;
    source: string;
  };
  fromCache?: boolean;
};

type RouteTrace = {
  target: string;
  checkedAt: string;
  hops: Array<{ hop: number; address: string; latenciesMs: number[]; timedOut: boolean }>;
  error?: string;
};

type ConnectionStats = {
  bytesIn: number;
  bytesOut: number;
  domains: string[];
};

const EMPTY_STATUS: CollectorStatus = {
  collector: 'starting',
  lastError: '',
  collectedAt: '',
  adapters: [],
  routes: []
};

const EMPTY_SETTINGS: Settings = {
  selectedAdapter: '',
  pollIntervalMs: 2000,
  historyRetentionDays: 7,
  geoIpDatabasePath: '',
  optionalApisEnabled: false
};

function App() {
  const [status, setStatus] = useState<CollectorStatus>(EMPTY_STATUS);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [history, setHistory] = useState<Connection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('all');
  const [wsConnected, setWsConnected] = useState(false);
  const [investigations, setInvestigations] = useState<Record<string, Investigation>>({});
  const [routes, setRoutes] = useState<Record<string, RouteTrace>>({});
  const [connectionStats, setConnectionStats] = useState<Record<string, ConnectionStats>>({});
  const [investigating, setInvestigating] = useState<Record<string, boolean>>({});
  const [tracing, setTracing] = useState<Record<string, boolean>>({});
  const wsRef = useRef<WebSocket | null>(null);

  const getApiUrl = (path: string) => {
    const origin = window.location.port === '5173'
      ? `${window.location.protocol}//${window.location.hostname}:3010`
      : window.location.origin;
    return `${origin}${path}`;
  };

  const getWsUrl = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (window.location.port === '5173') return `${protocol}//${window.location.hostname}:3010`;
    return `${protocol}//${window.location.host}`;
  };

  useEffect(() => {
    let reconnectTimer: number | undefined;

    const connect = () => {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'init') {
          setStatus(payload.data.status);
          setSettings(payload.data.settings);
          setConnections(payload.data.connections);
          setHistory(payload.data.history);
          if (payload.data.investigations) {
            setInvestigations(payload.data.investigations);
          }
          if (payload.data.stats) {
            setConnectionStats(payload.data.stats);
          }
          return;
        }
        if (payload.status) setStatus(payload.status);
        if (payload.connections) setConnections(payload.connections);
        if (payload.stats) setConnectionStats(payload.stats);
        if (payload.type === 'settings_update') setSettings(payload.settings);
        if (payload.type === 'investigation_update') {
          setInvestigations((prev) => ({ ...prev, [payload.investigation.ip]: payload.investigation }));
        }
        if (payload.type === 'route_update') {
          setRoutes((prev) => ({ ...prev, [payload.route.target]: payload.route }));
        }
        if (payload.type === 'history_cleared') setHistory([]);
      };
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 2500);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedId && connections[0]) setSelectedId(connections[0].id);
  }, [connections, selectedId]);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedId) || history.find((connection) => connection.id === selectedId) || null,
    [connections, history, selectedId]
  );

  // Kick off an investigation automatically when a public endpoint is selected,
  // so the panel fills in without needing the Investigate button.
  const autoInvestigated = useRef(new Set<string>());
  useEffect(() => {
    const ip = selectedConnection?.remoteAddress;
    if (!ip || isLocalAddress(ip)) return;
    if (investigations[ip] || autoInvestigated.current.has(ip)) return;
    autoInvestigated.current.add(ip);
    investigate(ip);
  }, [selectedConnection, investigations]);

  const processes = useMemo(
    () => Array.from(new Set(connections.map((connection) => connection.processName))).sort(),
    [connections]
  );

  const filteredConnections = useMemo(() => {
    const term = filter.toLowerCase().trim();
    return connections
      .filter((connection) => processFilter === 'all' || connection.processName === processFilter)
      .filter((connection) => {
        if (!term) return true;
        return [
          connection.remoteAddress,
          String(connection.remotePort),
          connection.localAddress,
          connection.processName,
          connection.interfaceAlias,
          connection.gateway
        ].some((value) => value.toLowerCase().includes(term));
      })
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
  }, [connections, filter, processFilter]);

  const stats = useMemo(() => {
    const publicCount = connections.filter((connection) => !isLocalAddress(connection.remoteAddress)).length;
    return {
      active: connections.length,
      publicCount,
      processes: processes.length,
      ipv6: connections.filter((connection) => connection.remoteAddress.includes(':')).length
    };
  }, [connections, processes.length]);

  const investigate = async (ip: string) => {
    setInvestigating((prev) => ({ ...prev, [ip]: true }));
    try {
      const response = await fetch(getApiUrl(`/api/investigate/${encodeURIComponent(ip)}`));
      const investigation = await response.json();
      if (!response.ok || !investigation.ip) {
        console.error('Investigation failed:', investigation.error || response.status);
        return;
      }
      setInvestigations((prev) => ({ ...prev, [investigation.ip]: investigation }));
    } catch (error) {
      console.error('Investigation failed:', error);
    } finally {
      setInvestigating((prev) => ({ ...prev, [ip]: false }));
    }
  };

  const trace = async (target: string) => {
    setTracing((prev) => ({ ...prev, [target]: true }));
    try {
      const response = await fetch(getApiUrl('/api/routes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target })
      });
      const route = await response.json();
      setRoutes((prev) => ({ ...prev, [route.target]: route }));

      // Investigate hops one at a time so the backend isn't flooded with
      // up to 20 concurrent RDAP/PowerShell lookups per trace
      if (route.hops) {
        for (const hop of route.hops) {
          if (hop.address && !investigations[hop.address]) {
            await investigate(hop.address);
          }
        }
      }
    } catch (error) {
      console.error('Trace failed:', error);
    } finally {
      setTracing((prev) => ({ ...prev, [target]: false }));
    }
  };

  const saveSettings = async (patch: Partial<Settings>) => {
    const response = await fetch(getApiUrl('/api/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    setSettings(await response.json());
  };

  const refreshHistory = async () => {
    const response = await fetch(getApiUrl('/api/history?limit=500'));
    setHistory(await response.json());
  };

  const clearHistory = async () => {
    await fetch(getApiUrl('/api/history/clear'), { method: 'POST' });
    setHistory([]);
  };

  const selectedInvestigation = selectedConnection ? investigations[selectedConnection.remoteAddress] : undefined;
  const selectedRoute = selectedConnection ? routes[selectedConnection.remoteAddress] : undefined;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">NetShield</p>
          <h1>Windows connection investigator</h1>
        </div>
        <div className="topbar__meta">
          <StatusPill status={status.collector} connected={wsConnected} />
          <span>{status.collectedAt ? formatTime(status.collectedAt) : 'Waiting for first sample'}</span>
        </div>
      </header>

      {status.lastError && <div className="error-strip">{status.lastError}</div>}

      <section className="stat-strip">
        <Metric label="Active TCP sessions" value={stats.active} />
        <Metric label="Public endpoints" value={stats.publicCount} />
        <Metric label="Processes" value={stats.processes} />
        <Metric label="IPv6 sessions" value={stats.ipv6} />
      </section>

      <section className="workspace">
        <ConnectionTable
          connections={filteredConnections}
          stats={connectionStats}
          selectedId={selectedId}
          filter={filter}
          processFilter={processFilter}
          processes={processes}
          onFilter={setFilter}
          onProcessFilter={setProcessFilter}
          onSelect={setSelectedId}
          onInvestigate={investigate}
        />

        <div className="right-rail">
          <WorldMap
            connections={filteredConnections}
            investigations={investigations}
            selected={selectedConnection}
            route={selectedRoute}
            onSelect={(connection) => setSelectedId(connection.id)}
          />
          <Inspector
            connection={selectedConnection}
            investigations={investigations}
            investigation={selectedInvestigation}
            route={selectedRoute}
            stats={selectedConnection ? connectionStats[selectedConnection.id] : undefined}
            investigating={selectedConnection ? !!investigating[selectedConnection.remoteAddress] : false}
            tracing={selectedConnection ? !!tracing[selectedConnection.remoteAddress] : false}
            onInvestigate={investigate}
            onTrace={trace}
          />
        </div>
      </section>

      <section className="lower-grid">
        <HistoryPanel history={history} onRefresh={refreshHistory} onClear={clearHistory} onSelect={setSelectedId} />
        <SettingsPanel settings={settings} status={status} onSave={saveSettings} />
      </section>
    </main>
  );
}

function StatusPill({ status, connected }: { status: CollectorStatus['collector']; connected: boolean }) {
  return (
    <div className={`status-pill status-pill--${status}`}>
      <span className="status-dot" />
      {status} {connected ? 'live' : 'reconnecting'}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function ConnectionTable(props: {
  connections: Connection[];
  stats: Record<string, ConnectionStats>;
  selectedId: string;
  filter: string;
  processFilter: string;
  processes: string[];
  onFilter: (value: string) => void;
  onProcessFilter: (value: string) => void;
  onSelect: (id: string) => void;
  onInvestigate: (ip: string) => void;
}) {
  return (
    <section className="panel connection-panel">
      <div className="panel__header">
        <div>
          <h2>Live TCP sessions</h2>
          <p>{props.connections.length} matching sessions</p>
        </div>
        <div className="toolbar">
          <input value={props.filter} onChange={(event) => props.onFilter(event.target.value)} placeholder="IP, port, process, adapter" />
          <select value={props.processFilter} onChange={(event) => props.onProcessFilter(event.target.value)}>
            <option value="all">All processes</option>
            {props.processes.map((process) => <option key={process} value={process}>{process}</option>)}
          </select>
        </div>
      </div>
      <div className="connection-table">
        <div className="connection-table__head">
          <span>Process</span>
          <span>Remote endpoint</span>
          <span>Local</span>
          <span>Route</span>
          <span>Transfer</span>
          <span>Seen</span>
        </div>
        <div className="connection-table__body">
          {props.connections.length === 0 && <div className="empty">No active TCP sessions match the current filters.</div>}
          {props.connections.map((connection) => {
            const s = props.stats[connection.id];
            return (
            <button
              key={connection.id}
              className={`connection-row ${props.selectedId === connection.id ? 'is-selected' : ''}`}
              onClick={() => props.onSelect(connection.id)}
              onDoubleClick={() => props.onInvestigate(connection.remoteAddress)}
            >
              <span>
                <strong>{connection.processName} <CopyButton text={connection.processName} /></strong>
                <small>PID {connection.pid}</small>
              </span>
              <span>
                <strong title={`${connection.remoteAddress}:${connection.remotePort}`}>{formatEndpoint(connection.remoteAddress, connection.remotePort)} <CopyButton text={`${connection.remoteAddress}:${connection.remotePort}`} /></strong>
                <small>{connection.state}</small>
              </span>
              <span title={`${connection.localAddress}:${connection.localPort}`}>{formatEndpoint(connection.localAddress, connection.localPort)}</span>
              <span>
                <strong>{connection.interfaceAlias || 'Unknown adapter'}</strong>
                <small>{connection.gateway || 'No gateway'}</small>
              </span>
              <span>
                <strong>{formatBytes(s?.bytesOut || 0)} <span style={{color:'var(--cyan)'}}>▲</span></strong>
                <small>{formatBytes(s?.bytesIn || 0)} <span style={{color:'var(--green)'}}>▼</span></small>
              </span>
              <span>{formatTime(connection.lastSeen)}</span>
            </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WorldMap(props: {
  connections: Connection[];
  investigations: Record<string, Investigation>;
  selected: Connection | null;
  route?: RouteTrace;
  onSelect: (connection: Connection) => void;
}) {
  const plotted = props.connections
    .map((connection) => ({ connection, investigation: props.investigations[connection.remoteAddress] }))
    .filter((item) => typeof item.investigation?.geo?.latitude === 'number' && typeof item.investigation?.geo?.longitude === 'number');
  const routePoints = (props.route?.hops || [])
    .map((hop) => props.investigations[hop.address])
    .filter((investigation) => typeof investigation?.geo?.latitude === 'number' && typeof investigation?.geo?.longitude === 'number');

  const getCoords = (lat: number, lng: number) => {
    const x = ((lng + 180) / 360) * 1000;
    const y = ((90 - lat) / 180) * 500;
    return { x, y };
  };

  const routePositions = routePoints.map(inv => getCoords(inv.geo.latitude!, inv.geo.longitude!));

  return (
    <section className="panel map-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel__header">
        <div>
          <h2>Endpoint map</h2>
          <p>{plotted.length} located endpoints</p>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: '300px', width: '100%', position: 'relative', zIndex: 0 }}>
        <WorldMapSvg>
          {routePositions.length > 1 && (
            <polyline 
              points={routePositions.map(p => `${p.x},${p.y}`).join(' ')} 
              fill="none"
              stroke="var(--green, #58d68d)" 
              strokeWidth="2" 
              strokeDasharray="5, 10" 
            />
          )}
          {routePoints.map((investigation, index) => {
            const { x, y } = getCoords(investigation.geo.latitude!, investigation.geo.longitude!);
            return (
              <circle
                key={`${investigation.ip}-${index}`}
                cx={x}
                cy={y}
                r={4}
                fill="var(--green, #58d68d)"
                opacity={0.8}
              />
            );
          })}
          {plotted.map(({ connection, investigation }) => {
            const isSelected = props.selected?.id === connection.id;
            const { x, y } = getCoords(investigation.geo.latitude!, investigation.geo.longitude!);
            return (
              <circle
                key={connection.id}
                cx={x}
                cy={y}
                r={isSelected ? 8 : 5}
                fill={isSelected ? 'var(--cyan, #41c7d7)' : 'var(--amber, #f0b451)'}
                opacity={isSelected ? 0.9 : 0.6}
                stroke={isSelected ? 'var(--cyan, #41c7d7)' : 'var(--amber, #f0b451)'}
                strokeWidth={isSelected ? 2 : 1}
                style={{ cursor: 'pointer', transition: 'all 0.2s ease-in-out' }}
                onClick={() => props.onSelect(connection)}
              >
                <title>{connection.remoteAddress}&#10;{investigation.geo.city ? `${investigation.geo.city}, ${investigation.geo.country}` : investigation.geo.country}</title>
              </circle>
            );
          })}
        </WorldMapSvg>
      </div>
      <div className="map-caption" style={{ marginTop: '10px' }}>
        Select a connection and run Investigate to locate it. Route hops appear after Trace route when location data is available.
      </div>
    </section>
  );
}

function Inspector(props: {
  connection: Connection | null;
  investigations: Record<string, Investigation>;
  investigation?: Investigation;
  route?: RouteTrace;
  stats?: ConnectionStats;
  investigating: boolean;
  tracing: boolean;
  onInvestigate: (ip: string) => void;
  onTrace: (target: string) => void;
}) {
  if (!props.connection) {
    return <section className="panel inspector"><div className="empty">Select a connection to inspect its process, route, and ownership.</div></section>;
  }

  const connection = props.connection;
  const investigation = props.investigation;
  const service = serviceName(connection.remotePort);

  return (
    <section className="panel inspector">
      <div className="panel__header">
        <div>
          <h2>{connection.remoteAddress} <CopyButton text={connection.remoteAddress} /></h2>
          <p>{connection.processName} <CopyButton text={connection.processName} /> on port {connection.remotePort}{service ? ` (${service})` : ''}</p>
        </div>
        <div className="button-row">
          <button onClick={() => props.onInvestigate(connection.remoteAddress)} disabled={props.investigating}>
            {props.investigating ? 'Investigating…' : 'Investigate'}
          </button>
          <button onClick={() => props.onTrace(connection.remoteAddress)} disabled={props.tracing}>
            {props.tracing ? 'Tracing…' : 'Trace route'}
          </button>
        </div>
      </div>
      <div className="detail-grid">
        <Detail label="Process" value={`${connection.processName} (PID ${connection.pid})`} />
        <Detail label="Executable" value={connection.processPath || 'Unavailable'} />
        <Detail label="Local socket" value={`${connection.localAddress}:${connection.localPort}`} />
        <Detail label="Gateway" value={connection.gateway || 'Unavailable'} />
        <Detail label="Adapter" value={connection.interfaceAlias || 'Unavailable'} />
        <Detail label="First seen" value={formatDate(connection.firstSeen)} />
      </div>
      {(props.stats && props.stats.domains.length > 0) && (
        <div className="investigation-block" style={{ paddingBottom: 0, borderBottom: 'none' }}>
          <Detail label="Captured Domains (SNI / DNS)" value={props.stats.domains.join(', ')} />
        </div>
      )}
      <div className="investigation-block">
        <h3>Investigation</h3>
        {!investigation && props.investigating && <p className="muted">Looking up ownership, DNS, and location…</p>}
        {!investigation && !props.investigating && <p className="muted">No lookup has been run for this endpoint yet.</p>}
        {investigation?.privateAddress && <p className="muted">Private or reserved address — no public registry data to look up.</p>}
        {investigation && !investigation.privateAddress && (
          <>
            <Detail label="Reverse DNS" value={(investigation.ptr || []).join(', ') || 'No PTR record'} />
            <Detail label="Network owner" value={ownerName(investigation) || 'Unavailable'} />
            {investigation.owner?.isp && investigation.owner.isp !== ownerName(investigation) && (
              <Detail label="ISP" value={investigation.owner.isp} />
            )}
            <Detail label="ASN" value={formatAsn(investigation) || 'Unavailable'} />
            <Detail label="Location" value={investigation.geo?.city ? `${investigation.geo.city}, ${investigation.geo.country}` : (investigation.geo?.country || 'Unavailable')} />
            {(investigation.dnsCacheHints || []).length > 0 && (
              <div className="dns-hints">
                {investigation.dnsCacheHints.map((hint, index) => (
                  <span key={`${hint.Entry || hint.Name}-${index}`}>{hint.Entry || hint.Name}</span>
                ))}
              </div>
            )}
            {investigation.owner?.error && !ownerName(investigation) && (
              <p className="lookup-error">
                Lookups failed ({investigation.owner.error}).{' '}
                <button className="link-btn" onClick={() => props.onInvestigate(connection.remoteAddress)} disabled={props.investigating}>Retry</button>
              </p>
            )}
          </>
        )}
      </div>
      <RouteView route={props.route} investigations={props.investigations} />
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!value || value === 'Unavailable') return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isCopyable = value && value !== 'Unavailable';

  return (
    <div 
      className={`detail ${isCopyable ? 'detail--copyable' : ''}`} 
      onClick={handleCopy} 
      title={isCopyable ? 'Click to copy' : ''}
    >
      <span>{label}</span>
      <strong title={value}>{value} {copied && <span className="copy-feedback">Copied!</span>}</strong>
    </div>
  );
}

function RouteView({ route, investigations }: { route?: RouteTrace, investigations?: Record<string, Investigation> }) {
  return (
    <div className="route-view">
      <h3>Route</h3>
      {!route && <p className="muted">Run Trace route to map the network path from this PC.</p>}
      {route?.error && <p className="muted">{route.error}</p>}
      {route?.hops.map((hop) => {
        const inv = investigations ? investigations[hop.address] : undefined;
        const geoText = inv?.geo?.city ? `${inv.geo.city}, ${inv.geo.country}` : (inv?.geo?.country || '');
        const ptrText = inv?.ptr?.[0] || '';
        return (
          <div className="hop" key={hop.hop}>
            <span>{hop.hop}</span>
            <div>
              <strong>{hop.address || 'Timed out'}</strong>
              {geoText && <small className="hop-geo" style={{ display: 'block', color: 'var(--muted)' }}>{geoText}</small>}
              {ptrText && <small className="hop-ptr" style={{ display: 'block', color: 'var(--faint)' }}>{ptrText}</small>}
            </div>
            <small>{hop.latenciesMs.length ? `${Math.min(...hop.latenciesMs)}-${Math.max(...hop.latenciesMs)} ms` : '*'}</small>
          </div>
        );
      })}
    </div>
  );
}

function HistoryPanel(props: { history: Connection[]; onRefresh: () => void; onClear: () => void; onSelect: (id: string) => void }) {
  return (
    <section className="panel history-panel">
      <div className="panel__header">
        <div>
          <h2>Rolling history</h2>
          <p>{props.history.length} recent connection records</p>
        </div>
        <div className="button-row">
          <button onClick={props.onRefresh}>Refresh</button>
          <button onClick={props.onClear}>Clear</button>
        </div>
      </div>
      <div className="history-list">
        {props.history.slice(0, 80).map((connection) => (
          <button key={`${connection.id}-${connection.lastSeen}`} onClick={() => props.onSelect(connection.id)}>
            <span>{connection.processName}</span>
            <strong>{connection.remoteAddress}:{connection.remotePort}</strong>
            <small>{connection.status} at {formatTime(connection.lastSeen)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function SettingsPanel(props: { settings: Settings; status: CollectorStatus; onSave: (patch: Partial<Settings>) => void }) {
  const [draft, setDraft] = useState<Settings>(props.settings);

  useEffect(() => setDraft(props.settings), [props.settings]);

  return (
    <section className="panel settings-panel">
      <div className="panel__header">
        <div>
          <h2>Capture settings</h2>
          <p>Windows APIs, no packet driver required</p>
        </div>
        <button onClick={() => props.onSave(draft)}>Save settings</button>
      </div>
      <label>
        Adapter
        <select value={draft.selectedAdapter} onChange={(event) => setDraft({ ...draft, selectedAdapter: event.target.value })}>
          <option value="">All adapters</option>
          {props.status.adapters.map((adapter) => (
            <option key={adapter.interfaceAlias} value={adapter.interfaceAlias}>{adapter.interfaceAlias}</option>
          ))}
        </select>
      </label>
      <label>
        Poll interval
        <input type="number" min="1000" max="30000" step="500" value={draft.pollIntervalMs} onChange={(event) => setDraft({ ...draft, pollIntervalMs: Number(event.target.value) })} />
      </label>
      <label>
        Retention days
        <input type="number" min="1" max="90" value={draft.historyRetentionDays} onChange={(event) => setDraft({ ...draft, historyRetentionDays: Number(event.target.value) })} />
      </label>
      <label>
        GeoIP database path
        <input value={draft.geoIpDatabasePath} onChange={(event) => setDraft({ ...draft, geoIpDatabasePath: event.target.value })} placeholder="Optional .mmdb path" />
      </label>
      <label className="check-row">
        <input type="checkbox" checked={draft.optionalApisEnabled} onChange={(event) => setDraft({ ...draft, optionalApisEnabled: event.target.checked })} />
        Enable optional online reputation APIs
      </label>
      <div className="default-routes">
        {props.status.routes.map((route) => (
          <span key={`${route.destinationPrefix}-${route.gateway}`}>{route.destinationPrefix} via {route.gateway || 'on-link'}</span>
        ))}
      </div>
    </section>
  );
}



function ownerName(investigation: Investigation) {
  if (investigation.owner?.name) return investigation.owner.name;
  // Older cached records predate the owner block; fall back to raw RDAP fields
  if (investigation.rdap && !investigation.rdap.error) {
    return investigation.rdap.name || investigation.rdap.handle || '';
  }
  return '';
}

function formatAsn(investigation: Investigation) {
  const asn = investigation.owner?.asn || investigation.rdap?.asn || '';
  const asname = investigation.owner?.asname || '';
  if (!asn) return '';
  return asname ? `${asn} · ${asname}` : asn;
}

const WELL_KNOWN_PORTS: Record<number, string> = {
  20: 'FTP data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 123: 'NTP', 143: 'IMAP', 161: 'SNMP', 194: 'IRC',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP submission', 853: 'DNS over TLS',
  993: 'IMAPS', 995: 'POP3S', 1194: 'OpenVPN', 1433: 'MSSQL', 3306: 'MySQL',
  3389: 'RDP', 3478: 'STUN/TURN', 4500: 'IPsec NAT-T', 5060: 'SIP', 5222: 'XMPP',
  5223: 'Push notifications', 5228: 'Google services', 5432: 'PostgreSQL',
  6379: 'Redis', 8080: 'HTTP alt', 8443: 'HTTPS alt', 27017: 'MongoDB', 51820: 'WireGuard'
};

function serviceName(port: number) {
  return WELL_KNOWN_PORTS[port] || '';
}

function isLocalAddress(address: string) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.|169\.254\.|fe80:|fc|fd|::1)/i.test(address);
}

function formatEndpoint(address: string, port: number) {
  let displayAddress = address;
  if (address.includes(':')) {
    if (address.length > 20) {
      const first = address.substring(0, 9);
      const last = address.substring(address.length - 4);
      displayAddress = `${first}…${last}`;
    }
    return `[${displayAddress}]:${port}`;
  }
  return `${displayAddress}:${port}`;
}

function formatTime(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text || text === 'Unavailable') return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!text || text === 'Unavailable') return null;

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export default App;
