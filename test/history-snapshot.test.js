'use strict';

/**
 * Incremental history snapshots: a large History file must not be fully
 * re-copied on every sync, visits must stay complete and de-duplicated,
 * and a hot journal / WAL must still yield the last committed state
 * without writing the live browser file.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Store } = require('../src/main/store');
const { SyncEngine } = require('../src/main/sync');
const { readProfileVisits } = require('../src/main/browsers');
const {
  CHUNK_SIZE,
  copyChangedBlocks,
  snapshotHistory,
  cleanupSnapshot,
  sourceFingerprint,
  fingerprintsEqual,
  resetSnapshotStats,
  getLastSnapshotResult,
} = require('../src/main/history-snapshot');

const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 20, 2, 0, 0);
const LARGE_BYTES = 8 * 1024 * 1024;

const chromeTime = (ms) => BigInt(ms + CHROME_EPOCH_OFFSET_MS) * 1000n;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function makeChromeHistory(file, { padBytes = 0, visits = [] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = DELETE');
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER);
    CREATE TABLE _pad (id INTEGER PRIMARY KEY, blob BLOB);
  `);
  if (padBytes > 0) {
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    const ins = db.prepare('INSERT INTO _pad (blob) VALUES (?)');
    let left = padBytes;
    while (left > 0) {
      const n = Math.min(chunk.length, left);
      ins.run(n === chunk.length ? chunk : chunk.subarray(0, n));
      left -= n;
    }
  }
  const find = db.prepare('SELECT id FROM urls WHERE url = ?');
  const addUrl = db.prepare('INSERT INTO urls (url, title) VALUES (?, ?)');
  const addVisit = db.prepare('INSERT INTO visits (url, visit_time, from_visit) VALUES (?, ?, 0)');
  for (const v of visits) {
    let row = find.get(v.url);
    if (!row) {
      const info = addUrl.run(v.url, v.title || ('T ' + v.url));
      row = { id: info.lastInsertRowid };
    }
    addVisit.run(row.id, chromeTime(v.ms));
  }
  db.close();
}

function addChromeVisits(file, visits) {
  const db = new Database(file);
  const find = db.prepare('SELECT id FROM urls WHERE url = ?');
  const addUrl = db.prepare('INSERT INTO urls (url, title) VALUES (?, ?)');
  const addVisit = db.prepare('INSERT INTO visits (url, visit_time, from_visit) VALUES (?, ?, 0)');
  for (const v of visits) {
    let row = find.get(v.url);
    if (!row) {
      const info = addUrl.run(v.url, v.title || ('T ' + v.url));
      row = { id: info.lastInsertRowid };
    }
    addVisit.run(row.id, chromeTime(v.ms));
  }
  db.close();
}

function chromeBrowser(historyPath, profile = 'Default') {
  return { id: 'chrome', name: 'Google Chrome', engine: 'chromium', profiles: [{ profile, historyPath }] };
}

async function runSync(store, browsers, { inProcess = false } = {}) {
  const sync = new SyncEngine(store, { isSyncAllowed: () => true });
  sync.browsers = browsers;
  sync.running = true;
  // Snapshot I/O counters live in this process; force the in-process
  // fallback so the test can observe bytes written. Worker behaviour is
  // already covered by history-backfill.test.js.
  if (inProcess) sync._workerBroken = true;
  try {
    return await sync.syncOnce(true);
  } finally {
    sync.stop();
  }
}

describe('copyChangedBlocks', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-blocks-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the whole file on the first copy and nothing when dest already matches', () => {
    const src = path.join(dir, 'src.bin');
    const dest = path.join(dir, 'dest.bin');
    const buf = Buffer.alloc(LARGE_BYTES, 7);
    buf[100] = 9;
    buf[LARGE_BYTES - 10] = 11;
    fs.writeFileSync(src, buf);

    const first = copyChangedBlocks(src, dest);
    assert.equal(first.mode, 'full');
    assert.equal(first.bytesWritten, LARGE_BYTES);
    assert.equal(sha256(src), sha256(dest));

    const second = copyChangedBlocks(src, dest);
    assert.equal(second.mode, 'incremental');
    assert.equal(second.bytesWritten, 0);
    assert.equal(second.chunksWritten, 0);
    assert.ok(second.chunksCompared >= Math.ceil(LARGE_BYTES / CHUNK_SIZE));
    assert.equal(sha256(src), sha256(dest));
  });

  it('rewrites only the dirty 1 MiB chunks when a few bytes change in a large file', () => {
    const src = path.join(dir, 'src.bin');
    const dest = path.join(dir, 'dest.bin');
    const buf = Buffer.alloc(LARGE_BYTES, 3);
    fs.writeFileSync(src, buf);
    copyChangedBlocks(src, dest);

    // Flip one byte in the last chunk and grow the file by a half chunk.
    const updated = Buffer.concat([Buffer.from(buf), Buffer.alloc(CHUNK_SIZE / 2, 4)]);
    updated[LARGE_BYTES - 20] = 99;
    fs.writeFileSync(src, updated);

    const result = copyChangedBlocks(src, dest);
    assert.equal(result.mode, 'incremental');
    assert.ok(
      result.bytesWritten <= 2 * CHUNK_SIZE,
      `expected at most two chunks written, got ${result.bytesWritten}`
    );
    assert.ok(result.bytesWritten > 0);
    assert.ok(result.bytesWritten < updated.length / 2, 'must not rewrite most of the file');
    assert.equal(sha256(src), sha256(dest));
  });
});

describe('history snapshot cache', () => {
  let dir;
  let prevCache;
  let prevUserData;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-snap-'));
    prevCache = process.env.TRACEHUB_HISTORY_CACHE;
    prevUserData = process.env.TRACEHUB_USER_DATA;
    process.env.TRACEHUB_HISTORY_CACHE = path.join(dir, 'cache');
    delete process.env.TRACEHUB_USER_DATA;
    resetSnapshotStats();
  });

  afterEach(() => {
    if (prevCache === undefined) delete process.env.TRACEHUB_HISTORY_CACHE;
    else process.env.TRACEHUB_HISTORY_CACHE = prevCache;
    if (prevUserData === undefined) delete process.env.TRACEHUB_USER_DATA;
    else process.env.TRACEHUB_USER_DATA = prevUserData;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reuses the cache when the source History file has not changed', async () => {
    const file = path.join(dir, 'Default', 'History');
    makeChromeHistory(file, {
      padBytes: LARGE_BYTES,
      visits: [
        { url: 'https://a.example/', ms: T0 },
        { url: 'https://b.example/', ms: T0 + HOUR },
      ],
    });
    const size = fs.statSync(file).size;
    assert.ok(size >= LARGE_BYTES, `fixture too small: ${size}`);

    const first = snapshotHistory(file, 'chrome-Default');
    assert.equal(first.mode, 'full');
    assert.equal(first.bytesWritten, size);
    cleanupSnapshot(first);

    const second = snapshotHistory(file, 'chrome-Default');
    assert.equal(second.mode, 'reuse');
    assert.equal(second.bytesWritten, 0);
    assert.equal(second.sideBytesWritten, 0);
    assert.ok(second.bytesReadFromSource <= 1024, 'reuse should only read the sqlite header');
    cleanupSnapshot(second);

    const page = await readProfileVisits(
      { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
      { profile: 'Default', historyPath: file },
      { visitId: null, visitTime: 0 }
    );
    assert.equal(getLastSnapshotResult().mode, 'reuse');
    assert.deepEqual(page.items.map((i) => i.url).sort(), ['https://a.example/', 'https://b.example/']);
  });

  it('copies far fewer bytes than the file size after a few new visits, without dropping or duplicating rows', async () => {
    const file = path.join(dir, 'Default', 'History');
    const initial = [];
    for (let i = 0; i < 20; i++) initial.push({ url: `https://old${i}.example/`, ms: T0 + i * 1000 });
    makeChromeHistory(file, { padBytes: LARGE_BYTES, visits: initial });
    const size = fs.statSync(file).size;

    const firstPage = await readProfileVisits(
      { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
      { profile: 'Default', historyPath: file },
      { visitId: null, visitTime: 0 }
    );
    const firstSnap = getLastSnapshotResult();
    assert.equal(firstSnap.mode, 'full');
    assert.equal(firstPage.items.length, 20);

    addChromeVisits(file, [
      { url: 'https://new1.example/', ms: T0 + HOUR },
      { url: 'https://new2.example/', ms: T0 + 2 * HOUR },
      { url: 'https://old0.example/', ms: T0 + 3 * HOUR },
    ]);

    resetSnapshotStats();
    const secondPage = await readProfileVisits(
      { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
      { profile: 'Default', historyPath: file },
      { visitId: null, visitTime: 0 }
    );
    const secondSnap = getLastSnapshotResult();
    assert.equal(secondSnap.mode, 'incremental');
    assert.ok(
      secondSnap.bytesWritten < size / 4,
      `incremental write ${secondSnap.bytesWritten} should be well under file size ${size}`
    );
    assert.ok(secondSnap.bytesWritten < 3 * CHUNK_SIZE, `expected a few chunks, wrote ${secondSnap.bytesWritten}`);

    const urls = secondPage.items.map((i) => i.url);
    const expected = initial.map((v) => v.url).concat(['https://new1.example/', 'https://new2.example/', 'https://old0.example/']);
    assert.equal(secondPage.items.length, expected.length);
    assert.deepEqual(urls.sort(), expected.sort());
    // (url, time) pairs are unique even when the same URL is revisited.
    const keys = secondPage.items.map((i) => `${i.url}|${i.visitTime}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('keeps the last committed state for a hot History-journal and does not write the live files', async () => {
    const file = path.join(dir, 'Default', 'History');
    makeChromeHistory(file, {
      visits: [0, 1, 2].map((i) => ({ url: `https://committed${i}.example/`, ms: T0 + i * HOUR })),
    });

    const writer = new Database(file);
    writer.pragma('journal_mode = DELETE');
    writer.pragma('cache_size = 1');
    writer.exec('BEGIN');
    writer.prepare("UPDATE urls SET url = url || 'dirty', title = 'DIRTY'").run();
    writer.prepare('DELETE FROM visits WHERE id = 1').run();
    const ins = writer.prepare('INSERT INTO urls (url, title) VALUES (?, ?)');
    for (let i = 0; i < 3000; i++) ins.run(`https://uncommitted${i}.example/${'x'.repeat(200)}`, 'u');

    assert.ok(fs.existsSync(file + '-journal'), 'writer should have spilled a hot journal');
    const liveMain = fileBytes(file);
    const liveJournal = fileBytes(file + '-journal');
    const liveMainHash = sha256(file);

    const page = await readProfileVisits(
      { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
      { profile: 'Default', historyPath: file },
      { visitId: null, visitTime: 0 }
    );

    assert.equal(sha256(file), liveMainHash, 'must not write the live History file');
    assert.deepEqual(fileBytes(file), liveMain);
    assert.deepEqual(fileBytes(file + '-journal'), liveJournal);
    assert.ok(page.items.every((i) => i.title !== 'DIRTY'));
    assert.ok(page.items.every((i) => !i.url.includes('uncommitted')));
    assert.deepEqual(page.items.map((i) => i.url).sort(), [
      'https://committed0.example/',
      'https://committed1.example/',
      'https://committed2.example/',
    ]);

    writer.exec('ROLLBACK');
    writer.close();
  });

  it('sees Firefox visits that still live only in the WAL, then reuses the cache', async () => {
    const file = path.join(dir, 'profile', 'places.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, from_visit INTEGER);
    `);
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (1, ?, ?)').run('https://fx-a.example/', 'A');
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, from_visit) VALUES (1, ?, 0)').run(T0 * 1000);
    // Leave the connection open so the new visit stays in the WAL.
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (2, ?, ?)').run('https://fx-b.example/', 'B');
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, from_visit) VALUES (2, ?, 0)').run((T0 + HOUR) * 1000);
    assert.ok(fs.existsSync(file + '-wal'), 'expected an uncheckpointed WAL');

    const browser = { id: 'firefox', name: 'Mozilla Firefox', engine: 'firefox' };
    const profile = { profile: 'profile', historyPath: file };
    const first = await readProfileVisits(browser, profile, { visitId: null, visitTime: 0 });
    assert.deepEqual(first.items.map((i) => i.url).sort(), ['https://fx-a.example/', 'https://fx-b.example/']);
    const firstMode = getLastSnapshotResult().mode;
    assert.ok(firstMode === 'full' || firstMode === 'incremental', firstMode);

    const second = await readProfileVisits(browser, profile, { visitId: null, visitTime: 0 });
    assert.equal(getLastSnapshotResult().mode, 'reuse');
    assert.equal(getLastSnapshotResult().bytesWritten, 0);
    assert.deepEqual(second.items.map((i) => i.url).sort(), ['https://fx-a.example/', 'https://fx-b.example/']);

    db.close();
  });

  it('syncs a large history twice with no duplicates, and the second pass copies no main-file bytes', async () => {
    const file = path.join(dir, 'Default', 'History');
    const visits = [];
    for (let i = 0; i < 40; i++) visits.push({ url: `https://s${i}.example/`, ms: T0 + i * 1000 });
    makeChromeHistory(file, { padBytes: LARGE_BYTES, visits });

    const store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
    const browsers = [chromeBrowser(file)];

    const r1 = await runSync(store, browsers, { inProcess: true });
    assert.equal(r1.inserted, 40);
    const afterFirst = getLastSnapshotResult();
    assert.ok(afterFirst && afterFirst.mode !== 'reuse');

    resetSnapshotStats();
    const r2 = await runSync(store, browsers, { inProcess: true });
    assert.equal(r2.inserted, 0);
    const afterSecond = getLastSnapshotResult();
    assert.equal(afterSecond.mode, 'reuse');
    assert.equal(afterSecond.bytesWritten, 0);

    const rows = store.db.all('SELECT url, visit_time AS t FROM visits ORDER BY t, url');
    assert.equal(rows.length, 40);
    const keys = rows.map((r) => `${r.url}|${r.t}`);
    assert.equal(new Set(keys).size, 40);
    store.close();
  });

  it('records a changed fingerprint after new visits so a stale cache is not reused', () => {
    const file = path.join(dir, 'Default', 'History');
    makeChromeHistory(file, { visits: [{ url: 'https://one.example/', ms: T0 }] });
    const before = sourceFingerprint(file);
    addChromeVisits(file, [{ url: 'https://two.example/', ms: T0 + HOUR }]);
    const after = sourceFingerprint(file);
    assert.equal(fingerprintsEqual(before, after), false);
    assert.ok(after.changeCounter == null || after.changeCounter !== before.changeCounter || after.mtimeMs !== before.mtimeMs || after.size !== before.size);
  });
});
