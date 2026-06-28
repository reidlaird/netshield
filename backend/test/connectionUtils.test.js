import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffConnections,
  isPrivateOrReservedIP,
  normalizeConnection
} from '../src/connectionUtils.js';

test('detects private and reserved IP ranges', () => {
  assert.equal(isPrivateOrReservedIP('192.168.1.254'), true);
  assert.equal(isPrivateOrReservedIP('10.4.3.2'), true);
  assert.equal(isPrivateOrReservedIP('172.20.1.5'), true);
  assert.equal(isPrivateOrReservedIP('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIP('2606:4700:4700::1111'), false);
  assert.equal(isPrivateOrReservedIP('fe80::1%11'), true);
});

test('normalizes a raw Windows TCP row', () => {
  const row = normalizeConnection({
    localAddress: '192.168.1.75',
    localPort: '50000',
    remoteAddress: '1.1.1.1',
    remotePort: '443',
    pid: '42',
    processName: 'msedge',
    state: 'Established'
  }, null, '2026-06-28T00:00:00.000Z');

  assert.equal(row.protocol, 'TCP');
  assert.equal(row.remotePort, 443);
  assert.equal(row.pid, 42);
  assert.equal(row.status, 'open');
  assert.equal(row.firstSeen, '2026-06-28T00:00:00.000Z');
});

test('diffs added, updated, and closed connections', () => {
  const first = diffConnections(new Map(), [{
    localAddress: '192.168.1.75',
    localPort: 50000,
    remoteAddress: '1.1.1.1',
    remotePort: 443,
    pid: 42,
    processName: 'msedge',
    state: 'Established'
  }], '2026-06-28T00:00:00.000Z');

  assert.equal(first.added.length, 1);

  const second = diffConnections(first.nextMap, [{
    localAddress: '192.168.1.75',
    localPort: 50000,
    remoteAddress: '1.1.1.1',
    remotePort: 443,
    pid: 42,
    processName: 'msedge',
    processPath: 'C:\\Edge\\msedge.exe',
    state: 'Established'
  }], '2026-06-28T00:00:02.000Z');

  assert.equal(second.updated.length, 1);
  assert.equal(second.updated[0].firstSeen, '2026-06-28T00:00:00.000Z');

  const third = diffConnections(second.nextMap, [], '2026-06-28T00:00:04.000Z');
  assert.equal(third.closed.length, 1);
  assert.equal(third.closed[0].status, 'closed');
});
