import crypto from 'node:crypto';
import { enrichDevices } from './deviceNames.js';

// Telus Wi-Fi Hub (Arcadyan PRV65B444A) integration.
//
// The gateway has no local API — we drive the same admin web UI a browser does.
// The auth and data-access scheme is deliberately obfuscated; the flow below was
// reverse-engineered from the portal's own JavaScript (js/global.js):
//
//  1. Login: the form does not send a password. It sends
//       usr = ArcMD5(username), pws = ArcMD5(password)
//     where ArcMD5(s) = SHA512_HEX( MD5_HEX(s) ) (do_encode(..., true) -> ArcMD5).
//     It also sends `httoken`, a per-page anti-CSRF token (see readToken). POST
//     to /login.cgi; on success the gateway sets a SID cookie and 302s to
//     index.htm (failure 302s back to login.htm with no cookie).
//
//  2. Anti-CSRF token (httoken): every page embeds a 1x1 data: GIF whose base64
//     payload, *after the 78-char GIF prefix*, decodes to a blob where bytes
//     48.. are the token (bytes 0-31 / 32-47 are an AES key/IV used by other
//     fields we don't need). This is what URLToken() appends as `_tn` and what
//     addToken() posts as `httoken`.
//
//  3. Data: pages pull their data from /cgi/cgi_<name>.js?_tn=<token>&_t=<ms>.
//     The connected-device list lives in cgi/cgi_clients.js as `dhcp_client`
//     (and `dhcp_lease`); richer per-WiFi-client info is in
//     cgi/cgi_toplogy_info.js as `station_info` / `toplogy_info`.
//
// Caveat: the gateway allows a single admin session, so we reuse the SID cookie
// and only re-login when a request bounces to the login page. Poll gently.

const ROUTER_URL = (process.env.ROUTER_URL || 'http://192.168.1.254').replace(/\/+$/, '');
const ROUTER_USER = process.env.ROUTER_USER || '';
const ROUTER_PASS = process.env.ROUTER_PASS || '';
const REQUEST_TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS || 10000);

// Offsets from the reverse-engineered _t() token function (js/global.js). The
// GIF prefix ("data:image/gif;base64," + a 56-char 1x1 GIF) is 78 chars; the
// decoded payload holds the token from byte 48 onward.
const DATA_URI_PREFIX_LEN = 78;
const TOKEN_OFFSET = 48;

// ArcMD5(s) = SHA512_HEX( MD5_HEX(s) )
const arcMd5 = (value) => {
  const md5hex = crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
  return crypto.createHash('sha512').update(md5hex, 'utf8').digest('hex');
};

let sessionCookie = '';

