'use strict';

/**
 * End-to-end restore/close pipeline (not a real Chrome GUI test):
 * Fake IPC → snapshot-service → live HTTP tab-bridge → real background.js
 * pollPending → mocked chrome.windows/tabs/tabGroups → command-result → store/UI fields.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { Store } = require('../src/main/store');
const snap = require('../src/main/snapshot-store');
const { startBridge, registerSnapshotIpc } = require('../src/main/snapshot-service');
const { COMMAND_TTL_MS } = require('../src/shared/close-guard');

const EXT = path.join(__dirname, '../extension');
const TOKEN = 'pipeline-token-restore-close';
const EXT_ID = 'fjhhngfdkepnjaigchcojaiimloaepge';

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

function hostTimers() {
  const wrap = (fn) => (...args) => {
    const id = fn(...args);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  };
  return { setTimeout: wrap(setTimeout), setInterval: wrap(setInterval), clearTimeout, clearInterval };
}

function loadScript(context, filename) {
  const code = fs.readFileSync(path.join(EXT, filename), 'utf8');
  vm.runInContext(code, context, { filename, displayErrors: true });
}

function makeChrome({ extensionId, throwsOnMaximizedBounds = true } = {}) {
  const windows = [];
  const createCalls = [];
  const tabCreateCalls = [];
  const groupCalls = [];
  const groupUpdates = [];
  const removed = [];
  const updated = [];
  let winId = 1;
  let tabId = 200;
  const liveTabs = new Map(); // id → tab (for close path / tabs.get)
  const api = {
    runtime: {
      id: extensionId || EXT_ID,
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage() { return Promise.resolve(); },
    },
    storage: {
      local: {
        data: { port: 0, token: TOKEN, profileLabel: '', includeIncognito: false },
        async get(defaults) { return { ...defaults, ...this.data, port: api._port }; },
        async set(patch) { Object.assign(this.data, patch); },
      },
    },
    alarms: { async create() {}, onAlarm: { addListener() {} } },
    windows: {
      async getAll() { return []; },
      async create(data) {
        createCalls.push(JSON.parse(JSON.stringify(data)));
        const special = data.state === 'maximized' || data.state === 'minimized' || data.state === 'fullscreen';
        const hasBounds = data.left != null || data.top != null || data.width != null || data.height != null;
        if (throwsOnMaximizedBounds && special && hasBounds) {
          throw new Error("The 'maximized' state cannot be combined with 'left', 'top', 'width' or 'height'.");
        }
        const urls = Array.isArray(data.url) ? data.url : [data.url];
        const w = { id: winId++, tabs: [] };
        for (const u of urls) {
          const tab = { id: tabId++, url: u, index: w.tabs.length, pinned: false, windowId: w.id };
          w.tabs.push(tab);
          liveTabs.set(tab.id, tab);
        }
        windows.push(w);
        return { id: w.id, tabs: w.tabs.slice() };
      },
    },
    tabs: {
      async query({ windowId } = {}) {
        const w = windows.find((x) => x.id === windowId);
        return w ? w.tabs.slice() : [];
      },
      async create({ windowId, url, active }) {
        tabCreateCalls.push({ windowId, url, active });
        const w = windows.find((x) => x.id === windowId);
        if (!w) throw new Error('no window');
        const tab = { id: tabId++, url, index: w.tabs.length, pinned: false, windowId, active: !!active };
        w.tabs.push(tab);
        liveTabs.set(tab.id, tab);
        return tab;
      },
      async get(id) {
        const t = liveTabs.get(id);
        if (!t) throw new Error('no tab');
        return t;
      },
      async update(id, patch) {
        updated.push({ id, patch });
        const t = liveTabs.get(id);
        if (t && patch && 'pinned' in patch) t.pinned = !!patch.pinned;
        return t || {};
      },
      async remove(id) {
        removed.push(id);
        liveTabs.delete(id);
      },
      async group({ tabIds, createProperties }) {
        const groupId = 70 + groupCalls.length;
        groupCalls.push({ tabIds: tabIds.slice(), windowId: createProperties && createProperties.windowId, groupId });
        return groupId;
      },
    },
    tabGroups: {
      async query() { return []; },
      async update(id, patch) { groupUpdates.push({ id, patch }); },
    },
    _port: 0,
    _createCalls: createCalls,
    _tabCreateCalls: tabCreateCalls,
    _groupCalls: groupCalls,
    _groupUpdates: groupUpdates,
    _removed: removed,
    _updated: updated,
    _windows: windows,
    _liveTabs: liveTabs,
    seedLive(tab) { liveTabs.set(tab.id, { ...tab }); },
  };
  return api;
}

function loadBackground(chrome) {
  const context = {
    console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math, URL, URLSearchParams,
    chrome, fetch, navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
  };
  vm.createContext(context);
  context.globalThis = context;
  context.self = context;
  context.importScripts = (file) => loadScript(context, file);
  loadScript(context, 'background.js');
  return context;
}

function snapshotPayload() {
  return {
    source: 'extension',
    capturedAt: Date.now(),
    extensionId: EXT_ID,
    browser: { id: 'chrome', name: 'Google Chrome', profile: 'TraceHub Isolated Test' },
    windows: [{
      windowId: 1,
      focused: false,
      state: 'maximized',
      left: 0, top: 0, width: 1920, height: 1159,
      type: 'normal',
      tabs: [
        { tabId: 11, index: 0, url: 'https://example.com/', title: 'Example Domain', pinned: false, userGroup: 'Test Pages' },
        { tabId: 12, index: 1, url: 'https://example.org/', title: 'Example Domain', pinned: true, userGroup: 'Test Pages' },
      ],
    }],
  };
}

describe('restore/close pipeline through IPC, bridge, and extension SW', () => {
  let dir, dbPath, store, bridge, ipc, openExternalCalls, config;

  async function boot() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-pipe-'));
    dbPath = path.join(dir, 'hub.sqlite');
    store = new Store(dbPath);
    await store.init();
    config = {
      get: () => ({ bridgeEnabled: true, bridgePort: 0, bridgeToken: TOKEN, ai: {} }),
      update() { return this.get(); },
    };
    openExternalCalls = [];
    bridge = await startBridge(config, store, {});
    assert.ok(bridge && bridge.listeningPort, 'bridge should start on an ephemeral port');
    ipc = new FakeIpc();
    registerSnapshotIpc({
      ipcMain: ipc,
      store,
      config,
      getBridge: () => bridge,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
      shell: {
        openExternal: async (url) => {
          openExternalCalls.push(url);
          throw new Error('xdg-mime: mimetype argument missing');
        },
        openPath: async () => '',
      },
      ai: { hasKey: () => false, chat: async () => { throw new Error('no ai'); } },
      getMainWindow: () => null,
      app: { isPackaged: false },
      getSync: () => null,
    });
  }

  async function shutdown() {
    try { if (bridge) await bridge.stop(); } catch (e) { /* ignore */ }
    try { if (store) store.close(); } catch (e) { /* ignore */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    store = bridge = ipc = null;
  }

  beforeEach(boot);
  afterEach(shutdown);

  it('queues restore without marking opened, then extension poll opens via windows/tabs/group (maximized+bounds does not fail)', async () => {
    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    for (const t of snap.getSnapshot(store, saved.id).windows[0].tabs) {
      snap.updateTabMeta(store, t.id, { userGroup: 'Test Pages' });
    }
    const r = await ipc.invoke('snapshot:restore-batch', {
      id: saved.id, group: 'Test Pages', skipDuplicates: false, batchSize: 8, offset: 0, confirmed: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
    assert.equal(r.via, 'extension');
    assert.equal(openExternalCalls.length, 0);
    const mid = snap.getSnapshot(store, saved.id);
    assert.ok(mid.windows[0].tabs.every((t) => t.restoreStatus === 'queued'));
    assert.ok(mid.windows[0].tabs.every((t) => t.restoreStatus !== 'opened'));

    const chrome = makeChrome({ extensionId: EXT_ID });
    chrome._port = bridge.listeningPort;
    const ctx = loadBackground(chrome);
    const poll = await ctx.pollPending();
    assert.equal(poll.ok, true);
    assert.ok(poll.results && poll.results[0]);
    const result = poll.results[0];
    assert.equal(result.ok, true, result.message);
    assert.equal(result.openedCount, 2);
    assert.equal(openExternalCalls.length, 0);

    assert.ok(chrome._createCalls.length >= 1);
    for (const c of chrome._createCalls) {
      const special = c.state === 'maximized' || c.state === 'minimized';
      const hasBounds = c.left != null || c.top != null || c.width != null || c.height != null;
      assert.ok(!(special && hasBounds), 'must never send maximized+bounds to chrome.windows.create: ' + JSON.stringify(c));
    }
    assert.equal(chrome._groupCalls.length, 1);
    assert.equal(chrome._groupUpdates[0].patch.title, 'Test Pages');
    assert.ok(chrome._updated.some((u) => u.patch && u.patch.pinned === true), 'pinned tab should be re-applied');

    const after = snap.getSnapshot(store, saved.id);
    const statuses = after.windows[0].tabs.map((t) => [t.url, t.restoreStatus, t.restoreError]);
    assert.deepEqual(statuses.map((s) => s[1]), ['opened', 'opened'], statuses);
  });

  it('does not fall back to shell.openExternal when the extension session or bridge is missing; statuses stay unopened', async () => {
    const imported = await ipc.invoke('snapshot:import', snapshotPayload());
    assert.equal(imported.ok, true);
    const r = await ipc.invoke('snapshot:restore-batch', {
      id: imported.snapshot.id, confirmed: true, batchSize: 8, offset: 0,
    });
    assert.equal(r.ok, false);
    assert.equal(r.via, 'none');
    assert.match(r.error, /扩展|默认浏览器/);
    assert.equal(openExternalCalls.length, 0);
    const mid = snap.getSnapshot(store, imported.snapshot.id);
    assert.ok(mid.windows[0].tabs.every((t) => t.restoreStatus !== 'opened'));

    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    const listening = bridge.listeningPort;
    await bridge.stop();
    bridge.listeningPort = null;
    const r2 = await ipc.invoke('snapshot:restore-batch', {
      id: saved.id, confirmed: true, batchSize: 8, offset: 0,
    });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /桥接/);
    assert.equal(openExternalCalls.length, 0);
    // restart so afterEach can stop cleanly
    bridge = await startBridge(config, store, {});
  });

  it('times out a queued restore instead of leaving it looking successful', async () => {
    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    const r = await ipc.invoke('snapshot:restore-batch', { id: saved.id, confirmed: true, batchSize: 8, offset: 0 });
    assert.equal(r.pending, true);
    const cmd = bridge.commands.find((c) => c.id === r.commandId);
    assert.ok(cmd);
    cmd.createdAt = Date.now() - COMMAND_TTL_MS - 1000;
    cmd.expiresAt = cmd.createdAt + COMMAND_TTL_MS;
    const expired = bridge.expireStaleCommands();
    assert.equal(expired.length, 1);
    await bridge.onCommandResult({
      commandId: cmd.id,
      type: 'restore',
      snapshotId: saved.id,
      ok: false,
      timedOut: true,
      opened: [],
      failed: [],
      message: '扩展未在有效期内打开页签（可能离线或未轮询）',
    });
    const after = snap.getSnapshot(store, saved.id);
    assert.ok(after.windows[0].tabs.every((t) => t.restoreStatus === 'failed'), JSON.stringify(after.windows[0].tabs.map((t) => t.restoreStatus)));
    assert.ok(after.windows[0].tabs.every((t) => /有效期|离线|轮询/.test(t.restoreError || '')));
    assert.ok(after.windows[0].tabs.every((t) => t.restoreStatus !== 'opened'));
  });

  it('clears queued restore and pending close when the bridge restarts, because the in-memory queue is gone', async () => {
    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    const queued = await ipc.invoke('snapshot:restore-batch', { id: saved.id, confirmed: true, batchSize: 8, offset: 0 });
    assert.equal(queued.pending, true);
    const closing = await ipc.invoke('snapshot:request-close', { id: saved.id, userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(closing.pending, true);
    await bridge.stop();
    bridge = await startBridge(config, store, {});
    const after = snap.getSnapshot(store, saved.id);
    assert.equal(after.closeStatus, 'failed');
    assert.match(after.closeError, /重启|失效/);
    assert.ok(after.windows[0].tabs.every((tab) => tab.restoreStatus === 'failed'));
    assert.ok(after.windows[0].tabs.every((tab) => /重启|失效/.test(tab.restoreError || '')));
  });

  it('tells the truth when a restore is queued without a recently seen extension', async () => {
    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    const cold = await ipc.invoke('snapshot:restore-batch', { id: saved.id, confirmed: true, batchSize: 8, offset: 0 });
    assert.equal(cold.ok, true);
    assert.equal(cold.pending, true);
    assert.equal(cold.extensionRecentlySeen, false);
    assert.match(cold.message, /最近没有检测到配对扩展/);
    assert.match(cold.message, /打开扩展弹出页/);

    bridge.lastSeenAt = Date.now();
    bridge.lastExtensionId = EXT_ID;
    const warm = await ipc.invoke('snapshot:restore-batch', { id: saved.id, confirmed: true, batchSize: 8, offset: 0 });
    assert.equal(warm.ok, true);
    assert.equal(warm.extensionRecentlySeen, true);
    assert.match(warm.message, /后台闹钟|已向配对扩展发出/);
    assert.doesNotMatch(warm.message, /最近没有检测到/);

    const closeCold = await ipc.invoke('snapshot:request-close', { id: saved.id, userConfirmed: true, ackUnsavedRisk: true });
    // lastSeen was just set, so close should be "recent"
    assert.equal(closeCold.extensionRecentlySeen, true);
    assert.match(closeCold.message, /核对当前网址|后台闹钟/);
  });

  it('marks close as pending on enqueue, not done, and only closes URL-matching tabs after the extension acks', async () => {
    const saved = snap.saveSnapshot(store, snapshotPayload(), { source: 'extension', extensionId: EXT_ID, audienceBrowser: 'chrome' });
    const close = await ipc.invoke('snapshot:request-close', { id: saved.id, userConfirmed: true, ackUnsavedRisk: true });
    assert.equal(close.ok, true);
    assert.equal(close.pending, true);
    let s = snap.getSnapshot(store, saved.id);
    assert.equal(s.closeStatus, 'pending');
    assert.notEqual(s.closeStatus, 'done');

    const chrome = makeChrome({ extensionId: EXT_ID });
    chrome._port = bridge.listeningPort;
    // Live tabs: first URL still matches; second navigated away.
    chrome.seedLive({ id: 11, url: 'https://example.com/', title: 'Example Domain' });
    chrome.seedLive({ id: 12, url: 'https://other.example/', title: 'Changed' });
    const ctx = loadBackground(chrome);
    const poll = await ctx.pollPending();
    assert.equal(poll.ok, true);
    const result = poll.results[0];
    assert.equal(result.closedCount, 1);
    assert.equal(chrome._removed.length, 1);
    assert.equal(chrome._removed[0], 11);
    assert.ok((result.skipped || []).some((x) => x.reason === 'url-changed' || (x.message || '').includes('地址')));

    s = snap.getSnapshot(store, saved.id);
    assert.notEqual(s.closeStatus, 'done');
    assert.ok(s.closeStatus === 'partial' || s.closeStatus === 'failed');
  });
});
