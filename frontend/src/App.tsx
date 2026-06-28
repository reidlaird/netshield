import { useEffect, useMemo, useRef, useState } from 'react';
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
  geo: {
    countryCode: string;
    country: string;
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
          return;
        }
        if (payload.status) setStatus(payload.status);
        if (payload.connections) setConnections(payload.connections);
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
    const response = await fetch(getApiUrl(`/api/investigate/${encodeURIComponent(ip)}`));
    const investigation = await response.json();
    setInvestigations((prev) => ({ ...prev, [investigation.ip]: investigation }));
  };

  const trace = async (target: string) => {
    const response = await fetch(getApiUrl('/api/routes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    const route = await response.json();
    setRoutes((prev) => ({ ...prev, [route.target]: route }));
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
            connections={connections}
            investigations={investigations}
            selected={selectedConnection}
            route={selectedRoute}
            onSelect={(connection) => setSelectedId(connection.id)}
          />
          <Inspector
            connection={selectedConnection}
            investigation={selectedInvestigation}
            route={selectedRoute}
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
          <span>Seen</span>
        </div>
        <div className="connection-table__body">
          {props.connections.length === 0 && <div className="empty">No active TCP sessions match the current filters.</div>}
          {props.connections.map((connection) => (
            <button
              key={connection.id}
              className={`connection-row ${props.selectedId === connection.id ? 'is-selected' : ''}`}
              onClick={() => props.onSelect(connection.id)}
              onDoubleClick={() => props.onInvestigate(connection.remoteAddress)}
            >
              <span>
                <strong>{connection.processName}</strong>
                <small>PID {connection.pid}</small>
              </span>
              <span>
                <strong>{connection.remoteAddress}:{connection.remotePort}</strong>
                <small>{connection.state}</small>
              </span>
              <span>{connection.localAddress}:{connection.localPort}</span>
              <span>
                <strong>{connection.interfaceAlias || 'Unknown adapter'}</strong>
                <small>{connection.gateway || 'No gateway'}</small>
              </span>
              <span>{formatTime(connection.lastSeen)}</span>
            </button>
          ))}
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
    .filter((item) => typeof item.investigation?.geo.latitude === 'number' && typeof item.investigation?.geo.longitude === 'number');
  const routePoints = (props.route?.hops || [])
    .map((hop) => props.investigations[hop.address])
    .filter((investigation) => typeof investigation?.geo.latitude === 'number' && typeof investigation?.geo.longitude === 'number');

  return (
    <section className="panel map-panel">
      <div className="panel__header">
        <div>
          <h2>Endpoint map</h2>
          <p>{plotted.length} located endpoints</p>
        </div>
      </div>
      <svg viewBox="0 0 1000 500" role="img" aria-label="World endpoint map" className="world-map">
        <rect width="1000" height="500" rx="16" />
        <path d="M151 129 205 92 285 103 322 142 295 191 218 206 145 180Z" />
        <path d="M236 221 305 225 334 294 305 395 248 363 214 286Z" />
        <path d="M447 118 515 95 604 120 626 183 580 220 494 205 433 170Z" />
        <path d="M520 216 603 220 642 300 607 398 535 376 497 294Z" />
        <path d="M646 119 806 98 892 155 857 246 745 254 659 201Z" />
        <path d="M781 315 866 332 898 392 845 423 774 392Z" />
        <path d="M428 403 501 414 527 447 470 464 407 446Z" />
        {routePoints.map((investigation, index) => {
          const point = project(investigation.geo.latitude || 0, investigation.geo.longitude || 0);
          return <circle key={`${investigation.ip}-${index}`} className="route-point" cx={point.x} cy={point.y} r="5" />;
        })}
        {plotted.map(({ connection, investigation }) => {
          const point = project(investigation.geo.latitude || 0, investigation.geo.longitude || 0);
          const selected = props.selected?.id === connection.id;
          return (
            <g key={connection.id} className={selected ? 'map-point is-selected' : 'map-point'} onClick={() => props.onSelect(connection)}>
              <circle cx={point.x} cy={point.y} r={selected ? 9 : 6} />
              <title>{connection.remoteAddress} - {investigation.geo.country}</title>
            </g>
          );
        })}
      </svg>
      <div className="map-caption">
        Select a connection and run Investigate to locate it. Route hops appear after Trace route when location data is available.
      </div>
    </section>
  );
}

function Inspector(props: {
  connection: Connection | null;
  investigation?: Investigation;
  route?: RouteTrace;
  onInvestigate: (ip: string) => void;
  onTrace: (target: string) => void;
}) {
  if (!props.connection) {
    return <section className="panel inspector"><div className="empty">Select a connection to inspect its process, route, and ownership.</div></section>;
  }

  const connection = props.connection;
  const investigation = props.investigation;

  return (
    <section className="panel inspector">
      <div className="panel__header">
        <div>
          <h2>{connection.remoteAddress}</h2>
          <p>{connection.processName} on port {connection.remotePort}</p>
        </div>
        <div className="button-row">
          <button onClick={() => props.onInvestigate(connection.remoteAddress)}>Investigate</button>
          <button onClick={() => props.onTrace(connection.remoteAddress)}>Trace route</button>
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
      <div className="investigation-block">
        <h3>Investigation</h3>
        {!investigation && <p className="muted">No lookup has been run for this endpoint yet.</p>}
        {investigation && (
          <>
            <Detail label="Reverse DNS" value={investigation.ptr.join(', ') || 'No PTR record'} />
            <Detail label="Network owner" value={investigation.rdap?.name || investigation.rdap?.handle || investigation.rdap?.error || 'Unavailable'} />
            <Detail label="ASN" value={investigation.rdap?.asn || 'Unavailable'} />
            <Detail label="Location" value={investigation.geo.country || investigation.geo.source} />
            {investigation.dnsCacheHints.length > 0 && (
              <div className="dns-hints">
                {investigation.dnsCacheHints.map((hint, index) => (
                  <span key={`${hint.Entry || hint.Name}-${index}`}>{hint.Entry || hint.Name}</span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <RouteView route={props.route} />
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function RouteView({ route }: { route?: RouteTrace }) {
  return (
    <div className="route-view">
      <h3>Route</h3>
      {!route && <p className="muted">Run Trace route to map the network path from this PC.</p>}
      {route?.error && <p className="muted">{route.error}</p>}
      {route?.hops.map((hop) => (
        <div className="hop" key={hop.hop}>
          <span>{hop.hop}</span>
          <strong>{hop.address || 'Timed out'}</strong>
          <small>{hop.latenciesMs.length ? `${Math.min(...hop.latenciesMs)}-${Math.max(...hop.latenciesMs)} ms` : '*'}</small>
        </div>
      ))}
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

function project(latitude: number, longitude: number) {
  return {
    x: ((longitude + 180) / 360) * 1000,
    y: ((90 - latitude) / 180) * 500
  };
}

function isLocalAddress(address: string) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.|169\.254\.|fe80:|fc|fd|::1)/i.test(address);
}

function formatTime(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDate(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

export default App;
