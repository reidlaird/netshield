// IP reputation lookups against optional online APIs (AbuseIPDB, VirusTotal).
// Both are keyed services with tight free tiers, so lookups only run when the
// user enables the "optional online reputation APIs" setting AND at least one
// key is present in backend/.env.

export function isReputationConfigured() {
  return Boolean(process.env.ABUSEIPDB_API_KEY || process.env.VIRUSTOTAL_API_KEY);
}

// A connection is flagged when either source reports meaningful abuse:
// AbuseIPDB's confidence score is a 0-100 percentage (their docs suggest 75+
// as high confidence; 50 catches repeat offenders without much noise), and
// two or more VirusTotal engines marking an IP malicious filters out the
// single-engine false positives that are common on shared hosting ranges.
const ABUSE_FLAG_SCORE = 50;
const VT_FLAG_MALICIOUS = 2;

export function summarizeReputation(abuse, vt, checkedAt = new Date().toISOString()) {
  const sources = [];
  const errors = [];

  let abuseSummary = null;
  if (abuse) {
    if (abuse.error) {
      errors.push(`AbuseIPDB: ${abuse.error}`);
    } else {
      sources.push('abuseipdb');
      abuseSummary = {
        score: Number(abuse.abuseConfidenceScore) || 0,
        totalReports: Number(abuse.totalReports) || 0,
        lastReportedAt: abuse.lastReportedAt || '',
        usageType: abuse.usageType || ''
      };
    }
  }

  let vtSummary = null;
  if (vt) {
    if (vt.error) {
      errors.push(`VirusTotal: ${vt.error}`);
    } else {
      sources.push('virustotal');
      vtSummary = {
        malicious: Number(vt.malicious) || 0,
        suspicious: Number(vt.suspicious) || 0,
        harmless: Number(vt.harmless) || 0,
        undetected: Number(vt.undetected) || 0
      };
    }
  }

  const flagged =
    (abuseSummary?.score ?? 0) >= ABUSE_FLAG_SCORE ||
    (vtSummary?.malicious ?? 0) >= VT_FLAG_MALICIOUS;

  return {
    checkedAt,
    sources,
    abuse: abuseSummary,
    virusTotal: vtSummary,
    flagged,
    // Only surface an error when every configured source failed; a partial
    // result is still useful and shouldn't render as a failure.
    error: sources.length === 0 ? errors.join('; ') : ''
  };
}

export function lookupReputation(ip) {
  return Promise.all([
    process.env.ABUSEIPDB_API_KEY ? lookupAbuseIpDb(ip) : Promise.resolve(null),
    process.env.VIRUSTOTAL_API_KEY ? lookupVirusTotal(ip) : Promise.resolve(null)
  ]).then(([abuse, vt]) => summarizeReputation(abuse, vt));
}

// AbuseIPDB free tier: 1,000 checks/day. Serialize with spacing like the
// rdap/ip-api chains so trace-route bursts don't blow through the quota.
const ABUSE_SPACING_MS = 1500;
let abuseChain = Promise.resolve();

function lookupAbuseIpDb(ip) {
  const run = abuseChain.then(() => fetchAbuseIpDb(ip));
  abuseChain = run.catch(() => {}).then(() => sleep(ABUSE_SPACING_MS));
  return run;
}

async function fetchAbuseIpDb(ip) {
  try {
    const response = await fetch(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      {
        headers: {
          Key: process.env.ABUSEIPDB_API_KEY,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    const data = body?.data;
    if (!data || typeof data.abuseConfidenceScore !== 'number') {
      return { error: 'unexpected response shape' };
    }
    return data;
  } catch (error) {
    return { error: error.message };
  }
}

// VirusTotal free tier: 4 requests/minute — by far the slowest quota in the
// app, hence the aggressive spacing. Results are cached with the rest of the
// investigation for 24h, so steady-state traffic rarely hits this.
const VT_SPACING_MS = 15500;
let vtChain = Promise.resolve();

function lookupVirusTotal(ip) {
  const run = vtChain.then(() => fetchVirusTotal(ip));
  vtChain = run.catch(() => {}).then(() => sleep(VT_SPACING_MS));
  return run;
}

async function fetchVirusTotal(ip) {
  try {
    const response = await fetch(
      `https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(ip)}`,
      {
        headers: { 'x-apikey': process.env.VIRUSTOTAL_API_KEY },
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!response.ok) {
      return { error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    const stats = body?.data?.attributes?.last_analysis_stats;
    if (!stats) {
      return { error: 'unexpected response shape' };
    }
    return stats;
  } catch (error) {
    return { error: error.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
