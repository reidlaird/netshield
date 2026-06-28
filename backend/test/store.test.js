import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';

test('stores settings, history, and cached investigations', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netshield-store-'));
  const store = openStore(path.join(tempDir, 'test.sqlite'));

  const settings = store.updateSettings({ pollIntervalMs: 500, historyRetentionDays: 120 });
  assert.equal(settings.pollIntervalMs, 1000);
  assert.equal(settings.historyRetentionDays, 90);

  store.saveConnections([{
    id: 'tcp|a|1|b|2|3',
    remoteAddress: '1.1.1.1',
    remotePort: 443,
    processName: 'test',
    firstSeen: '2026-06-28T00:00:00.000Z',
    lastSeen: '2026-06-28T00:00:01.000Z',
    status: 'open'
  }]);
  assert.equal(store.getHistory(10).length, 1);

  store.cacheInvestigation('1.1.1.1', { ip: '1.1.1.1', checkedAt: '2026-06-28T00:00:00.000Z' });
  assert.equal(store.readInvestigation('1.1.1.1').ip, '1.1.1.1');
});