export function isRouterConfigured() {
  return Boolean(ROUTER_USER && ROUTER_PASS);
}

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${ROUTER_URL}/${pathname.replace(/^\/+/, '')}`, {
      redirect: 'manual',
      signal: controller.signal,
      ...options,
      headers: {
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

// Extract the anti-CSRF token from a page's embedded data: GIF.
function readToken(html) {
  const img = [...html.matchAll(/src="?(data:[^"\s>]+)"?/g)]
    .map((m) => m[1])
    .find((s) => s.length > DATA_URI_PREFIX_LEN + TOKEN_OFFSET);
  if (!img) return '';
  const decoded = Buffer.from(img.slice(DATA_URI_PREFIX_LEN), 'base64').toString('latin1');
  return decoded.slice(TOKEN_OFFSET);
}

async function login() {
  if (!isRouterConfigured()) {
    throw new Error('Router credentials not set (ROUTER_USER / ROUTER_PASS)');
  }
  const loginPage = await (await request('login.htm')).text();
  const httoken = readToken(loginPage);
  const body = new URLSearchParams({
    usr: arcMd5(ROUTER_USER),
    pws: arcMd5(ROUTER_PASS),
    httoken,
    language_flag: '1',
    menupage: ''
  });
  const res = await request('login.cgi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  const sid = cookies.find((c) => c.startsWith('SID='));
  const location = res.headers.get('location') || '';
  if (!sid || /login/i.test(location)) {
    throw new Error(`Router login failed (status ${res.status}${location ? `, -> ${location}` : ''})`);
  }
  sessionCookie = sid;
  return sid;
}

// Fetch an authenticated page's text, logging in / re-logging in as needed.
async function fetchAuthed(pathname, extraHeaders = {}) {
  if (!sessionCookie) await login();
  let res = await request(pathname, { headers: extraHeaders });
  if (res.status === 302 && /login/i.test(res.headers.get('location') || '')) {
    sessionCookie = '';
    await login();
    res = await request(pathname, { headers: extraHeaders });
  }
  if (res.status !== 200) throw new Error(`Router ${pathname} returned status ${res.status}`);
  return res.text();
}

// Fetch a /cgi/cgi_<name>.js data blob, supplying the current session token.
async function fetchCgi(name, token) {
  const url = `cgi/cgi_${name}.js?_tn=${encodeURIComponent(token)}&_t=${Date.now()}`;
  return fetchAuthed(url, { Referer: `${ROUTER_URL}/clients.htm` });
}

const normalizeMac = (mac) => String(mac || '').toUpperCase();

// The gateway reports placeholder strings for clients it couldn't name.
const JUNK_HOSTNAMES = new Set(['', '(null)', 'null', 'unknown', 'undefined', '*', '--']);
export function cleanHostname(name) {
  const trimmed = String(name || '').trim();
  return JUNK_HOSTNAMES.has(trimmed.toLowerCase()) ? '' : trimmed;
}

// Parse the flat `var dhcp_client=[ 'name','ip','mac','','LAN', ... ];` array
// (groups of 5: hostname, ip, mac, spare, interface). Falls back to the
// `dhcp_lease` array (groups of 4: hostname, ip, mac, lease-remaining).
export function parseClients(js) {
  const client = matchArray(js, 'dhcp_client');
  if (client.length) return chunk(client, 5).map(([hostname, ip, mac, , iface]) => ({
    hostname: cleanHostname(hostname), ip: ip || '', mac: normalizeMac(mac), iface: iface || ''
  })).filter((d) => d.mac);

  const lease = matchArray(js, 'dhcp_lease');
  return chunk(lease, 4).map(([hostname, ip, mac]) => ({
    hostname: cleanHostname(hostname), ip: ip || '', mac: normalizeMac(mac), iface: ''
  })).filter((d) => d.mac);
}

// Parse cgi_toplogy_info.js: `station_info` (per-WiFi-client details keyed by
// MAC) and the gateway `toplogy_info` node.
export function parseTopology(js) {
  const stations = {};
  const stationObj = matchJson(js, 'station_info');
  for (const s of (stationObj?.stations || [])) {
    stations[normalizeMac(s.station_mac)] = {
      connectionType: s.connect_type || '',
      signal: s.signal_strength || '',
      linkRate: s.link_rate || '',
      online: s.online === '1',
      name: s.station_name && s.station_name !== 'NULL' ? cleanHostname(s.station_name) : ''
    };
  }
  const gwNode = matchJson(js, 'toplogy_info')?.nodes?.[0];
  const gateway = gwNode ? {
    model: gwNode.model_name || '',
    productId: gwNode.product_id || '',
    firmware: gwNode.fw_ver || '',
    ip: gwNode.device_ip || '',
    serial: gwNode.sn || ''
  } : null;
  return { stations, gateway };
}

// Merge the DHCP client list with per-station wireless info into one inventory.
function mergeDevices(clients, stations) {
  return clients.map((c) => {
    const st = stations[c.mac];
    return {
      mac: c.mac,
      ip: c.ip,
      hostname: c.hostname || st?.name || '',
      // Wired clients report their interface (e.g. "LAN"); WiFi clients get the
      // band from station_info (e.g. "2.4G" / "5G").
      connectionType: st?.connectionType || c.iface || '',
      signal: st?.signal || '',
      linkRate: st?.linkRate || '',
      online: st ? st.online : true
    };
  });
}

export async function collectRouterDevices() {
  if (!isRouterConfigured()) {
    return { configured: false, collectedAt: new Date().toISOString(), devices: [], byIp: {}, gateway: null, error: '' };
  }
  try {
    if (!sessionCookie) await login();
    // Any authenticated page carries the current session token; clients.htm is
    // the natural one and sets a matching Referer for the CGI requests.
    const token = readToken(await fetchAuthed('clients.htm'));
    const clients = parseClients(await fetchCgi('clients', token));

    let stations = {};
    let gateway = null;
    try {
      const topo = parseTopology(await fetchCgi('toplogy_info', token));
      stations = topo.stations;
      gateway = topo.gateway;
    } catch {
      // Topology/station enrichment is optional — keep the DHCP inventory even
      // if this secondary CGI fails.
    }

    // Fill in names the router couldn't provide (reverse DNS, MAC vendor).
    const devices = await enrichDevices(mergeDevices(clients, stations));
    const byIp = {};
    for (const d of devices) {
      if (d.ip) byIp[d.ip] = d.hostname || (d.vendor ? `${d.vendor} device` : d.mac);
    }
    return { configured: true, collectedAt: new Date().toISOString(), devices, byIp, gateway, error: '' };
  } catch (error) {
    return { configured: true, collectedAt: new Date().toISOString(), devices: [], byIp: {}, gateway: null, error: error.message };
  }
}

// --- small parsing helpers -------------------------------------------------

// Pull a flat JS array literal `var <name>=[ ... ];` and return its quoted
// string tokens (single- or double-quoted, empties preserved) in order.
function matchArray(js, name) {
  const m = js.match(new RegExp(`\\b${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((t) => (t[1] !== undefined ? t[1] : t[2]));
}

// Pull a JS object literal `var <name>={ ... };` and JSON.parse it.
function matchJson(js, name) {
  const m = js.match(new RegExp(`\\b${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i + size <= arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
