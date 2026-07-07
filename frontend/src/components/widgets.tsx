// Small presentational atoms for the app chrome: sidebar nav buttons, the
// collector status pill, and the clickable stat-strip metric cards.
import type { CollectorStatus } from '../types';

export function SidebarButton({
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

export function StatusPill({ status, connected }: { status: CollectorStatus['collector']; connected: boolean }) {
  return (
    <div className={`status-pill status-pill--${status}`}>
      <span className="status-dot" />
      {status} {connected ? 'live' : 'reconnecting'}
    </div>
  );
}

export function Metric({
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
