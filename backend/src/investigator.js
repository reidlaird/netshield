import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPrivateOrReservedIP, normalizeAddress } from './connectionUtils.js';
import { isReputationConfigured, lookupReputation } from './reputation.js';
import geoip from 'geoip-lite';
const execFileAsync = promisify(execFile);



const pendingInvestigations = new Map();

export function investigateIp(ip, options = {}) {
  const address = normalizeAddress(ip);
  // Coalesce concurrent requests for the same IP (trace hops, auto-investigate bursts)
  const pending = pendingInvestigations.get(address);
  if (pending) return pending;

  const promise = doInvestigate(address, options)
    .finally(() => pendingInvestigations.delete(address));
  pendingInvestigations.set(address, promise);
  return promise;
}

async function doInvestigate(address, options = {}) {
  const checkedAt = new Date().toISOString();
  const privateAddress = isPrivateOrReservedIP(address);
  const wantReputation = Boolean(options.reputationEnabled) && !privateAddress && isReputationConfigured();
  const cached = options.store?.readInvestigation(address);

  if (cached && !isStale(cached.checkedAt, options.maxCacheAgeMs ?? 1000 * 60 * 60 * 24)) {
    // Re-investigate records cached before geo/owner support existed, and
    // records whose lookups all failed (timeouts, 429 rate limits) so they heal.
    const healthy = cached.privateAddress || (cached.owner && !cached.owner.error && cached.owner.name);
    // Records cached before reputation was enabled (or whose reputation
    // lookup failed outright) heal the same way owner records do.
    const reputationOk = !wantReputation || (cached.reputation && !cached.reputation.error);
    if (cached.geo && healthy && reputationOk) {
      return { ...cached, fromCache: true };
    }
  }

  const [ptr, dnsCacheHints, rdap, ipApi, reputation] = await Promise.all([
    resolvePtr(address),
    resolveDnsCacheHints(address),
    privateAddress ? Promise.resolve(null) : lookupRdap(address),
    privateAddress ? Promise.resolve(null) : lookupIpApi(address),
    wantReputation ? lookupReputation(address) : Promise.resolve(cached?.reputation ?? null)
  ]);

  // ip-api gives city-level results with good IPv6 coverage; geoip-lite is the
  // offline fallback and often only resolves IPv6 to a country centroid.
  const geoLookup = geoip.lookup(address);
  let geo;
  if (ipApi && typeof ipApi.lat === 'number' && typeof ipApi.lon === 'number') {
    geo = {
      countryCode: ipApi.countryCode || '',
      country: ipApi.country || ipApi.countryCode || '',
      city: [ipApi.city, ipApi.regionName].filter(Boolean).join(', '),
      latitude: ipApi.lat,
      longitude: ipApi.lon,
      source: 'ip-api'
    };
  } else if (geoLookup?.ll) {
    geo = {
      countryCode: geoLookup.country || '',
      country: geoLookup.country || '',
      city: geoLookup.city || '',
      latitude: geoLookup.ll[0],
      longitude: geoLookup.ll[1],
      source: 'geoip-lite'
    };
  } else {
    const countryCode = rdap?.countryCode || '';
    geo = { countryCode, country: countryCode, city: '', latitude: null, longitude: null, source: privateAddress ? 'private' : 'unlocated' };
  }

  const owner = privateAddress ? null : {
    name: (rdap && !rdap.error && (rdap.name || rdap.handle)) || ipApi?.org || ipApi?.isp || '',
    isp: ipApi?.isp || '',
    asn: parseAsNumber(ipApi?.as) || rdap?.asn || '',
    asname: ipApi?.asname || '',
    error: (rdap?.error && ipApi?.error) ? `${rdap.error}; ${ipApi.error}` : ''
  };

  const result = {
    ip: address,
    checkedAt,
    privateAddress,
    ptr: (ptr && ptr.length) ? ptr : (ipApi?.reverse ? [ipApi.reverse] : []),
    dnsCacheHints,
    rdap,
    owner,
    geo,
    reputation
  };

  options.store?.cacheInvestigation(address, result);
  return result;
}

