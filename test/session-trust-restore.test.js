'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/main/store');
const snap = require('../src/main/snapshot-store');
const core = require('../src/shared/snapshot-core');
const sessionFile = require('../src/main/session-file-service');
const reopen = require('../src/shared/session-reopen');
const ui = require('../src/renderer/session-file-ui');
const { restoreDatabase, isSqliteFile } = require('../src/main/backup');
const { honestyNote } = require('../src/shared/session-files');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-trust-'));
const dbPath = path.join(dir, 'hub.sqlite');
let store;

function sessionPayload(overrides = {}) {
  return {
    source: 'session-file',
    capturedAt: Date.now(),
    browser: { id: 'chrome', name: 'Google Chrome', profile: 'Default' },
    origin: {
      source: 'session-file',
      lastSession: true,
      racy: true,
      locked: false,
      stale: false,
      sourceMtime: Date.parse('2026-11-20T12:00:00+08:00'),
      sourceFileBase: 'Last Session',
      sourcePath: '/home/someone/.config/google-chrome/Default/Last Session',
      truncated: false,
      hasMarker: true,
    },
    windows: [
      {
        windowId: 1,
        tabs: [
          { tabId: 99, index: 0, url: 'https://kept.example/', title: 'Kept' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('source trust, origin persistence, backup, large reopen confirm', () => {
  before(async () => {
    store = new Store(dbPath);
    await store.init();
    snap.migrateSnapshotTables(store.db);
  });

  after(() => {
    try { if (store) store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('import of a JSON that claims to be an extension cannot become a closeable extension snapshot', () => {
    const raw = {
      source: 'extension',
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      capturedAt: Date.now(),
      browser: { id: 'chrome', name: 'Google Chrome', profile: 'Default' },
      windows: [{ windowId: 1, tabs: [{ tabId: 4242, index: 0, url: 'https://forged.example/', title: 'x' }] }],
    };
    // Same rule as snapshot:import IPC: never honor source=extension from a file.
    const source = raw.source === 'session-file' ? 'session-file' : 'file-import';
    const saved = snap.saveSnapshot(store, raw, { source, origin: raw.origin, extensionId: raw.extensionId });
    assert.equal(saved.source, 'file-import');
    assert.equal(saved.extensionId, '');
    assert.equal(core.canPreciseClose(saved), false);
    const gate = core.assertCloseable(saved, { userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(gate.ok, false);
    assert.match(gate.error, /不能按 tabId 关闭|导入/);
  });

  it('sanitizeOrigin never keeps a full filesystem path and preserves honesty flags', () => {
    const origin = core.sanitizeOrigin({
      path: '/home/someone/.config/google-chrome/Default/Sessions/Session_123',
      lastSession: true,
      racy: true,
      hasMarker: true,
      legacyVersion: false,
      incompleteNewest: false,
      sourceMtime: 1,
    });
    assert.equal(origin.sourceFileBase, 'Session_123');
    assert.ok(!JSON.stringify(origin).includes('/home/someone'));
    assert.equal(origin.lastSession, true);
    assert.equal(origin.racy, true);
    assert.equal(origin.hasMarker, true);
  });

  it('saved session-file origin flags survive hydrate, honesty text, and sqlite backup restore', () => {
    const saved = snap.saveSnapshot(store, sessionPayload(), { source: 'session-file' });
    assert.equal(saved.source, 'session-file');
    assert.equal(saved.windows[0].tabs[0].tabId, null);
    assert.equal(saved.origin.lastSession, true);
    assert.equal(saved.origin.racy, true);
    assert.equal(saved.origin.sourceFileBase, 'Last Session');
    assert.ok(!JSON.stringify(saved.origin).includes('/home/someone'));
    assert.match(honestyNote(saved.origin), /上次会话|读盘过程中|竞态/);
    assert.match(ui.sourceBadgeText(saved), /上次会话/);

    const again = snap.getSnapshot(store, saved.id);
    assert.equal(again.origin.lastSession, true);
    assert.equal(again.origin.racy, true);
    assert.match(honestyNote(again.origin), /上次会话|读盘过程中|竞态/);

    store.save();
    const backup = path.join(dir, 'origin-backup.sqlite');
    fs.copyFileSync(dbPath, backup);
    assert.equal(isSqliteFile(backup), true);

    // Wipe the live row by saving over a new db file restore path.
    const live2 = path.join(dir, 'restored.sqlite');
    const result = restoreDatabase(live2, backup, { safetyDir: dir });
    assert.equal(result.ok, true);
    const store2 = new Store(live2);
    // init/migrate then read
    return store2.init().then(() => {
      snap.migrateSnapshotTables(store2.db);
      const restored = snap.getSnapshot(store2, saved.id);
      assert.ok(restored);
      assert.equal(restored.source, 'session-file');
      assert.equal(restored.origin.lastSession, true);
      assert.equal(restored.origin.racy, true);
      assert.equal(restored.origin.sourceFileBase, 'Last Session');
      assert.match(honestyNote(restored.origin), /上次会话|读盘过程中|竞态/);
      store2.close();
    });
  });

  it('opening a pre-origin-column sqlite still migrates and can save a session-file snapshot', async () => {
    const oldPath = path.join(dir, 'legacy.sqlite');
    const Database = require('better-sqlite3');
    const raw = new Database(oldPath);
    raw.exec(`
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        title TEXT,
        source TEXT,
        browser_id TEXT,
        browser_name TEXT,
        profile TEXT,
        persisted INTEGER,
        close_status TEXT,
        close_error TEXT,
        close_confirmed_at INTEGER,
        ai_status TEXT,
        ai_error TEXT,
        tab_count INTEGER,
        raw_json TEXT
      );
      CREATE TABLE snapshot_windows (
        id TEXT PRIMARY KEY, snapshot_id TEXT, window_id INTEGER, window_index INTEGER,
        focused INTEGER, incognito INTEGER, type TEXT, state TEXT,
        left INTEGER, top INTEGER, width INTEGER, height INTEGER
      );
      CREATE TABLE snapshot_tabs (
        id TEXT PRIMARY KEY, snapshot_id TEXT, window_row_id TEXT, tab_id INTEGER, tab_index INTEGER,
        url TEXT, title TEXT, pinned INTEGER, active INTEGER, discarded INTEGER, incognito INTEGER,
        favicon TEXT, group_id INTEGER, group_title TEXT, group_color TEXT, domain TEXT, restorable INTEGER,
        category TEXT, tags TEXT, purpose TEXT, summary TEXT, user_group TEXT, hidden_dup INTEGER,
        restore_status TEXT, restore_error TEXT
      );
    `);
    raw.close();
    const legacy = new Store(oldPath);
    await legacy.init();
    snap.migrateSnapshotTables(legacy.db);
    const saved = snap.saveSnapshot(legacy, sessionPayload(), { source: 'session-file' });
    assert.equal(saved.origin.lastSession, true);
    const got = snap.getSnapshot(legacy, saved.id);
    assert.equal(got.origin.racy, true);
    legacy.close();
  });

  it('plans need a second confirm at 30+ urls and refuse restore until largeConfirmed', async () => {
    const tabs = [];
    for (let i = 0; i < 32; i += 1) tabs.push({ tabId: null, index: i, url: `https://bulk.example/${i}`, title: 't' + i });
    const snapshot = {
      source: 'session-file',
      title: 'bulk',
      browserId: 'chrome',
      profile: 'Default',
      windows: [{ windowIndex: 0, windowId: 1, tabs }],
    };
    const plan = reopen.planWindowReopen(snapshot);
    assert.equal(plan.urlCount, 32);
    assert.equal(plan.needsSecondConfirm, true);
    assert.match(plan.secondConfirmText, /再次确认|数量较多/);
    assert.equal(ui.needsLargeReopenConfirm(plan), true);
    assert.match(ui.largeReopenConfirmText(plan), /32/);

    const refused = await sessionFile.restoreSessionFileSnapshot(snapshot, {
      largeConfirmed: false,
      resolveExeFn: () => '/usr/bin/google-chrome',
      spawnFn: async () => { throw new Error('should not spawn'); },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.needsSecondConfirm, true);

    const calls = [];
    const ok = await sessionFile.restoreSessionFileSnapshot(snapshot, {
      largeConfirmed: true,
      resolveExeFn: () => '/usr/bin/google-chrome',
      spawnFn: async (exe, args) => { calls.push({ exe, args }); return { ok: true }; },
    });
    assert.equal(ok.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.filter((a) => /^https:/.test(a)).length, 32);
  });

  it('restore plan for a small session-file snapshot does not require a second confirm', () => {
    const plan = reopen.planWindowReopen({
      source: 'session-file',
      windows: [{ tabs: [{ url: 'https://one.example/' }, { url: 'https://two.example/' }] }],
    });
    assert.equal(plan.needsSecondConfirm, false);
    assert.equal(ui.needsLargeReopenConfirm(plan), false);
  });
});
