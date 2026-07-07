import { useEffect, useState } from 'react';
import type { CollectorStatus, Settings } from '../types';

export function SettingsPanel(props: { settings: Settings; status: CollectorStatus; onSave: (patch: Partial<Settings>) => void }) {
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
