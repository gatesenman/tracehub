'use strict';

/**
 * Profile discovery and reads for empty / stub history files.
 * Opera often leaves a 0-byte History at the user-data root while the real
 * database lives in Default/History. Old Firefox profiles can have a 0-byte
 * places.sqlite with no moz_historyvisits table.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { Store } = require('../src/main/store');
const { SyncEngine } = require('../src/main/sync');
const {
  chromiumProfiles,
  firefoxProfiles,
  isPlausibleHistorySqlite,
  readProfileVisits,
} = require('../src/main/browsers');

const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const chromeTime = (ms) => BigInt(ms + CHROME_EPOCH_OFFSET_MS) * 1000n;

function writeChromeHistory(file, visits) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER);
  `);
  let urlId = 0;
  let visitId = 0;
  for (const v of visits) {
    urlId += 1;
    visitId += 1;
    db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(urlId, v.url, v.title || v.url);
    db.prepare('INSERT INTO visits (id, url, visit_time, from_visit) VALUES (?, ?, ?, 0)')
      .run(visitId, urlId, chromeTime(v.ms));
  }
  db.close();
}

function writeFirefoxPlaces(file, visits) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, from_visit INTEGER);
  `);
  let placeId = 0;
  let visitId = 0;
  for (const v of visits) {
    placeId += 1;
    visitId += 1;
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(placeId, v.url, v.title || v.url);
    db.prepare('INSERT INTO moz_historyvisits (id, place_id, visit_date, from_visit) VALUES (?, ?, ?, 0)')
      .run(visitId, placeId, v.ms * 1000);
  }
  db.close();
}

describe('history profile detection and empty stubs', () => {
  let dir;
  let prevCache;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-hist-detect-'));
    prevCache = process.env.TRACEHUB_HISTORY_CACHE;
    process.env.TRACEHUB_HISTORY_CACHE = path.join(dir, 'history-cache');
  });

  afterEach(() => {
    if (prevCache === undefined) delete process.env.TRACEHUB_HISTORY_CACHE;
    else process.env.TRACEHUB_HISTORY_CACHE = prevCache;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats a zero-byte file as not a history database', () => {
    const stub = path.join(dir, 'History');
    fs.writeFileSync(stub, '');
    assert.equal(isPlausibleHistorySqlite(stub), false);
    assert.equal(isPlausibleHistorySqlite(path.join(dir, 'missing')), false);
  });

  it('accepts a real SQLite History file', () => {
    const file = path.join(dir, 'real', 'History');
    writeChromeHistory(file, [{ url: 'https://example.com/', ms: Date.UTC(2026, 10, 1) }]);
    assert.equal(isPlausibleHistorySqlite(file), true);
  });

  it('Opera-style: ignores a 0-byte root History and uses Default/History', () => {
    const base = path.join(dir, 'Opera Stable');
    fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(base, 'History'), '');
    writeChromeHistory(path.join(base, 'Default', 'History'), [
      { url: 'https://opera.example/a', ms: Date.UTC(2026, 9, 12, 2, 0, 0) },
      { url: 'https://opera.example/b', ms: Date.UTC(2026, 9, 12, 3, 0, 0) },
    ]);

    const profiles = chromiumProfiles({ base });
    assert.deepEqual(
      profiles.map((p) => ({ profile: p.profile, historyPath: p.historyPath })),
      [{ profile: 'Default', historyPath: path.join(base, 'Default', 'History') }]
    );
  });

  it('classic Opera: uses root History when Default/History is absent', () => {
    const base = path.join(dir, 'Opera Stable');
    fs.mkdirSync(base, { recursive: true });
    writeChromeHistory(path.join(base, 'History'), [
      { url: 'https://opera.example/classic', ms: Date.UTC(2026, 5, 1) },
    ]);
    const profiles = chromiumProfiles({ base });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].profile, 'Default');
    assert.equal(profiles[0].historyPath, path.join(base, 'History'));
  });

  it('does not register two Default profiles when both root and Default/History exist and are valid', () => {
    const base = path.join(dir, 'User Data');
    fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
    writeChromeHistory(path.join(base, 'History'), [
      { url: 'https://root.example/', ms: Date.UTC(2026, 1, 1) },
    ]);
    writeChromeHistory(path.join(base, 'Default', 'History'), [
      { url: 'https://default.example/', ms: Date.UTC(2026, 1, 2) },
    ]);
    const profiles = chromiumProfiles({ base });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].profile, 'Default');
    assert.equal(profiles[0].historyPath, path.join(base, 'Default', 'History'));
  });

  it('skips a Firefox profile whose places.sqlite is a zero-byte stub', () => {
    const base = path.join(dir, 'Profiles');
    const stubDir = path.join(base, 'ziby480f.default');
    const realDir = path.join(base, '14b96y5r.default-release');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'places.sqlite'), '');
    writeFirefoxPlaces(path.join(realDir, 'places.sqlite'), [
      { url: 'https://firefox.example/', ms: Date.UTC(2026, 4, 31) },
    ]);

    const profiles = firefoxProfiles({ base });
    assert.deepEqual(
      profiles.map((p) => p.profile),
      ['14b96y5r.default-release']
    );
  });

  it('readProfileVisits returns an empty page, not an error, when the visit table is missing', async () => {
    const file = path.join(dir, 'empty.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE unrelated (id INTEGER)');
    db.close();
    const page = await readProfileVisits(
      { id: 'opera', name: 'Opera', engine: 'chromium' },
      { profile: 'Default', historyPath: file }
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.hasMore, false);
  });

  it('syncs the real Opera Default history and does not record an error for a 0-byte stub', async () => {
    const base = path.join(dir, 'Opera Stable');
    fs.mkdirSync(path.join(base, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(base, 'History'), '');
    const t0 = Date.UTC(2026, 9, 12, 2, 0, 0);
    writeChromeHistory(path.join(base, 'Default', 'History'), [
      { url: 'https://opera.example/a', ms: t0 },
      { url: 'https://opera.example/b', ms: t0 + 3600000 },
    ]);

    const profiles = chromiumProfiles({ base });
    const store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
    const sync = new SyncEngine(store, { isSyncAllowed: () => true });
    sync.browsers = [{ id: 'opera', name: 'Opera', engine: 'chromium', profiles }];
    sync.running = true;
    try {
      const res = await sync.syncOnce(true);
      assert.equal(res.inserted, 2);
      assert.deepEqual(res.errors, []);
      const again = await sync.syncOnce(true);
      assert.equal(again.inserted, 0);
      assert.deepEqual(again.errors, []);
    } finally {
      sync.stop();
      store.close();
    }
  });
});