export async function traceRoute(target, options = {}) {
  const normalizedTarget = normalizeAddress(target);
  const cached = options.store?.readRoute(normalizedTarget);
  if (cached && !isStale(cached.checkedAt, options.maxCacheAgeMs ?? 1000 * 60 * 15)) {
    return { ...cached, fromCache: true };
  }

  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync(
      'tracert.exe',
      ['-d', '-h', '20', '-w', '750', normalizedTarget],
      // Worst case: 20 hops x 3 probes x 750ms plus resolution overhead
      { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }
    );
    const result = {
      target: normalizedTarget,
      checkedAt,
      hops: parseTracert(stdout),
      raw: stdout
    };
    options.store?.cacheRoute(normalizedTarget, result);
    return result;
  } catch (error) {
    const result = {
      target: normalizedTarget,
      checkedAt,
      hops: parseTracert(error.stdout || ''),
      error: error.message,
      raw: error.stdout || error.stderr || ''
    };
    options.store?.cacheRoute(normalizedTarget, result);
    return result;
  }
}

export function parseTracert(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const ipMatch = match[2].match(/((?:\d{1,3}\.){3}\d{1,3}|(?:[a-fA-F0-9]{0,4}:){2,}[a-fA-F0-9:%]+)/);
      const latencyMatches = Array.from(match[2].matchAll(/(<\s*)?(\d+)\s*ms/g)).map((latency) => Number(latency[2]));
      return {
        hop: Number(match[1]),
        address: ipMatch ? normalizeAddress(ipMatch[1]) : '',
        latenciesMs: latencyMatches,
        timedOut: match[2].includes('*')
      };
    })
    .filter(Boolean);
}

async function resolvePtr(ip) {
  try {
    return await dns.reverse(ip);
  } catch {
    return [];
  }
}

async function resolveDnsCacheHints(ip) {
  if (net.isIP(ip) !== 4 && net.isIP(ip) !== 6) return [];
  const escaped = ip.replace(/'/g, "''");
  const script = `Get-DnsClientCache | Where-Object { $_.Data -eq '${escaped}' } | Select-Object -First 10 Entry,Name,Type,Data | ConvertTo-Json -Depth 4 -Compress`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 3500, maxBuffer: 1024 * 1024 }
    );
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// rdap.org rate-limits aggressive clients, so space requests out and never
// run more than one at a time (trace routes can queue up ~20 lookups at once).
const RDAP_SPACING_MS = 300;
let rdapChain = Promise.resolve();

function lookupRdap(ip) {
  const run = rdapChain.then(() => fetchRdap(ip));
  rdapChain = run.catch(() => {}).then(() => sleep(RDAP_SPACING_MS));
  return run;
}

async function fetchRdap(ip, attempt = 0) {
  try {
    // Do not use encodeURIComponent, RDAP expects raw colons for IPv6
    const response = await fetch(`https://rdap.org/ip/${ip}`, {
      headers: { Accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after')) || 2;
      await sleep(Math.min(retryAfter, 10) * 1000);
      return fetchRdap(ip, 1);
    }
    if (!response.ok) {
      return { status: response.status, error: `RDAP lookup failed with HTTP ${response.status}` };
    }
    const body = await response.json();
    const countryCode = String(body.country || '').toUpperCase();
    const name = body.name || body.handle || '';
    const asn = extractAsn(body);
    return {
      handle: body.handle || '',
      name,
      countryCode,
      country: countryCode,
      asn,
      links: Array.isArray(body.links) ? body.links.map((link) => link.href).filter(Boolean).slice(0, 4) : []
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ip-api.com free tier allows 45 requests/minute; serialize with enough
// spacing to stay under it even during auto-investigate bursts.
const IP_API_SPACING_MS = 1500;
let ipApiChain = Promise.resolve();

function lookupIpApi(ip) {
  const run = ipApiChain.then(() => fetchIpApi(ip));
  ipApiChain = run.catch(() => {}).then(() => sleep(IP_API_SPACING_MS));
  return run;
}

const IP_API_FIELDS = 'status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,asname,reverse';

async function fetchIpApi(ip) {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=${IP_API_FIELDS}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return { error: `ip-api lookup failed with HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body.status !== 'success') {
      return { error: body.message || 'ip-api lookup failed' };
    }
    return body;
  } catch (error) {
    return { error: error.message };
  }
}

function parseAsNumber(asField) {
  // ip-api "as" looks like "AS396982 Google LLC"
  const match = String(asField || '').match(/^AS\d+/i);
  return match ? match[0].toUpperCase() : '';
}

function extractAsn(body) {
  const text = JSON.stringify(body);
  const match = text.match(/\bAS(\d{1,10})\b/i) || text.match(/"autnum"\s*:\s*(\d+)/i);
  return match ? `AS${match[1]}` : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStale(isoDate, maxAgeMs) {
  const age = Date.now() - new Date(isoDate).getTime();
  return Number.isNaN(age) || age > maxAgeMs;
}
