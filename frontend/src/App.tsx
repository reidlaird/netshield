import { useEffect, useMemo, useRef, useState } from 'react';
import { EndpointMap } from './EndpointMap';
import { buildRouteReport } from './exportRouteReport';
import './App.css';

type CollectorStatus = {
  collector: 'starting' | 'running' | 'error';
  lastError: string;
  collectedAt: string;
  adapters: Adapter[];
  routes: DefaultRoute[];
  sniffer?: { state: 'stopped' | 'running' | 'error'; detail: string };
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
  deviceName?: string;
};

type RouterDevice = {
  mac: string;
  ip: string;
  hostname: string;
  vendor?: string;
  randomizedMac?: boolean;
  connectionType: string;
  signal: string;
  linkRate: string;
  online: boolean;
};

type RouterGateway = {
  model: string;
  productId: string;
  firmware: string;
  ip: string;
  serial: string;
};

type RouterState = {
  configured: boolean;
  collectedAt: string;
  devices: RouterDevice[];
  gateway: RouterGateway | null;
  error: string;
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
  bytesInRate?: number;
  bytesOutRate?: number;
  domains: string[];
};

type SavedReport = {
  id: string;
  filename: string;
  target: string;
  generatedAt: string;
  hopCount: number;
  processName: string;
  sizeBytes: number;
};

const EMPTY_STATUS: CollectorStatus = {
  collector: 'starting',
  lastError: '',
  collectedAt: '',
  adapters: [],
  routes: []
};

