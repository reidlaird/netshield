import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SETTINGS = {
  selectedAdapter: '',
  pollIntervalMs: 2000,
  historyRetentionDays: 7,
  geoIpDatabasePath: '',
  optionalApisEnabled: false
};

export function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      remote_address TEXT NOT NULL,
      remote_port INTEGER NOT NULL,
      process_name TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connections_last_seen ON connections(last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_connections_remote_address ON connections(remote_address);
    CREATE TABLE IF NOT EXISTS investigations (
      ip TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routes (
      target TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
  `);

  const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const writeSetting = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const upsertConnection = db.prepare(`
    INSERT INTO connections (id, remote_address, remote_port, process_name, first_seen, last_seen, status, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      remote_address = excluded.remote_address,
      remote_port = excluded.remote_port,
      process_name = excluded.process_name,
      last_seen = excluded.last_seen,
      status = excluded.status,
      json = excluded.json
  `);
  const getConnections = db.prepare('SELECT json FROM connections ORDER BY last_seen DESC LIMIT ?');
  const deleteOldConnections = db.prepare("DELETE FROM connections WHERE last_seen < datetime('now', ?)");
  const saveInvestigation = db.prepare(`
    INSERT INTO investigations (ip, checked_at, json)
    VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET checked_at = excluded.checked_at, json = excluded.json
  `);
  const getInvestigation = db.prepare('SELECT json FROM investigations WHERE ip = ?');
  const saveRoute = db.prepare(`
    INSERT INTO routes (target, checked_at, json)
    VALUES (?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET checked_at = excluded.checked_at, json = excluded.json
  `);
  const getRoute = db.prepare('SELECT json FROM routes WHERE target = ?');

  function getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const row = readSetting.get(key);
      if (row) {
        try {
          settings[key] = JSON.parse(row.value);
        } catch {
          settings[key] = row.value;
        }
      }
    }
    return settings;
  }

  function updateSettings(patch) {
    const next = sanitizeSettings({ ...getSettings(), ...patch });
    for (const [key, value] of Object.entries(next)) {
      writeSetting.run(key, JSON.stringify(value));
    }
    return next;
  }

  function saveConnections(connections) {
    db.exec('BEGIN');
    try {
      for (const connection of connections) {
        upsertConnection.run(
          connection.id,
          connection.remoteAddress,
          connection.remotePort,
          connection.processName,
          connection.firstSeen,
          connection.lastSeen,
          connection.status,
          JSON.stringify(connection)
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getHistory(limit = 500) {
    return getConnections.all(Number(limit)).map((row) => JSON.parse(row.json));
  }

  function clearHistory() {
    db.exec('DELETE FROM connections; DELETE FROM investigations; DELETE FROM routes;');
  }

  function pruneHistory(retentionDays) {
    deleteOldConnections.run(`-${Number(retentionDays || DEFAULT_SETTINGS.historyRetentionDays)} days`);
  }

  function cacheInvestigation(ip, data) {
    saveInvestigation.run(ip, data.checkedAt || new Date().toISOString(), JSON.stringify(data));
  }

  function readInvestigation(ip) {
    const row = getInvestigation.get(ip);
    return row ? JSON.parse(row.json) : null;
  }

  function cacheRoute(target, data) {
    saveRoute.run(target, data.checkedAt || new Date().toISOString(), JSON.stringify(data));
  }

  function readRoute(target) {
    const row = getRoute.get(target);
    return row ? JSON.parse(row.json) : null;
  }

  return {
    db,
    getSettings,
    updateSettings,
    saveConnections,
    getHistory,
    clearHistory,
    pruneHistory,
    cacheInvestigation,
    readInvestigation,
    cacheRoute,
    readRoute
  };
}

export function sanitizeSettings(input) {
  return {
    selectedAdapter: String(input.selectedAdapter || ''),
    pollIntervalMs: Math.max(1000, Math.min(30000, Number(input.pollIntervalMs || DEFAULT_SETTINGS.pollIntervalMs))),
    historyRetentionDays: Math.max(1, Math.min(90, Number(input.historyRetentionDays || DEFAULT_SETTINGS.historyRetentionDays))),
    geoIpDatabasePath: String(input.geoIpDatabasePath || ''),
    optionalApisEnabled: Boolean(input.optionalApisEnabled)
  };
}
