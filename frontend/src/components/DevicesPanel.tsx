import { useMemo, useState } from 'react';
import type { RouterState } from '../types';
import { bandClass, deviceLabel, formatTime, lastOctet, signalBars } from '../lib/format';
import { CopyButton } from './CopyButton';

export function DevicesPanel({ router }: { router: RouterState }) {
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
