import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPrivateOrReservedIP, normalizeAddress } from './connectionUtils.js';

const execFileAsync = promisify(execFile);

const COUNTRY_POINTS = {
  CA: { lat: 56.1304, lon: -106.3468, label: 'Canada' },
  US: { lat: 39.8283, lon: -98.5795, label: 'United States' },
  GB: { lat: 55.3781, lon: -3.436, label: 'United Kingdom' },
  IE: { lat: 53.4129, lon: -8.2439, label: 'Ireland' },
  DE: { lat: 51.1657, lon: 10.4515, label: 'Germany' },
  FR: { lat: 46.2276, lon: 2.2137, label: 'France' },
  NL: { lat: 52.1326, lon: 5.2913, label: 'Netherlands' },
  SE: { lat: 60.1282, lon: 18.6435, label: 'Sweden' },
  JP: { lat: 36.2048, lon: 138.2529, label: 'Japan' },
  SG: { lat: 1.3521, lon: 103.8198, label: 'Singapore' },
  AU: { lat: -25.2744, lon: 133.7751, label: 'Australia' },
  BR: { lat: -14.235, lon: -51.9253, label: 'Brazil' },
  IN: { lat: 20.5937, lon: 78.9629, label: 'India' }
};

export async function investigateIp(ip, options = {}) {
  const address = normalizeAddress(ip);
  const checkedAt = new Date().toISOString();
  const privateAddress = isPrivateOrReservedIP(address);
  const cached = options.store?.readInvestigation(address);

  if (cached && !isStale(cached.checkedAt, options.maxCacheAgeMs ?? 1000 * 60 * 60 * 24)) {
    return { ...cached, fromCache: true };
  }

  const [ptr, dnsCacheHints, rdap] = await Promise.all([
    resolvePtr(address),
    resolveDnsCacheHints(address),
    privateAddress ? Promise.resolve(null) : lookupRdap(address)
  ]);

  const countryCode = rdap?.countryCode || '';
  const centroid = countryCode ? COUNTRY_POINTS[countryCode] : null;
  const result = {
    ip: address,
    checkedAt,
    privateAddress,
    ptr,
    dnsCacheHints,
    rdap,
    geo: centroid
      ? { countryCode, country: centroid.label, latitude: centroid.lat, longitude: centroid.lon, source: 'rdap-country-centroid' }
      : { countryCode, country: rdap?.country || '', latitude: null, longitude: null, source: privateAddress ? 'private' : 'unlocated' }
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
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 }
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

async function lookupRdap(ip) {
  try {
    const response = await fetch(`https://rdap.org/ip/${encodeURIComponent(ip)}`, {
      headers: { Accept: 'application/rdap+json, application/json' }
    });
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
      country: COUNTRY_POINTS[countryCode]?.label || countryCode,
      asn,
      links: Array.isArray(body.links) ? body.links.map((link) => link.href).filter(Boolean).slice(0, 4) : []
    };
  } catch (error) {
    return { error: error.message };
  }
}

function extractAsn(body) {
  const text = JSON.stringify(body);
  const match = text.match(/\bAS(\d{1,10})\b/i) || text.match(/"autnum"\s*:\s*(\d+)/i);
  return match ? `AS${match[1]}` : '';
}

function isStale(isoDate, maxAgeMs) {
  const age = Date.now() - new Date(isoDate).getTime();
  return Number.isNaN(age) || age > maxAgeMs;
}
