'use strict';

/**
 * Integration tests: temp SQLite + real HTTP tab-bridge + snapshot IPC
 * handlers (no Electron). A Node stand-in is used for the extension client.
 * These are NOT real Chrome / real browser GUI tests.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store } = require('../src/main/store');
const snap = require('../src/main/snapshot-store');
const core = require('../src/shared/snapshot-core');
const guard = require('../src/shared/close-guard');
const { TabBridge } = require('../src/main/tab-bridge');
const { registerSnapshotIpc } = require('../src/main/snapshot-service');
const { isSqliteFile, restoreDatabase } = require('../src/main/backup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-int-'));
const dbPath = path.join(dir, 'hub.sqlite');
const TOKEN = 'integration-token-xyz';

let store;
let bridge;
let port;
let ipc;

class FakeIpc {
  constructor() { this.handlers = new Map(); }
  handle(name, fn) {
    if (this.handlers.has(name)) throw new Error('duplicate ipc handler: ' + name);
    this.handlers.set(name, fn);
  }
  invoke(name, payload) {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error('missing handler ' + name);
    return fn({}, payload);
  }
}

function req(pathname, { method = 'GET', token = TOKEN, origin = 'chrome-extension://ext-aaa', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (origin) h.Origin = origin;
    if (token) h['X-TraceHub-Token'] = token;
    if (payload) h['Content-Type'] = 'application/json';
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function liveTabsPayload() {
  return {
    source: 'extension',
    capturedAt: Date.now(),
    extensionId: 'ext-aaa',
    browser: { id: 'edge', name: 'Microsoft Edge', profile: 'Default' },
    windows: [
      {
        windowId: 1,
        focused: true,
        state: 'maximized',
        tabs: [
          { tabId: 11, index: 0, url: 'https://docs.example/a', title: 'Docs', pinned: true, groupId: 4, groupTitle: '工作', groupColor: 'blue' },
          { tabId: 12, index: 1, url: 'https://app.example/edit', title: 'Editor' },
          { tabId: 13, index: 2, url: 'javascript:alert(1)', title: 'bad' },
        ],
      },
    ],
  };
}

describe('integration: store + HTTP bridge + snapshot IPC', () => {
  before(async () => {
    store = new Store(dbPath);
    await store.init();
    const config = { get: () => ({ bridgeEnabled: true, bridgePort: 0, bridgeToken: TOKEN }), update() {} };
    // startBridge uses config.get().bridgePort || 17862, so construct TabBridge via startBridge after patching?
    // Use startBridge with a free port: we pass 0 through a custom wrapper.
    bridge = new TabBridge({
      port: 0,
      getToken: () => TOKEN,
      onSnapshot: async (raw, meta) => {
        try {
          const saved = snap.saveSnapshot(store, raw, {
            source: 'extension',
            browserId: meta && meta.browserId,
            extensionId: meta && meta.extensionId,
            audienceBrowser: meta && meta.browserId,
          });
          return { ok: true, snapshotId: saved.id, tabCount: saved.tabCount };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      },
      onCommandResult: async (body) => {
        if (body && body.type === 'close' && body.snapshotId) {
          const skipped = (body.skipped || []).length;
          const failed = (body.failed || []).length;
          const status = body.ok && !failed && !skipped ? 'done' : (body.closedCount ? 'partial' : 'failed');
          snap.setCloseStatus(store, body.snapshotId, status, body.message || '');
        }
      },
    });
    port = await bridge.start();
    ipc = new FakeIpc();
    registerSnapshotIpc({
      ipcMain: ipc,
      store,
      config: { get: () => ({ bridgeToken: TOKEN, bridgePort: port }), update() { return this.get(); } },
      getBridge: () => bridge,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
      shell: { openPath: async () => '', openExternal: async () => {} },
      ai: { chat: async () => { throw new Error('AI disabled in tests'); } },
      getMainWindow: () => null,
      app: { isPackaged: false },
      getSync: () => null,
    });
  });

  after(async () => {
    try { if (bridge) await bridge.stop(); } catch (e) { /* ignore */ }
    try { if (store) store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an empty pairing token and a browser null Origin', async () => {
    const orig = bridge.getToken;
    bridge.getToken = () => '';
    try {
      const r = await req('/v1/pair', { method: 'POST', token: '', body: { extensionId: 'ext-aaa' } });
      assert.equal(r.status, 401);
    } finally {
      bridge.getToken = orig;
    }
    const n = await req('/v1/pair', { method: 'POST', origin: 'null', body: { extensionId: 'ext-aaa' } });
    assert.equal(n.status, 403);
  });

  it('saves a live snapshot over the bridge, then re-reads pinned/group/order after a store reopen', async () => {
    const r = await req('/v1/snapshot', {
      method: 'POST',
      headers: { 'X-Extension-Id': 'ext-aaa' },
      body: liveTabsPayload(),
    });
    assert.equal(r.status, 200, r.json && r.json.error);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.snapshotId);
    const id = r.json.snapshotId;
    const first = snap.getSnapshot(store, id);
    assert.equal(first.persisted, true);
    assert.equal(first.extensionId, 'ext-aaa');
    assert.equal(first.windows[0].tabs[0].pinned, true);
    assert.equal(first.windows[0].tabs[0].groupTitle, '工作');
    assert.equal(first.windows[0].tabs[1].tabIndex, 1);
    store.save();
    const store2 = new Store(dbPath);
    await store2.init();
    const again = snap.getSnapshot(store2, id);
    assert.equal(again.extensionId, 'ext-aaa');
    assert.equal(again.windows[0].tabs[0].pinned, true);
    assert.equal(again.windows[0].tabs[0].groupTitle, '工作');
    assert.equal(again.windows[0].state, 'maximized');
    assert.equal(again.windows[0].tabs.map((t) => t.url)[0], 'https://docs.example/a');
    store2.close();
  });

  it('does not enqueue a close when persist/confirm/ack is missing or the snapshot is a file import', async () => {
    const denied = await ipc.invoke('snapshot:request-close', { id: 'missing', userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(denied.ok, false);
    const imported = await ipc.invoke('snapshot:import', liveTabsPayload());
    assert.equal(imported.ok, true);
    assert.equal(imported.snapshot.source, 'file-import');
    const closeImp = await ipc.invoke('snapshot:request-close', { id: imported.snapshot.id, userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(closeImp.ok, false);
    assert.match(closeImp.error, /导入|扩展/);
    assert.equal(bridge.hasPendingFor(imported.snapshot.id, 'close'), false);
    const noAck = await ipc.invoke('snapshot:request-close', { id: imported.snapshot.id, userConfirmed: true, ackUnsavedRisk: false });
    assert.equal(noAck.ok, false);
  });

  it('scopes close commands to the originating extension and does not re-deliver or leak to another profile', async () => {
    const list = snap.listSnapshots(store).filter((s) => s.source === 'extension');
    assert.ok(list.length);
    const id = list[0].id;
    const close = await ipc.invoke('snapshot:request-close', { id, userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(close.ok, true, close.error);
    const wrong = await req('/v1/pending', { headers: { 'X-Extension-Id': 'ext-other', 'X-TraceHub-Browser': 'edge' } });
    assert.equal((wrong.json.commands || []).length, 0);
    const noId = await req('/v1/pending', { headers: { 'X-TraceHub-Browser': 'edge' } });
    assert.equal((noId.json.commands || []).length, 0);
    const right = await req('/v1/pending', { headers: { 'X-Extension-Id': 'ext-aaa', 'X-TraceHub-Browser': 'edge' } });
    assert.equal(right.json.commands.length, 1);
    const cmd = right.json.commands[0];
    assert.equal(cmd.type, 'close');
    assert.ok(Array.isArray(cmd.payload.expectedTabs));
    assert.ok(cmd.payload.expectedTabs.every((t) => t.tabId && t.url));
    const again = await req('/v1/pending', { headers: { 'X-Extension-Id': 'ext-aaa', 'X-TraceHub-Browser': 'edge' } });
    assert.equal(again.json.commands.length, 0);
  });

  it('drops expired close commands and cancelled commands', async () => {
    const id = snap.listSnapshots(store).find((s) => s.source === 'extension').id;
    const cmd = bridge.enqueueCommand('close', {
      snapshotId: id,
      expectedTabs: [{ tabId: 11, url: 'https://docs.example/a' }],
    }, { extensionId: 'ext-aaa', browserId: 'edge' });
    cmd.createdAt = Date.now() - 4 * 60 * 1000;
    cmd.expiresAt = cmd.createdAt + 3 * 60 * 1000;
    const r = await req('/v1/pending', { headers: { 'X-Extension-Id': 'ext-aaa', 'X-TraceHub-Browser': 'edge' } });
    assert.equal((r.json.commands || []).length, 0);
    assert.ok((r.json.expired || []).includes(cmd.id));

    const fresh = await ipc.invoke('snapshot:request-close', { id, userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(fresh.ok, true);
    const cancelled = await ipc.invoke('snapshot:cancel-close', id);
    assert.equal(cancelled.ok, true);
    const after = await req('/v1/pending', { headers: { 'X-Extension-Id': 'ext-aaa', 'X-TraceHub-Browser': 'edge' } });
    assert.equal((after.json.commands || []).length, 0);
  });

  it('simulates the extension close planner: URL change / missing tab is skipped, not closed', async () => {
    const expectedTabs = [
      { tabId: 11, url: 'https://docs.example/a' },
      { tabId: 12, url: 'https://app.example/edit' },
    ];
    // Restart reused tabId 11 for a different page; 12 still matches.
    const live = [
      { id: 11, url: 'https://unrelated.example/' },
      { id: 12, url: 'https://app.example/edit' },
    ];
    const plan = guard.planCloseTargets(expectedTabs, live);
    assert.equal(plan.closable.length, 1);
    assert.equal(plan.closable[0].expected.tabId, 12);
    assert.equal(plan.skipped[0].reason, 'url-changed');
  });

  it('restore plan/batch only includes safe http(s) URLs and rejects file-import close still', async () => {
    const imported = await ipc.invoke('snapshot:import', {
      source: 'file-import',
      windows: [{ tabs: [
        { url: 'https://safe.example/', title: 'ok' },
        { url: 'javascript:alert(1)', title: 'xss' },
        { url: 'file:///tmp/x', title: 'file' },
      ] }],
    });
    assert.equal(imported.ok, true);
    const plan = await ipc.invoke('snapshot:restore-plan', { id: imported.snapshot.id, batchSize: 8, offset: 0 });
    assert.equal(plan.ok, true);
    const urls = plan.plan.batch.map((t) => t.url);
    assert.deepEqual(urls, ['https://safe.example/']);
    assert.ok(plan.plan.unrestorableSkipped >= 2);
  });

  it('rejects a corrupt backup and leaves the live database untouched', async () => {
    store.save();
    const live = dbPath;
    const before = fs.readFileSync(live);
    const bad = path.join(dir, 'not-a-db.bak');
    fs.writeFileSync(bad, 'this is not sqlite');
    assert.equal(isSqliteFile(bad), false);
    assert.throws(() => restoreDatabase(live, bad, { safetyDir: dir }), /SQLite|有效/);
    assert.ok(fs.readFileSync(live).equals(before));
  });

  it('restores a valid sqlite backup after writing a safety copy', async () => {
    const other = path.join(dir, 'good-backup.sqlite');
    const { Database } = (() => ({ Database: require('better-sqlite3') }))();
    const db = new Database(other);
    db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (42);');
    db.close();
    assert.equal(isSqliteFile(other), true);
    const result = restoreDatabase(path.join(dir, 'target.sqlite'), other, { safetyDir: dir });
    assert.equal(result.ok, true);
    assert.equal(isSqliteFile(path.join(dir, 'target.sqlite')), true);
  });

  it('marks leftover unread read-later items as done when they are also bookmarks, once', async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-rl-'));
    const p = path.join(freshDir, 'hub.sqlite');
    const Database = require('better-sqlite3');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE bookmarks (url TEXT PRIMARY KEY, title TEXT, note TEXT, created_at INTEGER);
      CREATE TABLE read_later (url TEXT PRIMARY KEY, title TEXT, added_at INTEGER, done_at INTEGER);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO bookmarks(url, title, created_at) VALUES('https://both.example', 'both', 1);
      INSERT INTO read_later(url, title, added_at, done_at) VALUES('https://both.example', 'both', 1, NULL);
      INSERT INTO read_later(url, title, added_at, done_at) VALUES('https://only-later.example', 'later', 1, NULL);
    `);
    raw.close();
    const s = new Store(p);
    await s.init();
    const rows = require('../src/main/sqlengine').queryAll(s.db, 'SELECT url, done_at FROM read_later ORDER BY url');
    const byUrl = Object.fromEntries(rows.map((r) => [r.url, r.done_at]));
    assert.ok(byUrl['https://both.example']);
    assert.equal(byUrl['https://only-later.example'], null);
    const again = s.migrateDecoupleReadLater();
    assert.equal(again, 0);
    s.close();
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('deleteByDomain removes visits and site caches but keeps bookmarks', async () => {
    store.upsertVisits([{ url: 'https://drop.example/a', title: 'x', visitTime: Date.now(), browser: 'edge', profile: 'Default' }]);
    store.addBookmark('https://drop.example/a', 'keep');
    store.db.run('INSERT OR REPLACE INTO site_meta(url, description, fetched_at) VALUES(?, ?, ?)', ['https://drop.example/a', 'meta', Date.now()]);
    const n = store.deleteByDomain('drop.example');
    assert.ok(n >= 1);
    const visits = require('../src/main/sqlengine').queryAll(store.db, "SELECT * FROM visits WHERE url LIKE '%drop.example%'");
    const meta = require('../src/main/sqlengine').queryAll(store.db, "SELECT * FROM site_meta WHERE url LIKE '%drop.example%'");
    const bms = require('../src/main/sqlengine').queryAll(store.db, "SELECT * FROM bookmarks WHERE url LIKE '%drop.example%'");
    assert.equal(visits.length, 0);
    assert.equal(meta.length, 0);
    assert.equal(bms.length, 1);
  });

  it('IPC channel names used for 时光机 vs tab snapshots do not collide in source', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
    const pre = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
    assert.match(main, /pageshot:get/);
    assert.doesNotMatch(main, /ipcMain\.handle\('snapshot:get'/);
    assert.match(pre, /pageshot:get/);
    assert.match(pre, /snapshotGet:.*snapshot:get/);
  });
});
