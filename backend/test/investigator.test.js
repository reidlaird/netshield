import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTracert } from '../src/investigator.js';

test('parses Windows tracert output with latency and timeout hops', () => {
  const hops = parseTracert(`
Tracing route to 1.1.1.1 over a maximum of 20 hops

  1     1 ms     1 ms     1 ms  192.168.1.254
  2     *        *        *     Request timed out.
  3    12 ms    13 ms    11 ms  64.59.188.1
`);

  assert.equal(hops.length, 3);
  assert.equal(hops[0].address, '192.168.1.254');
  assert.deepEqual(hops[0].latenciesMs, [1, 1, 1]);
  assert.equal(hops[1].timedOut, true);
  assert.equal(hops[2].address, '64.59.188.1');
});
