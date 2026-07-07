import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWindowsSnapshot, normalizeSnapshot, ensureArray, _collector } from '../src/windowsCollector.js';

test('normalizeSnapshot parses a compressed snapshot line', () => {
  const snapshot = normalizeSnapshot(JSON.stringify({
    collectedAt: '2026-07-06T00:00:00.000Z',
    connections: { remoteAddress: '1.1.1.1', remotePort: 443 },
    routes: [{ destinationPrefix: '0.0.0.0/0' }],
    adapters: null
  }));

  assert.equal(snapshot.collectedAt, '2026-07-06T00:00:00.000Z');
  assert.equal(snapshot.connections.length, 1, 'single object is wrapped in an array');
  assert.equal(snapshot.routes.length, 1);
  assert.deepEqual(snapshot.adapters, []);
});

test('normalizeSnapshot returns an empty structure for blank output', () => {
  const snapshot = normalizeSnapshot('   ');
  assert.deepEqual(snapshot.connections, []);
  assert.deepEqual(snapshot.routes, []);
  assert.deepEqual(snapshot.adapters, []);
  assert.ok(snapshot.collectedAt);
});

test('ensureArray wraps scalars and passes arrays through', () => {
  assert.deepEqual(ensureArray(null), []);
  assert.deepEqual(ensureArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(ensureArray([1, 2]), [1, 2]);
});

test('persistent collector reuses one PowerShell process across polls', { timeout: 60000 }, async (t) => {
  t.after(() => _collector.kill());

  const first = await collectWindowsSnapshot();
  const pidAfterFirst = _collector.pid;
  const second = await collectWindowsSnapshot();
  const pidAfterSecond = _collector.pid;

  assert.ok(first.collectedAt, 'first snapshot has a timestamp');
  assert.ok(Array.isArray(second.connections), 'second snapshot has connections array');
  assert.ok(pidAfterFirst, 'persistent process is alive after first poll');
  assert.equal(pidAfterFirst, pidAfterSecond, 'same process served both polls');
});

test('collector recovers after its process is killed', { timeout: 60000 }, async (t) => {
  t.after(() => _collector.kill());

  await collectWindowsSnapshot();
  _collector.kill();

  const snapshot = await collectWindowsSnapshot();
  assert.ok(snapshot.collectedAt, 'snapshot still succeeds after a kill');
});
