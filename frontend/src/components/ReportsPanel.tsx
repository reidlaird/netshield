import { useMemo, useState } from 'react';
import type { SavedReport } from '../types';
import { formatBytes, formatDate } from '../lib/format';

export function ReportsPanel(props: {
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
