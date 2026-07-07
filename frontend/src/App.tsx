import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRouteReport } from './exportRouteReport';
import {
  EMPTY_ROUTER,
  EMPTY_SETTINGS,
  EMPTY_STATUS,
  type CollectorStatus,
  type Connection,
  type ConnectionStats,
  type Investigation,
  type MetricFilter,
  type RouterState,
  type RouteTrace,
  type SavedReport,
  type Settings,
  type SidebarPanelId,
  type SortKey
} from './types';
import { formatTime, isLocalAddress } from './lib/format';
import { Metric, SidebarButton, StatusPill } from './components/widgets';
import { ConnectionTable } from './components/ConnectionTable';
import { WorldMap } from './components/WorldMap';
import { Inspector } from './components/Inspector';
import { HistoryPanel } from './components/HistoryPanel';
import { DevicesPanel } from './components/DevicesPanel';
import { ReportsPanel } from './components/ReportsPanel';
import { ReportViewer } from './components/ReportViewer';
import { SettingsPanel } from './components/SettingsPanel';
import './App.css';

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
  const [sortKey, setSortKey] = useState<SortKey>('lastSeen');
  const [sortAsc, setSortAsc] = useState(false);
  const [metricFilter, setMetricFilter] = useState<MetricFilter>('all');
  const [router, setRouter] = useState<RouterState>(EMPTY_ROUTER);
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanelId | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const toggleSidebarPanel = (panel: SidebarPanelId) => {
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

  const handleSort = (key: SortKey) => {
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
          investigations={investigations}
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
            reputationEnabled={settings.optionalApisEnabled}
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

export default App;
