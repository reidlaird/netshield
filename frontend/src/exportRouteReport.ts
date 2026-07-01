// Builds a self-contained HTML trace report and triggers a download.
// The report embeds the hop + investigation data as JSON and renders its own
// Leaflet map (loaded from CDN), so the saved file works standalone — each
// hop is clickable to inspect ownership, DNS, and location details.

type ReportInvestigation = {
  ip: string;
  checkedAt?: string;
  privateAddress?: boolean;
  ptr?: string[];
  rdap?: null | {
    handle?: string;
    name?: string;
    country?: string;
    asn?: string;
    links?: string[];
    error?: string;
  };
  owner?: null | { name?: string; isp?: string; asn?: string; asname?: string; error?: string };
  geo?: {
    countryCode?: string;
    country?: string;
    city?: string;
    latitude: number | null;
    longitude: number | null;
    source?: string;
  };
};

type ReportRoute = {
  target: string;
  checkedAt: string;
  hops: Array<{ hop: number; address: string; latenciesMs: number[]; timedOut: boolean }>;
  error?: string;
};

type ReportConnection = {
  remoteAddress: string;
  remotePort: number;
  processName: string;
  pid: number;
} | null;

export function exportRouteReport(
  route: ReportRoute,
  investigations: Record<string, ReportInvestigation>,
  connection: ReportConnection
) {
  const hopData = route.hops.map((hop) => {
    const inv = hop.address ? investigations[hop.address] : undefined;
    return {
      hop: hop.hop,
      address: hop.address,
      timedOut: hop.timedOut || !hop.address,
      latenciesMs: hop.latenciesMs,
      ptr: inv?.ptr || [],
      owner: inv?.owner?.name || inv?.rdap?.name || inv?.rdap?.handle || '',
      isp: inv?.owner?.isp || '',
      asn: inv?.owner?.asn || inv?.rdap?.asn || '',
      asname: inv?.owner?.asname || '',
      privateAddress: !!inv?.privateAddress,
      city: inv?.geo?.city || '',
      country: inv?.geo?.country || '',
      latitude: inv?.geo?.latitude ?? null,
      longitude: inv?.geo?.longitude ?? null,
      geoSource: inv?.geo?.source || '',
      rdapLinks: inv?.rdap?.links || [],
    };
  });

  const payload = {
    target: route.target,
    checkedAt: route.checkedAt,
    generatedAt: new Date().toISOString(),
    connection: connection
      ? {
          remoteAddress: connection.remoteAddress,
          remotePort: connection.remotePort,
          processName: connection.processName,
          pid: connection.pid,
        }
      : null,
    hops: hopData,
  };

  const html = buildReportHtml(payload);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  anchor.href = url;
  anchor.download = `netshield-trace-${route.target.replace(/[^a-zA-Z0-9.-]/g, '_')}-${stamp}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildReportHtml(payload: unknown) {
  // <-escape so hop data (PTR names etc.) can never close the script tag
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NetShield trace report</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<style>
  :root {
    --bg: #091014; --surface: #101a20; --surface-2: #16242c;
    --line: #263942; --line-bright: #3c5660;
    --text: #edf7f8; --muted: #91a6ad; --faint: #657980;
    --cyan: #41c7d7; --amber: #f0b451; --red: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; color: var(--text);
    background: radial-gradient(circle at top left, rgba(65,199,215,0.08), transparent 34%), var(--bg);
    font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px;
  }
  header { padding: 18px 24px 10px; }
  header .eyebrow { margin: 0; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--cyan); }
  header h1 { margin: 2px 0 4px; font-size: 20px; }
  header p { margin: 0; color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: 340px 1fr; gap: 14px; padding: 12px 24px 24px; height: calc(100vh - 90px); min-height: 480px; }
  .hops { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow-y: auto; }
  .hops h2 { margin: 0; padding: 12px 14px 8px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .hop {
    display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: center;
    width: 100%; text-align: left; padding: 9px 14px; border: none; border-top: 1px solid var(--line);
    background: none; color: var(--text); cursor: pointer; font: inherit;
  }
  .hop:hover { background: var(--surface-2); }
  .hop.is-selected { background: var(--surface-2); box-shadow: inset 3px 0 0 var(--cyan); }
  .hop--timeout { opacity: 0.55; cursor: default; }
  .hop .badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--cyan);
    background: rgba(9,16,20,0.9); font-size: 11px; font-weight: 700;
  }
  .hop strong { display: block; font-size: 13px; font-family: 'Consolas', monospace; }
  .hop small { display: block; color: var(--muted); font-size: 11px; }
  .hop .latency { color: var(--faint); font-size: 11px; white-space: nowrap; }
  .map-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  #map { flex: 1; border: 1px solid var(--line); border-radius: 10px; min-height: 260px; background: var(--surface); }
  .detail-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-height: 150px; }
  .detail-panel h2 { margin: 0 0 2px; font-size: 16px; font-family: 'Consolas', monospace; }
  .detail-panel .sub { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 18px; }
  .detail-grid > div span { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); }
  .detail-grid > div strong { font-size: 13px; font-weight: 500; word-break: break-all; }
  .detail-grid a { color: var(--cyan); }
  .muted { color: var(--muted); }
  .leaflet-container { background: #0b151a; font: inherit; }
  .leaflet-tooltip { background: var(--surface-2); border: 1px solid var(--line-bright); color: var(--text); }
  .hop-badge-wrap { background: none; border: none; }
  .hop-badge {
    display: flex; align-items: center; justify-content: center; width: 20px; height: 20px;
    border-radius: 50%; border: 2px solid; background: rgba(9,16,20,0.92);
    font-size: 10px; font-weight: 700; cursor: pointer;
  }
  @media (max-width: 860px) { .layout { grid-template-columns: 1fr; height: auto; } .hops { max-height: 300px; } }
</style>
</head>
<body>
<header>
  <p class="eyebrow">NetShield</p>
  <h1 id="title">Trace route report</h1>
  <p id="subtitle"></p>
</header>
<div class="layout">
  <nav class="hops"><h2>Hops</h2><div id="hop-list"></div></nav>
  <div class="map-side">
    <div id="map"></div>
    <section class="detail-panel" id="detail">
      <p class="muted">Click a hop in the list or on the map to inspect it.</p>
    </section>
  </div>
</div>
<script id="trace-data" type="application/json">${json}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('trace-data').textContent);
  var LOCAL = [65, 199, 215], REMOTE = [240, 180, 81];

  document.getElementById('title').textContent = 'Trace to ' + data.target;
  var subtitleParts = ['Traced ' + new Date(data.checkedAt).toLocaleString()];
  if (data.connection) {
    subtitleParts.push(data.connection.processName + ' (PID ' + data.connection.pid + ') port ' + data.connection.remotePort);
  }
  subtitleParts.push(data.hops.length + ' hops');
  document.getElementById('subtitle').textContent = subtitleParts.join(' · ');

  var located = data.hops.filter(function (h) {
    return typeof h.latitude === 'number' && typeof h.longitude === 'number';
  });
  var maxIndex = Math.max(located.length - 1, 1);

  function segmentColor(t) {
    var mix = LOCAL.map(function (c, i) { return Math.round(c + (REMOTE[i] - c) * t); });
    return 'rgb(' + mix.join(', ') + ')';
  }
  function latencyText(hop) {
    if (!hop.latenciesMs || !hop.latenciesMs.length) return '*';
    var lo = Math.min.apply(null, hop.latenciesMs), hi = Math.max.apply(null, hop.latenciesMs);
    return lo === hi ? lo + ' ms' : lo + '\\u2013' + hi + ' ms';
  }
  function geoText(hop) {
    if (hop.city && hop.country) return hop.city + ', ' + hop.country;
    return hop.country || '';
  }

  var map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 19 }).setView([25, 10], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  for (var i = 1; i < located.length; i++) {
    L.polyline(
      [[located[i - 1].latitude, located[i - 1].longitude], [located[i].latitude, located[i].longitude]],
      { color: segmentColor((i - 0.5) / maxIndex), weight: 2.5, dashArray: '6 10', opacity: 0.9 }
    ).addTo(map);
  }

  var markers = {};
  located.forEach(function (hop, index) {
    var color = segmentColor(index / maxIndex);
    var icon = L.divIcon({
      className: 'hop-badge-wrap',
      html: '<span class="hop-badge" style="border-color:' + color + ';color:' + color + '">' + hop.hop + '</span>',
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
    var marker = L.marker([hop.latitude, hop.longitude], { icon: icon }).addTo(map);
    marker.bindTooltip('Hop ' + hop.hop + ' \\u00b7 ' + hop.address, { direction: 'top', offset: [0, -10] });
    marker.on('click', function () { selectHop(hop.hop); });
    markers[hop.hop] = marker;
  });

  if (located.length >= 2) {
    map.fitBounds(located.map(function (h) { return [h.latitude, h.longitude]; }), { padding: [40, 40], maxZoom: 8 });
  } else if (located.length === 1) {
    map.setView([located[0].latitude, located[0].longitude], 5);
  }

  var listEl = document.getElementById('hop-list');
  data.hops.forEach(function (hop) {
    var locIdx = located.indexOf(hop);
    var color = locIdx >= 0 ? segmentColor(locIdx / maxIndex) : 'var(--faint)';
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'hop' + (hop.timedOut ? ' hop--timeout' : '');
    row.dataset.hop = hop.hop;

    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.borderColor = color;
    badge.style.color = color;
    badge.textContent = hop.hop;

    var body = document.createElement('span');
    var addr = document.createElement('strong');
    addr.textContent = hop.address || 'Timed out';
    body.appendChild(addr);
    var geo = geoText(hop);
    var subText = [geo, hop.ptr && hop.ptr[0]].filter(Boolean).join(' \\u00b7 ');
    if (subText) {
      var sub = document.createElement('small');
      sub.textContent = subText;
      body.appendChild(sub);
    }

    var latency = document.createElement('span');
    latency.className = 'latency';
    latency.textContent = latencyText(hop);

    row.appendChild(badge);
    row.appendChild(body);
    row.appendChild(latency);
    if (!hop.timedOut) row.addEventListener('click', function () { selectHop(hop.hop); });
    listEl.appendChild(row);
  });

  function detailRow(label, value, isLink) {
    if (!value) return '';
    var safe = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    var body = isLink ? '<a href="' + safe + '" target="_blank" rel="noopener">' + safe + '</a>' : safe;
    return '<div><span>' + label + '</span><strong>' + body + '</strong></div>';
  }

  function selectHop(hopNumber) {
    var hop = data.hops.find(function (h) { return h.hop === hopNumber; });
    if (!hop) return;

    Array.prototype.forEach.call(listEl.children, function (row) {
      row.classList.toggle('is-selected', Number(row.dataset.hop) === hopNumber);
    });

    if (typeof hop.latitude === 'number' && typeof hop.longitude === 'number') {
      map.flyTo([hop.latitude, hop.longitude], Math.max(map.getZoom(), 6), { duration: 0.8 });
      if (markers[hop.hop]) markers[hop.hop].openTooltip();
    }

    var position = hop === data.hops[0] ? 'Closest to this PC'
      : hop === data.hops[data.hops.length - 1] ? 'Remote endpoint'
      : (data.hops.length - hop.hop) + ' hops from the endpoint';

    var html = '<h2>Hop ' + hop.hop + ' \\u00b7 ' + (hop.address || 'Timed out') + '</h2>'
      + '<p class="sub">' + position + '</p>'
      + '<div class="detail-grid">'
      + detailRow('Latency', latencyText(hop) === '*' ? 'No reply' : latencyText(hop))
      + detailRow('Reverse DNS', (hop.ptr || []).join(', '))
      + detailRow('Network owner', hop.owner)
      + (hop.isp && hop.isp !== hop.owner ? detailRow('ISP', hop.isp) : '')
      + detailRow('ASN', hop.asn ? (hop.asname ? hop.asn + ' \\u00b7 ' + hop.asname : hop.asn) : '')
      + detailRow('Location', geoText(hop))
      + (hop.geoSource ? detailRow('Geo source', hop.geoSource) : '')
      + (hop.privateAddress ? detailRow('Address type', 'Private / reserved \\u2014 no public registry data') : '')
      + (hop.rdapLinks || []).map(function (link) { return detailRow('Registry (RDAP)', link, true); }).join('')
      + '</div>';
    document.getElementById('detail').innerHTML = html;
  }

  var firstUseful = data.hops.find(function (h) { return !h.timedOut; });
  if (firstUseful) selectHop(firstUseful.hop);
})();
</script>
</body>
</html>`;
}
