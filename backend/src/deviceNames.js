import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fills in names for LAN devices the router couldn't identify:
//  1. Reverse DNS against the system resolver (the gateway answers for DHCP
//     clients that registered a hostname).
//  2. MAC OUI -> vendor, so an unnamed device at least reads "Espressif
//     device" instead of "(unnamed)". A small offline seed covers common
//     vendors; everything else is fetched once from api.macvendors.com and
//     cached on disk so lookups survive restarts and stay within the API's
//     free-tier rate limit.
// Devices using randomized (locally administered) MACs have no real OUI, so
// they're flagged instead of looked up.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUI_CACHE_FILE = path.join(__dirname, '..', 'data', 'oui-cache.json');

const OUI_SEED = {
  'C4:DD:57': 'Espressif',
  '24:0A:C4': 'Espressif',
  '30:AE:A4': 'Espressif',
  'B8:27:EB': 'Raspberry Pi',
  'DC:A6:32': 'Raspberry Pi',
  'E4:5F:01': 'Raspberry Pi'
};

// Locally administered unicast address => randomized/private MAC (Android,
// iOS, and Windows per-network privacy addresses).
export function isRandomizedMac(mac) {
  const first = Number.parseInt(String(mac).slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) === 0x02 && (first & 0x01) === 0;
}

// "Samsung Electronics Co.,Ltd" -> "Samsung" — strip corporate suffixes until
// the name stops shrinking, keeping at least one word.
const CORP_SUFFIX = /[\s,.-]*\b(incorporated|inc|corp(orat(e|ion))?|co|ltd|limited|llc|gmbh|ag|sa|bv|technolog(y|ies)|electronics?|communications?|international|networks?|systems?|solutions|devices|company)\.?$/i;
export function shortVendor(name) {
  let s = String(name || '').split(/[,(]/)[0].trim();
  for (let prev = ''; s !== prev && /\s/.test(s); ) {
    prev = s;
    s = s.replace(CORP_SUFFIX, '').trim();
  }
  return s;
}

// --- OUI vendor cache -------------------------------------------------------

let ouiCache = null; // prefix -> vendor short name ('' = known-unknown)

function loadOuiCache() {
  if (ouiCache) return ouiCache;
  ouiCache = { ...OUI_SEED };
  try {
    Object.assign(ouiCache, JSON.parse(fs.readFileSync(OUI_CACHE_FILE, 'utf8')));
  } catch {
    // No cache yet (first run) or unreadable — start from the seed.
  }
  return ouiCache;
}

function saveOuiCache() {
  try {
    fs.mkdirSync(path.dirname(OUI_CACHE_FILE), { recursive: true });
    fs.writeFileSync(OUI_CACHE_FILE, JSON.stringify(ouiCache, null, 2), 'utf8');
  } catch {
    // Cache persistence is best-effort; lookups still work in memory.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchVendorFromApi(prefix) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.macvendors.com/${encodeURIComponent(prefix)}`, {
      signal: controller.signal
    });
    if (res.status === 200) return shortVendor(await res.text());
    if (res.status === 404) return ''; // unregistered OUI — cache the miss
    throw new Error(`macvendors status ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- reverse DNS -------------------------------------------------------------

const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
const RDNS_TTL_MS = 10 * 60 * 1000;
const rdnsCache = new Map(); // ip -> { name, expires }

async function reverseName(ip) {
  const cached = rdnsCache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.name;
  let name = '';
  try {
    const names = await resolver.reverse(ip);
    // Keep the host label; drop router-appended local suffixes.
    name = (names[0] || '').replace(/\.(local|lan|home|localdomain|home\.arpa)\.?$/i, '');
  } catch {
    // NXDOMAIN / timeout — cache the miss so every poll doesn't re-pay it.
  }
  rdnsCache.set(ip, { name, expires: Date.now() + RDNS_TTL_MS });
  return name;
}

// --- main entry ---------------------------------------------------------------

const MAX_API_LOOKUPS_PER_CALL = 20;
const API_SPACING_MS = 1200; // free tier allows ~1 request/second

export async function enrichDevices(devices) {
  const cache = loadOuiCache();

  await Promise.all(
    devices
      .filter((d) => !d.hostname && d.ip)
      .map(async (d) => { d.hostname = await reverseName(d.ip); })
  );

  let apiLookups = 0;
  let cacheDirty = false;
  for (const d of devices) {
    d.randomizedMac = isRandomizedMac(d.mac);
    d.vendor = '';
    if (d.randomizedMac) continue;

    const prefix = d.mac.slice(0, 8);
    if (prefix.length < 8) continue;
    if (prefix in cache) {
      d.vendor = cache[prefix];
    } else if (apiLookups < MAX_API_LOOKUPS_PER_CALL) {
      if (apiLookups > 0) await sleep(API_SPACING_MS);
      apiLookups += 1;
      try {
        cache[prefix] = await fetchVendorFromApi(prefix);
        d.vendor = cache[prefix];
        cacheDirty = true;
      } catch {
        // Rate-limited or offline — leave uncached and retry next poll.
      }
    }
  }
  if (cacheDirty) saveOuiCache();
  return devices;
}
