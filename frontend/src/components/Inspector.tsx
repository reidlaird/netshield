import { useState } from 'react';
import type { Connection, ConnectionStats, Investigation, RouteTrace } from '../types';
import { formatAsn, formatDate, ownerName, reputationSummary, serviceName } from '../lib/format';
import { CopyButton } from './CopyButton';

export function Inspector(props: {
  connection: Connection | null;
  investigations: Record<string, Investigation>;
  investigation?: Investigation;
  route?: RouteTrace;
  stats?: ConnectionStats;
  investigating: boolean;
  tracing: boolean;
  savingReport: boolean;
  reputationEnabled: boolean;
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
          <h2>
            {connection.remoteAddress} <CopyButton text={connection.remoteAddress} />
            {investigation?.reputation?.flagged && (
              <span className="reputation-badge" title={reputationSummary(investigation)}>🚩 Flagged</span>
            )}
          </h2>
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
            {investigation.reputation && investigation.reputation.sources.length > 0 && (
              <Detail label="Reputation" value={reputationSummary(investigation)} />
            )}
            {investigation.reputation?.error && (
              <p className="lookup-error">Reputation lookup failed ({investigation.reputation.error}).</p>
            )}
            {props.reputationEnabled && !investigation.reputation && (
              <p className="muted">
                Reputation APIs are enabled but no result is available — add ABUSEIPDB_API_KEY or
                VIRUSTOTAL_API_KEY to backend/.env, then re-investigate.
              </p>
            )}
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