const EMPTY_ROUTER: RouterState = {
  configured: false,
  collectedAt: '',
  devices: [],
  gateway: null,
  error: ''
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
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [savingReport, setSavingReport] = useState(false);
  const [viewingReport, setViewingReport] = useState<SavedReport | null>(null);
  const [sortKey, setSortKey] = useState<'processName' | 'remote' | 'local' | 'interfaceAlias' | 'transfer' | 'lastSeen'>('lastSeen');
  const [sortAsc, setSortAsc] = useState(false);
  const [metricFilter, setMetricFilter] = useState<'all' | 'public' | 'processes' | 'ipv6'>('all');
  const [router, setRouter] = useState<RouterState>(EMPTY_ROUTER);
  const [sidebarPanel, setSidebarPanel] = useState<'history' | 'reports' | 'settings' | 'devices' | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const toggleSidebarPanel = (panel: 'history' | 'reports' | 'settings' | 'devices') => {
    setSidebarPanel((prev) => (prev === panel ? null : panel));
  };

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
          if (payload.data.reports) {
            setReports(payload.data.reports);
          }
          if (payload.data.router) {
            setRouter(payload.data.router);
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
        if (payload.type === 'reports_update') setReports(payload.reports);
        if (payload.type === 'router_devices') setRouter(payload.router);
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

  const handleSort = (key: typeof sortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(key === 'processName' || key === 'remote' || key === 'local' || key === 'interfaceAlias');
    }
  };

  const filteredConnections = useMemo(() => {
    const term = filter.toLowerCase().trim();
    let result = connections;

    // Apply process filter
    if (processFilter !== 'all') {
      result = result.filter((connection) => connection.processName === processFilter);
    }

    // Apply metric filter
    if (metricFilter === 'public') {
      result = result.filter((connection) => !isLocalAddress(connection.remoteAddress));
    } else if (metricFilter === 'ipv6') {
      result = result.filter((connection) => connection.remoteAddress.includes(':'));
    } else if (metricFilter === 'processes') {
      const seenProcesses = new Set<string>();
      result = result.filter((connection) => {
        if (seenProcesses.has(connection.processName)) {
          return false;
        }
        seenProcesses.add(connection.processName);
        return true;
      });
    }

    // Apply text filter
    if (term) {
      result = result.filter((connection) => {
        return [
          connection.remoteAddress,
          String(connection.remotePort),
          connection.localAddress,
          connection.processName,
          connection.interfaceAlias,
          connection.gateway
        ].some((value) => value.toLowerCase().includes(term));
      });
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortKey) {
        case 'processName':
          comparison = a.processName.localeCompare(b.processName);
          break;
        case 'remote':
          comparison = a.remoteAddress.localeCompare(b.remoteAddress);
          if (comparison === 0) {
            comparison = a.remotePort - b.remotePort;
          }
          break;
        case 'local':
          comparison = a.localAddress.localeCompare(b.localAddress);
          if (comparison === 0) {
            comparison = a.localPort - b.localPort;
          }
          break;
        case 'interfaceAlias':
          comparison = (a.interfaceAlias || '').localeCompare(b.interfaceAlias || '');
          break;
        case 'transfer': {
          const statsA = connectionStats[a.id];
          const statsB = connectionStats[b.id];
          const totalA = (statsA?.bytesOut || 0) + (statsA?.bytesIn || 0);
          const totalB = (statsB?.bytesOut || 0) + (statsB?.bytesIn || 0);
          comparison = totalA - totalB;
          break;
        }
        case 'lastSeen':
        default:
          comparison = new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime();
          break;
      }
      return sortAsc ? comparison : -comparison;
    });

    return result;
  }, [connections, filter, processFilter, metricFilter, sortKey, sortAsc, connectionStats]);

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

  const saveReport = async (route: RouteTrace, connection: Connection) => {
    setSavingReport(true);
    try {
      const report = buildRouteReport(route, investigations, connection);
      const response = await fetch(getApiUrl('/api/reports'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      const meta = await response.json();
      if (!response.ok) {
        console.error('Saving report failed:', meta.error || response.status);
        return;
      }
      setReports((prev) => [meta, ...prev.filter((r) => r.id !== meta.id)]);
    } catch (error) {
      console.error('Saving report failed:', error);
    } finally {
      setSavingReport(false);
    }
  };

  const deleteReport = async (id: string) => {
    try {
      await fetch(getApiUrl(`/api/reports/${encodeURIComponent(id)}`), { method: 'DELETE' });
      setReports((prev) => prev.filter((r) => r.id !== id));
      setViewingReport((prev) => (prev?.id === id ? null : prev));
    } catch (error) {
      console.error('Deleting report failed:', error);
    }
  };

  const openReport = (id: string) => {
    window.open(getApiUrl(`/api/reports/${encodeURIComponent(id)}`), '_blank', 'noopener');
  };

  const downloadReport = (id: string) => {
    const anchor = document.createElement('a');
    anchor.href = getApiUrl(`/api/reports/${encodeURIComponent(id)}/download`);
    anchor.download = `${id}.html`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const selectedInvestigation = selectedConnection ? investigations[selectedConnection.remoteAddress] : undefined;
  const selectedRoute = selectedConnection ? routes[selectedConnection.remoteAddress] : undefined;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <nav className="sidebar__nav">
          <SidebarButton
            icon="🕘"
            label="History"
            count={history.length}
            isActive={sidebarPanel === 'history'}
            onClick={() => toggleSidebarPanel('history')}
          />
          <SidebarButton
            icon="📄"
            label="Reports"
            count={reports.length}
            isActive={sidebarPanel === 'reports'}
            onClick={() => toggleSidebarPanel('reports')}
          />
          {router.configured && (
            <SidebarButton
              icon="📶"
              label="Devices"
              count={router.devices.length}
              isActive={sidebarPanel === 'devices'}
              onClick={() => toggleSidebarPanel('devices')}
            />
          )}
          <SidebarButton
            icon="⚙️"
            label="Settings"
            isActive={sidebarPanel === 'settings'}
            onClick={() => toggleSidebarPanel('settings')}
          />
        </nav>
        {sidebarPanel && (
          <div className="sidebar__drawer">
            {sidebarPanel === 'history' && (
              <HistoryPanel history={history} onRefresh={refreshHistory} onClear={clearHistory} onSelect={setSelectedId} />
            )}
            {sidebarPanel === 'reports' && (
              <ReportsPanel
                reports={reports}
                onView={setViewingReport}
                onOpen={openReport}
                onDownload={downloadReport}
                onDelete={deleteReport}
              />
            )}
            {sidebarPanel === 'devices' && (
              <DevicesPanel router={router} />
            )}
            {sidebarPanel === 'settings' && (
              <SettingsPanel settings={settings} status={status} onSave={saveSettings} />
            )}
          </div>
        )}
      </aside>

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
      {status.sniffer?.state === 'error' && (
        <div className="error-strip error-strip--warning">
          Traffic capture unavailable — byte counters will stay at 0. {status.sniffer.detail}
        </div>
      )}

      <section className="stat-strip">
        <Metric
          label="Active TCP sessions"
          value={stats.active}
          isActive={metricFilter === 'all'}
          onClick={() => setMetricFilter('all')}
        />
        <Metric
          label="Public endpoints"
          value={stats.publicCount}
          isActive={metricFilter === 'public'}
          onClick={() => setMetricFilter('public')}
        />
        <Metric
          label="Processes"
          value={stats.processes}
          isActive={metricFilter === 'processes'}
          onClick={() => setMetricFilter('processes')}
        />
        <Metric
          label="IPv6 sessions"
          value={stats.ipv6}
          isActive={metricFilter === 'ipv6'}
          onClick={() => setMetricFilter('ipv6')}
        />
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
          sortKey={sortKey}
          sortAsc={sortAsc}
          onSort={handleSort}
          metricFilter={metricFilter}
          onClearMetricFilter={() => setMetricFilter('all')}
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
            savingReport={savingReport}
            onInvestigate={investigate}
            onTrace={trace}
            onSaveReport={saveReport}
          />
        </div>
      </section>

      {viewingReport && (
        <ReportViewer
          report={viewingReport}
          src={getApiUrl(`/api/reports/${encodeURIComponent(viewingReport.id)}`)}
          onOpen={openReport}
          onDownload={downloadReport}
          onDelete={deleteReport}
          onClose={() => setViewingReport(null)}
        />
      )}
      </main>
    </div>
  );
}

function SidebarButton({
  icon,
  label,
  count,
  isActive,
  onClick
}: {
  icon: string;
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__btn ${isActive ? 'is-active' : ''}`}
      onClick={onClick}
      title={`${label}${isActive ? ' (click to collapse)' : ''}`}
    >
      <span className="sidebar__btn-icon">{icon}</span>
      <span className="sidebar__btn-label">{label}</span>
      {typeof count === 'number' && count > 0 && <span className="sidebar__btn-count">{count > 99 ? '99+' : count}</span>}
    </button>
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

function Metric({
  label,
  value,
  isActive,
  onClick
}: {
  label: string;
  value: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`metric-card ${isActive ? 'is-active' : ''}`}
      onClick={onClick}
    >
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value.toLocaleString()}</strong>
    </button>
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
  sortKey: 'processName' | 'remote' | 'local' | 'interfaceAlias' | 'transfer' | 'lastSeen';
  sortAsc: boolean;
  onSort: (key: 'processName' | 'remote' | 'local' | 'interfaceAlias' | 'transfer' | 'lastSeen') => void;
  metricFilter: 'all' | 'public' | 'processes' | 'ipv6';
  onClearMetricFilter: () => void;
}) {
  const [groupByProcess, setGroupByProcess] = useState(false);
  const [expandedProcesses, setExpandedProcesses] = useState<Record<string, boolean>>({});

  const toggleProcess = (name: string) => {
    setExpandedProcesses(prev => ({
      ...prev,
      [name]: !prev[name]
    }));
  };

  const groupedConnections = useMemo(() => {
    const map: Record<string, Connection[]> = {};
    for (const c of props.connections) {
      if (!map[c.processName]) map[c.processName] = [];
      map[c.processName].push(c);
    }
    return map;
  }, [props.connections]);

  return (
    <section className="panel connection-panel">
      <div className="panel__header">
        <div>
          <h2>Live TCP sessions</h2>
          <p>
            {props.connections.length} matching sessions
            {props.metricFilter !== 'all' && (
              <span className="active-filter-badge">
                {props.metricFilter === 'public' ? 'Public' : props.metricFilter === 'ipv6' ? 'IPv6' : 'Processes (Grouped)'}
                <button
                  type="button"
                  className="clear-filter-inline"
                  onClick={props.onClearMetricFilter}
                  title="Clear metric filter"
                >
                  ×
                </button>
              </span>
            )}
          </p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className={`toggle-group-btn ${groupByProcess ? 'is-active' : ''}`}
            onClick={() => setGroupByProcess(!groupByProcess)}
            title="Group connections by process"
          >
            {groupByProcess ? '📂 Grouped' : '🗂️ Group by Process'}
          </button>
          <input value={props.filter} onChange={(event) => props.onFilter(event.target.value)} placeholder="IP, port, process, adapter" />
          <select value={props.processFilter} onChange={(event) => props.onProcessFilter(event.target.value)}>
            <option value="all">All processes</option>
            {props.processes.map((process) => <option key={process} value={process}>{process}</option>)}
          </select>
        </div>
      </div>
      <div className="connection-table">
        <div className="connection-table__head">
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'processName' ? 'is-active' : ''}`}
            onClick={() => props.onSort('processName')}
          >
            Process {props.sortKey === 'processName' && (props.sortAsc ? '▲' : '▼')}
          </button>
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'remote' ? 'is-active' : ''}`}
            onClick={() => props.onSort('remote')}
          >
            Remote endpoint {props.sortKey === 'remote' && (props.sortAsc ? '▲' : '▼')}
          </button>
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'local' ? 'is-active' : ''}`}
            onClick={() => props.onSort('local')}
          >
            Local {props.sortKey === 'local' && (props.sortAsc ? '▲' : '▼')}
          </button>
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'interfaceAlias' ? 'is-active' : ''}`}
            onClick={() => props.onSort('interfaceAlias')}
          >
            Route {props.sortKey === 'interfaceAlias' && (props.sortAsc ? '▲' : '▼')}
          </button>
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'transfer' ? 'is-active' : ''}`}
            onClick={() => props.onSort('transfer')}
          >
            Transfer {props.sortKey === 'transfer' && (props.sortAsc ? '▲' : '▼')}
          </button>
          <button
            type="button"
            className={`sort-header-btn ${props.sortKey === 'lastSeen' ? 'is-active' : ''}`}
            onClick={() => props.onSort('lastSeen')}
          >
            Seen {props.sortKey === 'lastSeen' && (props.sortAsc ? '▲' : '▼')}
          </button>
        </div>
        <div className="connection-table__body">
          {props.connections.length === 0 && <div className="empty">No active TCP sessions match the current filters.</div>}
          
          {groupByProcess ? (
            Object.entries(groupedConnections).map(([processName, conns]) => {
              const isExpanded = !!expandedProcesses[processName];
              
              // Calculate group aggregates
              const totalTx = conns.reduce((sum, c) => sum + (props.stats[c.id]?.bytesOut || 0), 0);
              const totalRx = conns.reduce((sum, c) => sum + (props.stats[c.id]?.bytesIn || 0), 0);
              const totalTxRate = conns.reduce((sum, c) => sum + (props.stats[c.id]?.bytesOutRate || 0), 0);
              const totalRxRate = conns.reduce((sum, c) => sum + (props.stats[c.id]?.bytesInRate || 0), 0);
              
              return (
                <div key={processName}>
                  <div className="process-group-header" onClick={() => toggleProcess(processName)}>
                    <span className="process-group-title">
                      <span className="chevron">{isExpanded ? '▼' : '▶'}</span>
                      <span className={`process-badge ${getProcessTypeClass(processName)}`}>
                        {processName}
                      </span>
                      <span className="process-group-count">{conns.length} {conns.length === 1 ? 'session' : 'sessions'}</span>
                    </span>
                    <span className="process-group-line" />
                    <span className="process-group-transfer">
                      <span>▲ {formatBytes(totalTx)}{totalTxRate >= 1 ? ` (${formatRate(totalTxRate)})` : ''}</span>
                      <span>▼ {formatBytes(totalRx)}{totalRxRate >= 1 ? ` (${formatRate(totalRxRate)})` : ''}</span>
                    </span>
                  </div>
                  
                  {isExpanded && (
                    <div className="process-group-children">
                      {conns.map((connection) => {
                        const s = props.stats[connection.id];
                        const alerts = getConnectionAlerts(connection);
                        return (
                          <button
                            key={connection.id}
                            type="button"
                            className={`connection-row ${props.selectedId === connection.id ? 'is-selected' : ''}`}
                            onClick={() => props.onSelect(connection.id)}
                            onDoubleClick={() => props.onInvestigate(connection.remoteAddress)}
                          >
                            <span>
                              <strong className="process-name-cell">
                                <span className={`process-badge ${getProcessTypeClass(connection.processName)}`}>
                                  {connection.processName}
                                </span>
                                <CopyButton text={connection.processName} />
                                {alerts.map(a => (
                                  <span key={a} className="anomaly-badge" title={`Alert: ${a}`}>⚠️ {a}</span>
                                ))}
                              </strong>
                              <small>PID {connection.pid}</small>
                            </span>
                            <span>
                              <strong title={`${connection.remoteAddress}:${connection.remotePort}`}>
                                {formatEndpoint(connection.remoteAddress, connection.remotePort)}{' '}
                                <CopyButton text={`${connection.remoteAddress}:${connection.remotePort}`} />
                              </strong>
                              <small className="state-cell">
                                <span className={`state-dot ${getStateBadgeClass(connection.state)}`} />
                                {connection.state}
                              </small>
                            </span>
                            <span title={`${connection.localAddress}:${connection.localPort}`}>
                              {formatEndpoint(connection.localAddress, connection.localPort)}
                            </span>
                            <span>
                              <strong>{connection.interfaceAlias || 'Unknown adapter'}</strong>
                              <small>{connection.gateway || 'No gateway'}</small>
                            </span>
                            <TransferCell stats={s} />
                            <span>{formatTime(connection.lastSeen)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            props.connections.map((connection) => {
              const s = props.stats[connection.id];
              const alerts = getConnectionAlerts(connection);
              return (
                <button
                  key={connection.id}
                  type="button"
                  className={`connection-row ${props.selectedId === connection.id ? 'is-selected' : ''}`}
                  onClick={() => props.onSelect(connection.id)}
                  onDoubleClick={() => props.onInvestigate(connection.remoteAddress)}
                >
                  <span>
                    <strong className="process-name-cell">
                      <span className={`process-badge ${getProcessTypeClass(connection.processName)}`}>
                        {connection.processName}
                      </span>
                      <CopyButton text={connection.processName} />
                      {alerts.map(a => (
                        <span key={a} className="anomaly-badge" title={`Alert: ${a}`}>⚠️ {a}</span>
                      ))}
                    </strong>
                    <small>PID {connection.pid}</small>
                  </span>
                  <span>
                    <strong title={`${connection.remoteAddress}:${connection.remotePort}`}>
                      {formatEndpoint(connection.remoteAddress, connection.remotePort)}{' '}
                      <CopyButton text={`${connection.remoteAddress}:${connection.remotePort}`} />
                      {connection.deviceName && <span className="device-tag" title="LAN device (from router)">{connection.deviceName}</span>}
                    </strong>
                    <small className="state-cell">
                      <span className={`state-dot ${getStateBadgeClass(connection.state)}`} />
                      {connection.state}
                    </small>
                  </span>
                  <span title={`${connection.localAddress}:${connection.localPort}`}>
                    {formatEndpoint(connection.localAddress, connection.localPort)}
                  </span>
                  <span>
                    <strong>{connection.interfaceAlias || 'Unknown adapter'}</strong>
                    <small>{connection.gateway || 'No gateway'}</small>
                  </span>
                  <TransferCell stats={s} />
                  <span>{formatTime(connection.lastSeen)}</span>
                </button>
              );
            })
          )}
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
    .map((hop) => ({ hop, investigation: props.investigations[hop.address] }))
    .filter((item) => typeof item.investigation?.geo?.latitude === 'number' && typeof item.investigation?.geo?.longitude === 'number');

  return (
    <section className="panel map-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel__header">
        <div>
          <h2>Endpoint map</h2>
          <p>{plotted.length} located endpoints</p>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: '300px', margin: '0 10px', borderRadius: '8px', overflow: 'hidden', position: 'relative', zIndex: 0 }}>
        <EndpointMap
          points={plotted.map(({ connection, investigation }) => ({
            id: connection.id,
            latitude: investigation.geo.latitude!,
            longitude: investigation.geo.longitude!,
            label: connection.remoteAddress,
            sublabel: investigation.geo.city ? `${investigation.geo.city}, ${investigation.geo.country}` : investigation.geo.country,
            selected: props.selected?.id === connection.id,
          }))}
          routePoints={routePoints.map(({ hop, investigation }) => ({
            hop: hop.hop,
            latitude: investigation.geo.latitude!,
            longitude: investigation.geo.longitude!,
            label: hop.address,
            sublabel: investigation.geo.city
              ? `${investigation.geo.city}, ${investigation.geo.country}`
              : investigation.geo.country,
            latency: hop.latenciesMs.length
              ? `${Math.min(...hop.latenciesMs)}–${Math.max(...hop.latenciesMs)} ms`
              : undefined,
          }))}
          onSelect={(id) => {
            const item = plotted.find((entry) => entry.connection.id === id);
            if (item) props.onSelect(item.connection);
          }}
        />
      </div>
      <div className="map-caption" style={{ marginTop: '10px' }}>
        Select a connection and run Investigate to locate it. After Trace route, numbered hops show the path — cyan is your side, amber is the remote endpoint, and the dashes flow in the direction of incoming traffic.
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
  savingReport: boolean;
  onInvestigate: (ip: string) => void;
  onTrace: (target: string) => void;
  onSaveReport: (route: RouteTrace, connection: Connection) => void;
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
          {props.route && props.route.hops.length > 0 && (
            <button
              onClick={() => props.onSaveReport(props.route!, connection)}
              disabled={props.savingReport}
              title="Save this trace to the report library as a standalone HTML report with an interactive map"
            >
              {props.savingReport ? 'Saving…' : 'Save report'}
            </button>
          )}
        </div>
      </div>
      <div className="detail-grid">
        <Detail label="Process" value={`${connection.processName} (PID ${connection.pid})`} />
        <Detail label="Executable" value={connection.processPath || 'Unavailable'} />
        <Detail label="Local socket" value={`${connection.localAddress}:${connection.localPort}`} />
        {connection.deviceName && <Detail label="LAN device" value={connection.deviceName} />}
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
          <div className={`hop ${hop.timedOut || !hop.address ? 'hop--timeout' : ''}`} key={hop.hop}>
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

function DevicesPanel({ router }: { router: RouterState }) {
  const [search, setSearch] = useState('');

  const devices = useMemo(() => {
    const term = search.toLowerCase().trim();
    const list = term
      ? router.devices.filter((d) =>
          [d.hostname, d.ip, d.mac, d.connectionType, d.vendor || ''].some((v) => v.toLowerCase().includes(term)))
      : router.devices;
    // Online first, then by IP's final octet so the list reads like the subnet.
    return [...list].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return lastOctet(a.ip) - lastOctet(b.ip);
    });
  }, [router.devices, search]);

  const onlineCount = router.devices.filter((d) => d.online).length;

  return (
    <section className="panel devices-panel">
      <div className="panel__header">
        <div>
          <h2>Network devices</h2>
          <p>
            {router.gateway?.model || 'Router'} · {onlineCount}/{router.devices.length} online
            {router.collectedAt && ` · ${formatTime(router.collectedAt)}`}
          </p>
        </div>
        {router.devices.length > 0 && (
          <input
            className="reports-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, IP, MAC…"
          />
        )}
      </div>
      <div className="devices-list">
        {router.error && <div className="empty">Couldn’t read the router: {router.error}</div>}
        {!router.error && router.devices.length === 0 && (
          <div className="empty">No devices reported yet — waiting for the first router poll.</div>
        )}
        {!router.error && router.devices.length > 0 && devices.length === 0 && (
          <div className="empty">No devices match “{search}”.</div>
        )}
        {devices.map((device) => {
          const label = deviceLabel(device);
          const tooltip = device.vendor && device.hostname ? `${label} · ${device.vendor}` : label;
          return (
            <div key={device.mac} className={`device-row ${device.online ? '' : 'is-offline'}`}>
              <span className="device-row__top">
                <span className={`device-dot ${device.online ? 'is-online' : ''}`} />
                <strong className={device.hostname ? '' : 'is-fallback'} title={tooltip}>{label}</strong>
                <CopyButton text={device.hostname || device.mac} />
                <span className={`device-band ${bandClass(device.connectionType)}`}>{device.connectionType || '—'}</span>
              </span>
              <span className="device-row__sub">
                <span className="device-row__addr">
                  <span title={device.ip}>{device.ip}</span>
                  <small title={device.mac}>{device.mac}{device.randomizedMac ? ' · private' : ''}</small>
                </span>
                {device.signal && (
                  <small className="device-row__signal" title={`${device.signal} dBm${device.linkRate ? ` · ${device.linkRate}` : ''}`}>
                    {signalBars(device.signal)} {device.signal} dBm
                  </small>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReportsPanel(props: {
  reports: SavedReport[];
  onView: (report: SavedReport) => void;
  onOpen: (id: string) => void;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState('');

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim();
    if (!term) return props.reports;
    return props.reports.filter((report) =>
      [report.target, report.processName, report.filename].some((value) => value.toLowerCase().includes(term))
    );
  }, [props.reports, search]);

  const handleDelete = (id: string) => {
    if (confirmingDelete === id) {
      setConfirmingDelete('');
      props.onDelete(id);
    } else {
      setConfirmingDelete(id);
    }
  };

  return (
    <section className="panel reports-panel">
      <div className="panel__header">
        <div>
          <h2>Trace reports</h2>
          <p>
            {props.reports.length} saved {props.reports.length === 1 ? 'report' : 'reports'}
            {search && ` · ${filtered.length} matching`}
          </p>
        </div>
        {props.reports.length > 0 && (
          <input
            className="reports-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Target, process…"
          />
        )}
      </div>
      <div className="reports-list">
        {props.reports.length === 0 && (
          <div className="empty">No saved reports yet. Trace a route, then use Save report to keep it here.</div>
        )}
        {props.reports.length > 0 && filtered.length === 0 && (
          <div className="empty">No reports match “{search}”.</div>
        )}
        {filtered.map((report) => (
          <div key={report.id} className="report-row">
            <button
              type="button"
              className="report-row__info"
              onClick={() => props.onView(report)}
              title="View this report in the dashboard"
            >
              <strong title={report.filename}>{report.target}</strong>
              <small>
                {[
                  report.processName,
                  `${report.hopCount} ${report.hopCount === 1 ? 'hop' : 'hops'}`,
                  formatDate(report.generatedAt),
                  formatBytes(report.sizeBytes)
                ].filter(Boolean).join(' · ')}
              </small>
            </button>
            <div className="report-row__actions">
              <button onClick={() => props.onView(report)} title="View the report inside the dashboard">View</button>
              <button onClick={() => props.onOpen(report.id)} title="Open the report in a new tab">↗</button>
              <button onClick={() => props.onDownload(report.id)} title="Download the report as an HTML file">⬇</button>
              <button
                className={`report-delete ${confirmingDelete === report.id ? 'is-confirming' : ''}`}
                onClick={() => handleDelete(report.id)}
                onBlur={() => setConfirmingDelete((prev) => (prev === report.id ? '' : prev))}
                title={confirmingDelete === report.id ? 'Click again to permanently delete' : 'Delete this report'}
              >
                {confirmingDelete === report.id ? 'Sure?' : '✕'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReportViewer(props: {
  report: SavedReport;
  src: string;
  onOpen: (id: string) => void;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const report = props.report;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  return (
    <div className="report-viewer__backdrop" onClick={props.onClose}>
      <div className="report-viewer" onClick={(event) => event.stopPropagation()}>
        <div className="report-viewer__header">
          <div className="report-viewer__title">
            <strong>{report.target}</strong>
            <small>
              {[
                report.processName,
                `${report.hopCount} ${report.hopCount === 1 ? 'hop' : 'hops'}`,
                formatDate(report.generatedAt),
                formatBytes(report.sizeBytes)
              ].filter(Boolean).join(' · ')}
            </small>
          </div>
          <div className="report-viewer__actions">
            <button onClick={() => props.onOpen(report.id)} title="Open in a new tab">Open in tab</button>
            <button onClick={() => props.onDownload(report.id)} title="Download as an HTML file">Download</button>
            <button
              className={`report-delete ${confirmingDelete ? 'is-confirming' : ''}`}
              onClick={() => (confirmingDelete ? props.onDelete(report.id) : setConfirmingDelete(true))}
              onBlur={() => setConfirmingDelete(false)}
              title={confirmingDelete ? 'Click again to permanently delete' : 'Delete this report'}
            >
              {confirmingDelete ? 'Delete forever?' : 'Delete'}
            </button>
            <button className="report-viewer__close" onClick={props.onClose} title="Close (Esc)">✕</button>
          </div>
        </div>
        <iframe className="report-viewer__frame" src={props.src} title={`Trace report for ${report.target}`} sandbox="allow-scripts allow-popups" />
      </div>
    </div>
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

function lastOctet(ip: string) {
  const n = Number(ip.split('.').pop());
  return Number.isFinite(n) ? n : 999;
}

// Best available name for a device: router/DNS hostname, then MAC vendor,
// then a hint that the MAC is randomized so no vendor exists to look up.
function deviceLabel(device: RouterDevice) {
  if (device.hostname) return device.hostname;
  if (device.vendor) return `${device.vendor} device`;
  if (device.randomizedMac) return 'Unnamed (private MAC)';
  return 'Unnamed device';
}

function bandClass(type: string) {
  const t = (type || '').toLowerCase();
  if (t.includes('5g')) return 'band-5g';
  if (t.includes('2.4') || t === '2.4g') return 'band-24g';
  if (t.includes('lan') || t.includes('eth')) return 'band-wired';
  return '';
}

// WiFi RSSI (dBm) -> a quick 4-bar strength glyph.
function signalBars(signal: string) {
  const dbm = Number(signal);
  if (!Number.isFinite(dbm)) return '';
  if (dbm >= -55) return '▂▄▆█';
  if (dbm >= -67) return '▂▄▆';
  if (dbm >= -78) return '▂▄';
  return '▂';
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

function getProcessTypeClass(name: string) {
  if (!name) return 'process-unknown';
  const lower = name.toLowerCase();
  if (lower === 'system' || lower === 'idle') return 'process-system';
  if (lower.includes('svchost') || lower === 'lsass.exe' || lower === 'services.exe') return 'process-service';
  return 'process-user';
}

function getStateBadgeClass(state: string) {
  if (!state) return '';
  const lower = state.toLowerCase();
  if (lower === 'established') return 'state-established';
  if (lower === 'listen' || lower === 'listening') return 'state-listening';
  if (lower.includes('wait')) return 'state-waiting';
  if (lower.includes('close') || lower.includes('time')) return 'state-closing';
  return 'state-other';
}

function formatRate(bytesPerSec: number) {
  return `${formatBytes(bytesPerSec)}/s`;
}

function TransferCell({ stats }: { stats?: ConnectionStats }) {
  const txRate = stats?.bytesOutRate || 0;
  const rxRate = stats?.bytesInRate || 0;
  const isLive = txRate >= 1 || rxRate >= 1;
  return (
    <span className={`transfer-cell ${isLive ? 'is-live' : ''}`}>
      <div className="transfer-cell__text">
        <span className="tx" title="Sent (Bytes Out)">
          <span className="arrow">▲</span> {formatBytes(stats?.bytesOut || 0)}
          {txRate >= 1 && <small className="transfer-rate">{formatRate(txRate)}</small>}
        </span>
        <span className="rx" title="Received (Bytes In)">
          <span className="arrow">▼</span> {formatBytes(stats?.bytesIn || 0)}
          {rxRate >= 1 && <small className="transfer-rate">{formatRate(rxRate)}</small>}
        </span>
      </div>
      <TrafficSparkline rate={(stats?.bytesOutRate || 0) + (stats?.bytesInRate || 0)} />
    </span>
  );
}

function TrafficSparkline({ rate }: { rate: number }) {
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    setHistory((prev) => {
      const next = [...prev, rate];
      if (next.length > 8) next.shift();
      return next;
    });
  }, [rate]);

  if (history.length < 2) {
    return <span className="sparkline-placeholder" />;
  }

  const max = Math.max(...history, 1);
  const width = 45;
  const height = 16;
  const points = history
    .map((val, idx) => {
      const x = (idx / (history.length - 1)) * width;
      const y = height - (val / max) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg className="sparkline" width={width} height={height} style={{ overflow: 'visible' }}>
      <polyline
        fill="none"
        stroke="var(--cyan)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function getConnectionAlerts(connection: Connection) {
  const alerts: string[] = [];
  const port = connection.remotePort;
  const isPublic = !isLocalAddress(connection.remoteAddress);

  if (port === 80 && isPublic) {
    const lowerProc = connection.processName.toLowerCase();
    if (
      lowerProc.includes('chrome') ||
      lowerProc.includes('brave') ||
      lowerProc.includes('msedge') ||
      lowerProc.includes('firefox') ||
      lowerProc.includes('claude')
    ) {
      alerts.push('HTTP');
    }
  }

  if ((port === 21 || port === 23 || port === 135 || port === 139 || port === 445) && isPublic) {
    alerts.push('Legacy');
  }

  return alerts;
}

export default App;
