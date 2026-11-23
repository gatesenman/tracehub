'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/main/store');
const snap = require('../src/main/snapshot-store');
const core = require('../src/shared/snapshot-core');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-snap-'));
const dbPath = path.join(dir, 'hub.sqlite');
let store;

function payload() {
  return {
    source: 'extension',
    capturedAt: Date.now(),
    browser: { id: 'edge', name: 'Microsoft Edge', profile: 'Profile 1' },
    windows: [
      {
        windowId: 7,
        focused: true,
        tabs: [
          { tabId: 1, index: 0, url: 'https://docs.python.org/3/', title: 'Python docs', pinned: true },
          { tabId: 2, index: 1, url: 'https://example.com/app', title: 'App' },
        ],
      },
    ],
  };
}

describe('snapshot store persistence', () => {
  before(async () => {
    store = new Store(dbPath);
    await store.init();
    snap.migrateSnapshotTables(store.db);
  });

  after(() => {
    try { if (store) store.close(); } catch (e) { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('commits persisted=1 only after a successful transaction, then close is allowed', () => {
    const saved = snap.saveSnapshot(store, payload());
    assert.equal(saved.persisted, true);
    assert.equal(saved.tabCount, 2);
    assert.equal(saved.browserName, 'Microsoft Edge');
    assert.equal(saved.profile, 'Profile 1');
    assert.equal(saved.windows[0].tabs[0].pinned, true);
    assert.equal(saved.windows[0].tabs[0].category, '开发/文档');
    const gate = core.assertCloseable(saved, { userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(gate.ok, true);
    const listed = snap.listSnapshots(store);
    assert.equal(listed.some((s) => s.id === saved.id), true);
  });

  it('does not persist or allow close when the payload is empty or malformed', () => {
    assert.throws(() => snap.saveSnapshot(store, { windows: [] }), /空快照|畸形/);
    assert.throws(() => snap.saveSnapshot(store, { windows: [{ tabs: [{ url: '' }] }] }), /url/);
    const before = snap.listSnapshots(store).length;
    try { snap.saveSnapshot(store, null); } catch (e) { /* expected */ }
    assert.equal(snap.listSnapshots(store).length, before);
  });

  it('rollback path: a mid-write failure must not leave a closeable snapshot', () => {
    const beforeIds = new Set(snap.listSnapshots(store).map((s) => s.id));
    const realRun = store.db.run.bind(store.db);
    let inserts = 0;
    store.db.run = (sql, params) => {
      const text = String(sql);
      if (/INSERT INTO snapshot_tabs/i.test(text)) {
        inserts += 1;
        if (inserts >= 2) throw new Error('simulated disk full');
      }
      return realRun(sql, params);
    };
    try {
      assert.throws(() => snap.saveSnapshot(store, payload()), /simulated disk full/);
    } finally {
      store.db.run = realRun;
    }
    const after = snap.listSnapshots(store);
    assert.equal(after.every((s) => beforeIds.has(s.id) || !s.persisted === false), true);
    // No new persisted snapshot should appear.
    assert.equal(after.filter((s) => !beforeIds.has(s.id)).length, 0);
    // And no orphan persisted=1 row with missing tabs.
    const rows = store.db.all('SELECT id, persisted, tab_count FROM snapshots');
    for (const r of rows) {
      if (r.persisted) {
        const tabs = store.db.all('SELECT COUNT(*) AS c FROM snapshot_tabs WHERE snapshot_id = ?', [r.id]);
        assert.equal(Number(tabs[0].c), Number(r.tab_count));
      }
    }
  });

  it('user cancel does not close anything; status is retained', () => {
    const saved = snap.saveSnapshot(store, payload());
    const cancelled = snap.setCloseStatus(store, saved.id, 'cancelled', '用户取消');
    assert.equal(cancelled.closeStatus, 'cancelled');
    const gate = core.assertCloseable(cancelled, { userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(gate.ok, false);
  });

  it('AI failure keeps local classification and every tab', () => {
    const saved = snap.saveSnapshot(store, payload());
    const local = core.flattenTabs(saved);
    const merged = core.mergeAiResults(local, [], { failed: true, error: 'AI 超时' });
    snap.setAiStatus(store, saved.id, 'failed', merged.error);
    const patched = snap.applyTabPatches(store, saved.id, merged.tabs);
    assert.equal(patched.aiStatus, 'failed');
    assert.equal(patched.tabCount, 2);
    assert.ok(patched.windows[0].tabs[0].category);
  });

  it('restore statuses survive on the tab rows', () => {
    const saved = snap.saveSnapshot(store, payload());
    const tab = saved.windows[0].tabs[0];
    snap.updateTabMeta(store, tab.id, { restoreStatus: 'failed', restoreError: 'extension offline' });
    const again = snap.getSnapshot(store, saved.id);
    assert.equal(again.windows[0].tabs[0].restoreStatus, 'failed');
    assert.equal(again.windows[0].tabs[1].restoreStatus, 'none');
  });

  it('marks pending closes and queued restores as failed after a restart, with an honest reason', () => {
    const saved = snap.saveSnapshot(store, payload(), { source: 'extension', extensionId: 'ext-stale' });
    snap.setCloseStatus(store, saved.id, 'pending', '');
    for (const tab of snap.getSnapshot(store, saved.id).windows[0].tabs) {
      snap.updateTabMeta(store, tab.id, { restoreStatus: 'queued', restoreError: '' });
    }
    const r = snap.clearStaleInFlight(store);
    assert.equal(r.closeMarkedFailed, 1);
    assert.ok(r.restoreMarkedFailed >= 2);
    const after = snap.getSnapshot(store, saved.id);
    assert.equal(after.closeStatus, 'failed');
    assert.match(after.closeError, /重启|失效/);
    assert.ok(after.windows[0].tabs.every((tab) => tab.restoreStatus === 'failed'));
    assert.ok(after.windows[0].tabs.every((tab) => /重启|失效/.test(tab.restoreError)));
  });

});
