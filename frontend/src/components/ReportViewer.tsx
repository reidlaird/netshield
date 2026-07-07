import { useEffect, useState } from 'react';
import type { SavedReport } from '../types';
import { formatBytes, formatDate } from '../lib/format';

export function ReportViewer(props: {
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
