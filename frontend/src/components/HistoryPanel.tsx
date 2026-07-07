import type { Connection } from '../types';
import { formatTime } from '../lib/format';

export function HistoryPanel(props: { history: Connection[]; onRefresh: () => void; onClear: () => void; onSelect: (id: string) => void }) {
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
