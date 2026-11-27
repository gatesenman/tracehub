'use strict';

/**
 * Backfill of browser history that was recorded while TraceHub was closed.
 * Uses the real Store (better-sqlite3), the real history worker, and
 * Chrome / Firefox-format history databases on disk.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { Store } = require('../src/main/store');
const { SyncEngine, HISTORY_CATCHUP_META } = require('../src/main/sync');
const { dayKeyShanghai, dayBoundsShanghai } = require('../src/main/day-tz');
const { readProfileVisits } = require('../src/main/browsers');
const { applyRollbackJournal, isHotJournal } = require('../src/main/sqlengine');

const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 20, 2, 0, 0); // fixed base time

const chromeTime = (ms) => BigInt(ms + CHROME_EPOCH_OFFSET_MS) * 1000n;

class ChromeHistory {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec(`
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER);
    `);
    db.close();
  }

  // Each visit gets the next visits.id, like Chrome.
  visit(url, ms) {
    const db = new Database(this.file);
    let row = db.prepare('SELECT id FROM urls WHERE url = ?').get(url);
    if (!row) {
      const info = db.prepare('INSERT INTO urls (url, title) VALUES (?, ?)').run(url, 'T ' + url);
      row = { id: info.lastInsertRowid };
    }
    db.prepare('INSERT INTO visits (url, visit_time, from_visit) VALUES (?, ?, 0)').run(row.id, chromeTime(ms));
    db.close();
  }
}

function chromeBrowser(historyPath, profile = 'Default') {
  return { id: 'chrome', name: 'Google Chrome', engine: 'chromium', profiles: [{ profile, historyPath }] };
}

function storeRows(store) {
  return store.db.all('SELECT url, visit_time AS t, browser, profile FROM visits ORDER BY visit_time, url');
}

async function runSync(store, browsers, opts = {}) {
  const sync = new SyncEngine(store, { isSyncAllowed: () => true, ...opts });
  sync.browsers = browsers;
  sync.running = true;
  try {
    return await sync.syncOnce(true);
  } finally {
    sync.stop();
  }
}

async function runCatchUp(store, browsers, opts = {}) {
  const sync = new SyncEngine(store, { isSyncAllowed: () => true, ...opts });
  sync.browsers = browsers;
  sync.running = true;
  try {
    return await sync.catchUpFromStart();
  } finally {
    sync.stop();
  }
}

describe('history backfill across app restarts', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-backfill-'));
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
  });

  afterEach(() => {
    try { store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function reopenStore() {
    store.close();
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
  }

  it('imports visits made while TraceHub was closed after a restart, without duplicates', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    hist.visit('https://a.example/', T0);
    hist.visit('https://b.example/', T0 + HOUR);
    const browsers = [chromeBrowser(hist.file)];

    const first = await runSync(store, browsers); // real worker thread
    assert.deepEqual(first.errors, []);
    assert.equal(first.inserted, 2);

    // --- TraceHub closed; the user keeps browsing ---
    await reopenStore();
    hist.visit('https://c.example/', T0 + 5 * HOUR);
    hist.visit('https://a.example/', T0 + 6 * HOUR);
    // Chrome Sync from another device: new id, but an OLDER timestamp.
    hist.visit('https://synced.example/', T0 + 30 * 60000);

    // --- TraceHub starts again ---
    const second = await runSync(store, browsers);
    assert.deepEqual(second.errors, []);
    assert.equal(second.inserted, 3);
    const urls = storeRows(store).map((r) => r.url);
    assert.deepEqual(urls, [
      'https://a.example/', 'https://synced.example/', 'https://b.example/',
      'https://c.example/', 'https://a.example/',
    ]);

    // Manual refresh / next poll: nothing new, nothing duplicated.
    const third = await runSync(store, browsers);
    assert.equal(third.inserted, 0);
    assert.equal(storeRows(store).length, 5);
    assert.deepEqual(store.getSyncCursor('chrome', 'Default'), { visitId: 5, visitTime: T0 + 6 * HOUR });
  });

  it('upgrading from a 1.2.8 store (visits but no cursor) fills the gap with no duplicates', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    for (let i = 0; i < 4; i++) hist.visit(`https://old${i}.example/`, T0 + i * HOUR);
    // What an older build had stored before it stopped syncing.
    store.upsertVisits([0, 1, 2, 3].map((i) => ({
      url: `https://old${i}.example/`, title: 't', visitTime: T0 + i * HOUR, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default',
    })));
    assert.equal(store.getSyncCursor('chrome', 'Default'), null);
    // Days of browsing while sync was broken / the app was closed.
    for (let d = 1; d <= 3; d++) hist.visit(`https://day${d}.example/`, T0 + d * 24 * HOUR);

    const res = await runSync(store, [chromeBrowser(hist.file)]);
    assert.equal(res.inserted, 3);
    assert.equal(storeRows(store).length, 7);
    assert.equal(new Set(storeRows(store).map((r) => r.url + r.t)).size, 7);
  });

  it('pages through more new visits than one read returns, skipping none', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    for (let i = 0; i < 23; i++) hist.visit(`https://p${i}.example/`, T0 + i * 60000);
    const res = await runSync(store, [chromeBrowser(hist.file)], { readOptions: { limit: 5 } });
    assert.equal(res.inserted, 23);
    assert.equal(storeRows(store).length, 23);
  });

  it('keeps cursors per browser profile', async () => {
    const h1 = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    const h2 = new ChromeHistory(path.join(dir, 'chrome', 'Profile 1', 'History'));
    h1.visit('https://one.example/', T0);
    h2.visit('https://two.example/', T0);
    h2.visit('https://two.example/x', T0 + HOUR);
    const browsers = [{ id: 'chrome', name: 'Google Chrome', engine: 'chromium', profiles: [
      { profile: 'Default', historyPath: h1.file },
      { profile: 'Profile 1', historyPath: h2.file },
    ] }];
    assert.equal((await runSync(store, browsers)).inserted, 3);
    assert.equal(store.getSyncCursor('chrome', 'Default').visitId, 1);
    assert.equal(store.getSyncCursor('chrome', 'Profile 1').visitId, 2);
    h1.visit('https://one.example/later', T0 + 2 * HOUR);
    assert.equal((await runSync(store, browsers)).inserted, 1);
    assert.equal(storeRows(store).length, 4);
  });

  it('still imports new visits after the browser history was cleared and ids restart', async () => {
    const file = path.join(dir, 'chrome', 'Default', 'History');
    let hist = new ChromeHistory(file);
    for (let i = 0; i < 5; i++) hist.visit(`https://before${i}.example/`, T0 + i * HOUR);
    assert.equal((await runSync(store, [chromeBrowser(file)])).inserted, 5);
    fs.rmSync(file);
    hist = new ChromeHistory(file); // ids start at 1 again
    hist.visit('https://after.example/', T0 + 10 * HOUR);
    assert.equal((await runSync(store, [chromeBrowser(file)])).inserted, 1);
  });

  it('backfills Firefox places.sqlite the same way', async () => {
    const file = path.join(dir, 'ff', 'abc.default', 'places.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, from_visit INTEGER);
    `);
    const add = (url, ms) => {
      const p = db.prepare('INSERT INTO moz_places (url, title) VALUES (?, ?)').run(url, url);
      db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, from_visit) VALUES (?, ?, 0)').run(p.lastInsertRowid, ms * 1000);
    };
    add('https://ff1.example/', T0);
    const browsers = [{ id: 'firefox', name: 'Mozilla Firefox', engine: 'firefox', profiles: [{ profile: 'abc.default', historyPath: file }] }];
    assert.equal((await runSync(store, browsers)).inserted, 1);
    add('https://ff2.example/', T0 + HOUR);
    db.close();
    await reopenStore();
    assert.equal((await runSync(store, browsers)).inserted, 1);
    assert.equal((await runSync(store, browsers)).inserted, 0);
    assert.deepEqual(storeRows(store).map((r) => r.url), ['https://ff1.example/', 'https://ff2.example/']);
  });
});

describe('reading a history DB that the browser is writing (rollback journal)', () => {
  it('rolls back a hot History-journal so a copied DB shows the last committed state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-journal-'));
    try {
      const file = path.join(dir, 'Default', 'History');
      const hist = new ChromeHistory(file);
      for (let i = 0; i < 3; i++) hist.visit(`https://committed${i}.example/`, T0 + i * HOUR);

      // A writer mid-transaction with a tiny cache spills dirty pages into the
      // main file while the original pages sit in History-journal. Without a
      // rollback, a copy would show rewritten URLs and a vanished visit.
      const writer = new Database(file);
      writer.pragma('journal_mode = DELETE');
      writer.pragma('cache_size = 1');
      writer.exec('BEGIN');
      writer.prepare("UPDATE urls SET url = url || 'dirty', title = 'DIRTY'").run();
      writer.prepare('DELETE FROM visits WHERE id = 1').run();
      const ins = writer.prepare('INSERT INTO urls (url, title) VALUES (?, ?)');
      for (let i = 0; i < 3000; i++) ins.run(`https://uncommitted${i}.example/${'x'.repeat(200)}`, 'u');

      // Snapshot the files exactly as a copy taken right now would see them.
      const snapDir = path.join(dir, 'snap', 'Default');
      fs.mkdirSync(snapDir, { recursive: true });
      fs.copyFileSync(file, path.join(snapDir, 'History'));
      fs.copyFileSync(file + '-journal', path.join(snapDir, 'History-journal'));
      writer.exec('ROLLBACK');
      writer.close();

      const journal = new Uint8Array(fs.readFileSync(path.join(snapDir, 'History-journal')));
      assert.ok(isHotJournal(journal), 'expected a hot journal while the transaction was open');
      const page = await readProfileVisits(
        { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
        { profile: 'Default', historyPath: path.join(snapDir, 'History') },
        { visitId: null, visitTime: 0 }
      );
      assert.ok(page.items.every((i) => i.title !== 'DIRTY'));
      assert.deepEqual(page.items.map((i) => i.url).sort(), [
        'https://committed0.example/', 'https://committed1.example/', 'https://committed2.example/',
      ]);
      assert.equal(page.cursor.visitId, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the image alone when the journal is empty or not hot', () => {
    const img = new Uint8Array([1, 2, 3]);
    assert.equal(applyRollbackJournal(img, new Uint8Array(0)), img);
    assert.equal(applyRollbackJournal(img, new Uint8Array(64)), img);
  });
});

describe('full history catch-up past an existing cursor', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-catchup-'));
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
  });

  afterEach(() => {
    try { store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedGap() {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    // Older visits that never made it into the hub.
    hist.visit('https://gap-a.example/', T0);
    hist.visit('https://gap-b.example/', T0 + HOUR);
    hist.visit('https://gap-c.example/', T0 + 2 * HOUR);
    // Recent visits the previous build did store, with a cursor past the gap.
    hist.visit('https://recent-a.example/', T0 + 10 * 24 * HOUR);
    hist.visit('https://recent-b.example/', T0 + 11 * 24 * HOUR);
    store.upsertVisits([
      { url: 'https://recent-a.example/', title: 't', visitTime: T0 + 10 * 24 * HOUR, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
      { url: 'https://recent-b.example/', title: 't', visitTime: T0 + 11 * 24 * HOUR, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
    ]);
    store.setSyncCursor('chrome', 'Default', { visitId: 5, visitTime: T0 + 11 * 24 * HOUR });
    return hist;
  }

  function uniqueKeys(rows) {
    return new Set(rows.map((r) => `${r.url}|${r.t}|${r.browser}|${r.profile}`));
  }

  it('fills an older gap that a 7-day cursor would skip, with zero duplicates (upgrade auto-run)', async () => {
    const hist = seedGap();
    const browsers = [chromeBrowser(hist.file)];
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), '');
    assert.equal(storeRows(store).length, 2);

    const first = await runSync(store, browsers);
    assert.deepEqual(first.errors, []);
    assert.equal(first.inserted, 3);
    assert.equal(first.catchUp, true);
    assert.equal(first.catchUpDone, true);
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), 'done');
    const rows = storeRows(store);
    assert.equal(rows.length, 5);
    assert.equal(uniqueKeys(rows).size, 5);
    assert.deepEqual(rows.map((r) => r.url), [
      'https://gap-a.example/',
      'https://gap-b.example/',
      'https://gap-c.example/',
      'https://recent-a.example/',
      'https://recent-b.example/',
    ]);

    const second = await runSync(store, browsers);
    assert.equal(second.inserted, 0);
    assert.equal(second.catchUp, false);
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), 'done');
    assert.equal(storeRows(store).length, 5);
  });

  it('manual catch-up fills a later gap, then a second run inserts 0', async () => {
    const hist = seedGap();
    store.setMeta(HISTORY_CATCHUP_META, 'done');
    const browsers = [chromeBrowser(hist.file)];

    // Incremental sync keeps the cursor and therefore misses the older gap.
    const incremental = await runSync(store, browsers);
    assert.equal(incremental.inserted, 0);
    assert.equal(storeRows(store).length, 2);

    const first = await runCatchUp(store, browsers);
    assert.deepEqual(first.errors, []);
    assert.equal(first.inserted, 3);
    assert.equal(first.catchUpDone, true);
    const rows = storeRows(store);
    assert.equal(rows.length, 5);
    assert.equal(uniqueKeys(rows).size, 5);

    const second = await runCatchUp(store, browsers);
    assert.equal(second.inserted, 0);
    assert.equal(second.catchUpDone, true);
    assert.equal(storeRows(store).length, 5);
    assert.equal(uniqueKeys(storeRows(store)).size, 5);
  });

  it('advances cursors during catch-up so a paged scan resumes across ticks', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    for (let i = 0; i < 10; i++) hist.visit(`https://page${i}.example/`, T0 + i * HOUR);
    const browsers = [chromeBrowser(hist.file)];
    const opts = { maxPagesPerSync: 1, readOptions: { limit: 4 } };

    const tick1 = await runSync(store, browsers, opts);
    assert.equal(tick1.inserted, 4);
    assert.equal(tick1.catchUp, true);
    assert.equal(tick1.catchUpDone, false);
    assert.equal(tick1.hasMore, true);
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), 'pending');
    assert.equal(store.getSyncCursor('chrome', 'Default').visitId, 4);
    assert.equal(storeRows(store).length, 4);

    const tick2 = await runSync(store, browsers, opts);
    assert.equal(tick2.inserted, 4);
    assert.equal(tick2.catchUp, true);
    assert.equal(tick2.catchUpDone, false);
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), 'pending');
    assert.equal(store.getSyncCursor('chrome', 'Default').visitId, 8);
    assert.equal(storeRows(store).length, 8);

    const tick3 = await runSync(store, browsers, opts);
    assert.equal(tick3.inserted, 2);
    assert.equal(tick3.catchUpDone, true);
    assert.equal(store.getMeta(HISTORY_CATCHUP_META, ''), 'done');
    assert.equal(storeRows(store).length, 10);
    assert.equal(uniqueKeys(storeRows(store)).size, 10);

    const again = await runCatchUp(store, browsers, opts);
    assert.equal(again.inserted, 0);
    assert.equal(storeRows(store).length, 10);
  });
});

describe('repair a specific calendar day from browser history', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-repair-day-'));
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
  });

  afterEach(() => {
    try { store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function uniqueKeys(rows) {
    return new Set(rows.map((r) => `${r.url}|${r.t}|${r.browser}|${r.profile}`));
  }

  async function engine(browsers, opts = {}) {
    const sync = new SyncEngine(store, { isSyncAllowed: () => true, ...opts });
    sync.browsers = browsers;
    sync.running = true;
    return sync;
  }

  it('fills an old empty day far beyond 7 days without touching later days', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    const oldDayStart = T0; // 2026-11-20 10:00 Asia/Shanghai
    const oldDay = dayKeyShanghai(oldDayStart);
    const recentStart = T0 + 20 * 24 * HOUR; // more than 7 days later
    const recentDay = dayKeyShanghai(recentStart);
    assert.notEqual(oldDay, recentDay);
    hist.visit('https://old-a.example/', oldDayStart);
    hist.visit('https://old-b.example/', oldDayStart + HOUR);
    hist.visit('https://old-c.example/', oldDayStart + 2 * HOUR);
    hist.visit('https://recent-a.example/', recentStart);
    hist.visit('https://recent-b.example/', recentStart + HOUR);
    store.upsertVisits([
      { url: 'https://recent-a.example/', title: 't', visitTime: recentStart, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
      { url: 'https://recent-b.example/', title: 't', visitTime: recentStart + HOUR, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
    ]);
    store.setSyncCursor('chrome', 'Default', { visitId: 5, visitTime: recentStart + HOUR });
    store.setMeta(HISTORY_CATCHUP_META, 'done');
    const browsers = [chromeBrowser(hist.file)];
    const boundsOld = dayBoundsShanghai(oldDay);
    assert.equal(store.countVisitsInRange(boundsOld.start, boundsOld.end), 0);

    const sync = await engine(browsers);
    const incremental = await sync.syncOnce(false);
    assert.equal(incremental.inserted, 0);
    assert.equal(store.countVisitsInRange(boundsOld.start, boundsOld.end), 0);

    const res = await sync.repairDay(oldDay);
    sync.stop();
    assert.deepEqual(res.errors, []);
    assert.equal(res.inserted, 3);
    assert.equal(res.day, oldDay);
    assert.equal(store.countVisitsInRange(boundsOld.start, boundsOld.end), 3);
    const recentBounds = dayBoundsShanghai(recentDay);
    assert.equal(store.countVisitsInRange(recentBounds.start, recentBounds.end), 2);
    assert.equal(storeRows(store).length, 5);
    assert.equal(uniqueKeys(storeRows(store)).size, 5);
  });

  it('repairs a day that already has partial data so the hub matches the browser, keeping extra hub rows', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    const dayStart = T0 + 3 * HOUR; // still 2026-11-20
    const day = dayKeyShanghai(dayStart);
    hist.visit('https://keep-a.example/', dayStart);
    hist.visit('https://miss-b.example/', dayStart + 10 * 60000);
    hist.visit('https://miss-c.example/', dayStart + 20 * 60000);
    hist.visit('https://keep-d.example/', dayStart + 30 * 60000);
    hist.visit('https://miss-e.example/', dayStart + 40 * 60000);
    store.upsertVisits([
      { url: 'https://keep-a.example/', title: 't', visitTime: dayStart, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
      { url: 'https://keep-d.example/', title: 't', visitTime: dayStart + 30 * 60000, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
      // A hub-only row that is no longer in the browser file must be kept.
      { url: 'https://hub-only.example/', title: 't', visitTime: dayStart + 50 * 60000, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
    ]);
    store.setSyncCursor('chrome', 'Default', { visitId: 5, visitTime: dayStart + 40 * 60000 });
    store.setMeta(HISTORY_CATCHUP_META, 'done');
    const bounds = dayBoundsShanghai(day);
    assert.equal(store.countVisitsInRange(bounds.start, bounds.end), 3);

    const sync = await engine([chromeBrowser(hist.file)]);
    const res = await sync.repairDay(day);
    assert.deepEqual(res.errors, []);
    assert.equal(res.inserted, 3);
    assert.equal(store.countVisitsInRange(bounds.start, bounds.end), 6);
    const urls = storeRows(store).map((r) => r.url).sort();
    assert.deepEqual(urls, [
      'https://hub-only.example/',
      'https://keep-a.example/',
      'https://keep-d.example/',
      'https://miss-b.example/',
      'https://miss-c.example/',
      'https://miss-e.example/',
    ]);
    assert.equal(uniqueKeys(storeRows(store)).size, 6);

    const second = await sync.repairDay(day);
    sync.stop();
    assert.equal(second.inserted, 0);
    assert.equal(store.countVisitsInRange(bounds.start, bounds.end), 6);
    assert.equal(uniqueKeys(storeRows(store)).size, 6);
  });

  it('full catch-up also fills an old empty day, and a second run inserts 0', async () => {
    const hist = new ChromeHistory(path.join(dir, 'chrome', 'Default', 'History'));
    const oldDay = dayKeyShanghai(T0);
    hist.visit('https://ancient.example/', T0);
    hist.visit('https://recent.example/', T0 + 20 * 24 * HOUR);
    store.upsertVisits([
      { url: 'https://recent.example/', title: 't', visitTime: T0 + 20 * 24 * HOUR, browser: 'chrome', browserName: 'Google Chrome', profile: 'Default' },
    ]);
    store.setSyncCursor('chrome', 'Default', { visitId: 2, visitTime: T0 + 20 * 24 * HOUR });
    store.setMeta(HISTORY_CATCHUP_META, 'done');
    const sync = await engine([chromeBrowser(hist.file)]);
    const first = await sync.catchUpFromStart();
    assert.equal(first.inserted, 1);
    assert.ok(first.repairedDays.includes(oldDay));
    assert.equal(storeRows(store).length, 2);
    const second = await sync.catchUpFromStart();
    sync.stop();
    assert.equal(second.inserted, 0);
    assert.equal(storeRows(store).length, 2);
    assert.equal(uniqueKeys(storeRows(store)).size, 2);
  });
});
