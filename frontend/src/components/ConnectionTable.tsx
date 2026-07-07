import { useEffect, useMemo, useState } from 'react';
import type { Connection, ConnectionStats, Investigation, MetricFilter, SortKey } from '../types';
import {
  formatBytes,
  formatEndpoint,
  formatRate,
  formatTime,
  getConnectionAlerts,
  getProcessTypeClass,
  getStateBadgeClass
} from '../lib/format';
import { CopyButton } from './CopyButton';

export function ConnectionTable(props: {
  connections: Connection[];
  stats: Record<string, ConnectionStats>;
  investigations: Record<string, Investigation>;
  selectedId: string;
  filter: string;
  processFilter: string;
  processes: string[];
  onFilter: (value: string) => void;
  onProcessFilter: (value: string) => void;
  onSelect: (id: string) => void;
  onInvestigate: (ip: string) => void;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  metricFilter: MetricFilter;
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
                        const alerts = getConnectionAlerts(connection, props.investigations[connection.remoteAddress]);
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
                                  <span key={a} className={a === 'Flagged' ? 'anomaly-badge anomaly-badge--danger' : 'anomaly-badge'} title={`Alert: ${a}`}>{a === 'Flagged' ? '🚩' : '⚠️'} {a}</span>
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
              const alerts = getConnectionAlerts(connection, props.investigations[connection.remoteAddress]);
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
                        <span key={a} className={a === 'Flagged' ? 'anomaly-badge anomaly-badge--danger' : 'anomaly-badge'} title={`Alert: ${a}`}>{a === 'Flagged' ? '🚩' : '⚠️'} {a}</span>
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
