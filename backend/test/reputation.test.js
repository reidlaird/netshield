import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReputation } from '../src/reputation.js';

const NOW = '2026-07-06T00:00:00.000Z';

test('merges both sources and flags high abuse confidence', () => {
  const summary = summarizeReputation(
    { abuseConfidenceScore: 87, totalReports: 23, lastReportedAt: '2026-07-01T00:00:00Z', usageType: 'Data Center/Web Hosting/Transit' },
    { malicious: 0, suspicious: 1, harmless: 60, undetected: 30 },
    NOW
  );

  assert.deepEqual(summary.sources, ['abuseipdb', 'virustotal']);
  assert.equal(summary.abuse.score, 87);
  assert.equal(summary.abuse.totalReports, 23);
  assert.equal(summary.virusTotal.malicious, 0);
  assert.equal(summary.flagged, true);
  assert.equal(summary.error, '');
});

test('flags on VirusTotal malicious verdicts alone', () => {
  const summary = summarizeReputation(
    { abuseConfidenceScore: 0, totalReports: 0 },
    { malicious: 3, suspicious: 0, harmless: 50, undetected: 40 },
    NOW
  );
  assert.equal(summary.flagged, true);
});

test('does not flag clean results or single-engine VT hits', () => {
  const summary = summarizeReputation(
    { abuseConfidenceScore: 12, totalReports: 1 },
    { malicious: 1, suspicious: 2, harmless: 70, undetected: 20 },
    NOW
  );
  assert.equal(summary.flagged, false);
  assert.equal(summary.error, '');
});

test('partial failure keeps the healthy source and reports no error', () => {
  const summary = summarizeReputation(
    { error: 'HTTP 429' },
    { malicious: 0, suspicious: 0, harmless: 80, undetected: 10 },
    NOW
  );
  assert.deepEqual(summary.sources, ['virustotal']);
  assert.equal(summary.abuse, null);
  assert.equal(summary.error, '');
  assert.equal(summary.flagged, false);
});

test('total failure surfaces a combined error', () => {
  const summary = summarizeReputation({ error: 'HTTP 429' }, { error: 'timeout' }, NOW);
  assert.deepEqual(summary.sources, []);
  assert.equal(summary.error, 'AbuseIPDB: HTTP 429; VirusTotal: timeout');
  assert.equal(summary.flagged, false);
});

test('handles a single configured source (null for the other)', () => {
  const summary = summarizeReputation({ abuseConfidenceScore: 55, totalReports: 4 }, null, NOW);
  assert.deepEqual(summary.sources, ['abuseipdb']);
  assert.equal(summary.virusTotal, null);
  assert.equal(summary.flagged, true);
});
