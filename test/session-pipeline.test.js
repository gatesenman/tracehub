'use strict';

/**
 * Preview → save → window-reopen (launcher stub) → refuse close.
 * Uses an in-memory FS and a synthetic SNSS fixture. Does not read a real
 * user Chrome profile, spawn a browser, or treat source-string checks as the
 * whole test: it asserts stored origin, launch arguments, and close rejection.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const snap = require('../src/main/snapshot-store');
const { registerSnapshotIpc } = require('../src/main/snapshot-service');
const sessionFile = require('../src/main/session-file-service');
const core = require('../src/shared/snapshot-core');
const { sampleTwoWindows } = require('./helpers/snss-build');
const { memoryIO } = require('./helpers/memory-fs');

class FakeIpc {
  constructor() { this.handlers = new Map(); }
  handle(name, fn) {
    if (this.handlers.has(name)) throw new Error('duplicate ipc ' + name);
    this.handlers.set(name, fn);
  }
  invoke(name, payload) {
    const fn = this.handlers.get(name);
    if (!fn) throw new Error('missing handler ' + name);
    return fn({}, payload);
  }
}

const ROOT = '/fake/Chrome/User Data';
const SESSION = ROOT + '/Default/Sessions/Session_4242';
const MTIME = Date.parse('2026-11-20T15:04:00+08:00');

describe('session-file preview-save-reopen-close chain', () => {
  let dir, store, ipc, launches;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-session-pipe-'));
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
    snap.migrateSnapshotTables(store.db);
    launches = [];
    const io = memoryIO({
      [SESSION]: { buf: sampleTwoWindows(), mtime: MTIME },
    });
    sessionFile.setSessionFileRuntime({
      io,
      roots: [{ id: 'chrome', name: 'Google Chrome', base: ROOT }],
      resolveExeFn: () => '/stub/google-chrome',
      spawnFn: async (exe, args) => {
        launches.push({ exe, args });
        return { ok: true };
      },
    });
    ipc = new FakeIpc();
    registerSnapshotIpc({
      ipcMain: ipc,
      store,
      config: { get: () => ({ bridgeEnabled: false, bridgePort: 0, bridgeToken: '' }) },
      getBridge: () => null,
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
      shell: { openExternal: async () => {}, openPath: async () => '' },
      ai: { hasKey: () => false },
      getMainWindow: () => null,
      app: { isPackaged: false },
      getSync: () => null,
    });
  });

  afterEach(() => {
    sessionFile.clearSessionFileRuntime();
    try { if (store) store.close(); } catch (e) { /* ignore */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists, previews, saves origin, reopens by window via stub, and refuses close even with forged tab ids', async () => {
    const listed = await ipc.invoke('sessionfile:list-profiles');
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.profiles.map((p) => p.key), ['chrome::Default']);
    assert.ok(!JSON.stringify(listed).includes(ROOT));

    const preview = await ipc.invoke('sessionfile:preview', { key: 'chrome::Default' });
    assert.equal(preview.ok, true);
    assert.equal(preview.tabCount, 3);
    assert.equal(preview.windowCount, 2);
    assert.equal(preview.windows[0].tabs[0].pinned, true);
    assert.equal(preview.windows[0].tabs[0].tabId, null);
    assert.equal(preview.origin.sourceFileBase, 'Session_4242');
    assert.equal(preview.origin.sourceMtime, MTIME);
    assert.match(preview.honesty, /会话文件/);
    assert.ok(preview.previewId);
    assert.ok(!JSON.stringify(preview).includes(ROOT));

    const unconfirmed = await ipc.invoke('sessionfile:save', { previewId: preview.previewId, confirmed: false });
    assert.equal(unconfirmed.ok, false);

    const savedWrap = await ipc.invoke('sessionfile:save', { previewId: preview.previewId, confirmed: true });
    assert.equal(savedWrap.ok, true);
    const saved = snap.getSnapshot(store, savedWrap.snapshot.id);
    assert.equal(saved.source, 'session-file');
    assert.equal(saved.persisted, true);
    assert.equal(saved.tabCount, 3);
    assert.equal(saved.windows.length, 2);
    assert.equal(saved.windows[0].windowIndex, 0);
    assert.equal(saved.windows[0].tabs[0].pinned, true);
    assert.equal(saved.windows[0].tabs[0].tabId, null);
    assert.equal(saved.windows[1].tabs[0].url, 'https://www.bilibili.com/');
    assert.equal(saved.origin.stale, false);
    assert.equal(saved.origin.sourceFileBase, 'Session_4242');
    assert.ok(!JSON.stringify(saved.origin).includes('/fake/Chrome'));
    const listedSaved = snap.listSnapshots(store);
    assert.equal(listedSaved[0].origin.sourceFileBase, 'Session_4242');

    const exported = sessionFile.exportableSnapshot(saved);
    assert.equal(exported.source, 'session-file');
    assert.equal(exported.origin.sourceFileBase, 'Session_4242');
    assert.ok(!JSON.stringify(exported).includes(ROOT));
    assert.ok(exported.windows.every((w) => w.tabs.every((t) => t.tabId == null)));

    const gate = core.assertCloseable(saved, { userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(gate.ok, false);
    assert.match(gate.error, /不能按 tabId 关闭/);

    // Forge chrome tabIds in storage; close must still be refused and must not enqueue work.
    for (const t of snap.getSnapshot(store, saved.id).windows.flatMap((w) => w.tabs)) {
      store.db.run('UPDATE snapshot_tabs SET tab_id = ? WHERE id = ?', [9000 + Math.floor(Math.random() * 100), t.id]);
    }
    const forged = snap.getSnapshot(store, saved.id);
    assert.ok(forged.windows[0].tabs.some((t) => t.tabId != null));
    const close = await ipc.invoke('snapshot:request-close', {
      id: forged.id, userConfirmed: true, ackUnsavedRisk: true,
    });
    assert.equal(close.ok, false);
    assert.equal(close.closeable, false);
    assert.match(close.error, /会话文件快照不能按 tabId 关闭|不会发出关闭指令/);
    const after = snap.getSnapshot(store, saved.id);
    assert.equal(after.closeStatus, 'none');

    const restore = await ipc.invoke('snapshot:restore-batch', {
      id: saved.id, skipDuplicates: false, batchSize: 8, offset: 0, confirmed: true,
    });
    assert.equal(restore.ok, true);
    assert.equal(restore.pending, false);
    assert.equal(restore.via, 'session-file-window-reopen');
    assert.notEqual(restore.via, 'extension');
    assert.equal(launches.length, 2);
    assert.equal(launches[0].exe, '/stub/google-chrome');
    assert.deepEqual(launches[0].args.slice(0, 2), ['--profile-directory=Default', '--new-window']);
    assert.ok(launches[0].args.includes('https://github.com/electron/electron'));
    assert.ok(launches[1].args.includes('https://www.bilibili.com/'));
    assert.ok(!launches.some((c) => c.args.some((a) => String(a).includes('remote-debugging') || String(a).includes('load-extension'))));
    assert.match(restore.message, /不是扩展按布局恢复/);
    const reopened = snap.getSnapshot(store, saved.id);
    assert.ok(reopened.windows.flatMap((w) => w.tabs).filter((t) => t.restorable).every((t) => t.restoreStatus === 'opened'));
  });
});
