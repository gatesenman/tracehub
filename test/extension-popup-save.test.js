'use strict';

/**
 * Regression: popup "保存页签快照到本机" must reach the live HTTP bridge.
 * This loads the real extension popup.js + background.js + close-guard.js
 * in one VM, the same way importScripts shares global scope in the SW.
 * It is not a real Chrome GUI test.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { TabBridge } = require('../src/main/tab-bridge');

const EXT = path.join(__dirname, '../extension');

function hostTimers() {
  const wrap = (fn) => (...args) => {
    const id = fn(...args);
    if (id && typeof id.unref === 'function') id.unref();
    return id;
  };
  return {
    setTimeout: wrap(setTimeout),
    setInterval: wrap(setInterval),
    clearTimeout,
    clearInterval,
  };
}

const TOKEN = 'popup-save-regression-token';

function loadScript(context, filename) {
  const code = fs.readFileSync(path.join(EXT, filename), 'utf8');
  vm.runInContext(code, context, { filename, displayErrors: true });
}

function makeDocument() {
  const nodes = new Map();
  const makeEl = (id, tag) => {
    const el = {
      id,
      tagName: (tag || 'div').toUpperCase(),
      textContent: '',
      className: '',
      innerHTML: '',
      disabled: false,
      title: '',
      value: '',
      checked: false,
      listeners: {},
      appendChild(child) {
        this.children = this.children || [];
        this.children.push(child);
        this.textContent = (this.children.map((c) => c.textContent || c.innerHTML || '').join('\n'));
      },
      addEventListener(type, fn) { this.listeners[type] = this.listeners[type] || []; this.listeners[type].push(fn); },
      click() { for (const fn of this.listeners.click || []) fn(); },
    };
    nodes.set(id, el);
    return el;
  };
  makeEl('status', 'div');
  makeEl('preview', 'div');
  makeEl('btnSave', 'button');
  makeEl('btnRefresh', 'button');
  return {
    getElementById(id) { return nodes.get(id) || null; },
    createElement(tag) { return makeEl(undefined, tag); },
    _nodes: nodes,
  };
}

function makeChrome({ token, port, extensionId, tabs }) {
  const storage = {
    port,
    token,
    profileLabel: 'GUI-test',
    includeIncognito: false,
  };
  const messageListeners = [];
  const alarmListeners = [];
  const windows = [{
    id: 1,
    focused: true,
    incognito: false,
    type: 'normal',
    state: 'normal',
    left: 0, top: 0, width: 800, height: 600,
    tabs: tabs.map((t, i) => ({
      id: t.id,
      index: i,
      url: t.url,
      title: t.title,
      pinned: !!t.pinned,
      active: i === 0,
      discarded: false,
      incognito: false,
      favIconUrl: '',
      groupId: -1,
    })),
  }];
  return {
    runtime: {
      id: extensionId,
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
      sendMessage(msg) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const sendResponse = (value) => { settled = true; resolve(value); };
          for (const fn of messageListeners) {
            const ret = fn(msg, { id: extensionId }, sendResponse);
            if (ret !== true && !settled) resolve(undefined);
          }
        });
      },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        async get(defaults) { return { ...defaults, ...storage }; },
        async set(patch) { Object.assign(storage, patch); },
      },
    },
    windows: {
      async getAll() { return windows; },
      async create() { return { tabs: [] }; },
    },
    tabGroups: { async query() { return []; } },
    tabs: {
      async get(id) {
        const t = windows[0].tabs.find((x) => x.id === id);
        if (!t) throw new Error('no tab');
        return t;
      },
      async update() { return {}; },
      async remove() { return {}; },
    },
    alarms: {
      async create() {},
      onAlarm: { addListener(fn) { alarmListeners.push(fn); } },
    },
    _storage: storage,
  };
}

describe('extension popup save → background → live HTTP bridge', () => {
  let bridge;
  let port;
  const received = [];

  before(async () => {
    bridge = new TabBridge({
      port: 0,
      getToken: () => TOKEN,
      onSnapshot: async (raw, meta) => {
        received.push({ raw, meta });
        const n = ((raw && raw.windows) || []).reduce((c, w) => c + ((w.tabs || []).length), 0);
        return { ok: true, snapshotId: 'snap-gui-reg-001', tabCount: n, message: `已保存 ${n} 个页签。默认不会关闭浏览器。` };
      },
      onCommandResult: async () => {},
    });
    port = await bridge.start();
  });

  after(async () => {
    if (bridge) await bridge.stop();
  });

  it('importScripts(close-guard) must not shadow the bridge request function (the "api is not a function" bug)', () => {
    const context = { console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math, URL, URLSearchParams };
    vm.createContext(context);
    context.globalThis = context;
    context.self = context;
    context.chrome = { runtime: { id: 'x', onMessage: { addListener() {} }, onInstalled: { addListener() {} } }, alarms: { onAlarm: { addListener() {} }, create() {} }, storage: { local: {} }, windows: {}, tabGroups: {}, tabs: {} };
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    context.navigator = { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' };
    context.importScripts = (file) => loadScript(context, file);
    loadScript(context, 'background.js');

    assert.equal(typeof context.bridgeRequest, 'function', 'bridgeRequest should remain a function after close-guard is imported');
    assert.equal(typeof context.TraceHubCloseGuard.planCloseTargets, 'function');
    // The old close-guard used `var api = { ... }`, which overwrote async function api
    // in the service-worker global. That name must no longer be an object used as a call.
    if (typeof context.api !== 'undefined') {
      assert.equal(typeof context.api, 'function', 'if a global api exists, it must still be the request function, not the close-guard object');
    }
    assert.equal(typeof context.pushSnapshot, 'function');
  });

  it('clicking 保存 in the real popup.js posts the live tabs to the bridge and reports success', async () => {
    received.length = 0;
    const chrome = makeChrome({
      token: TOKEN,
      port,
      extensionId: 'abcdefghijklmnopqrst',
      tabs: [
        { id: 11, url: 'https://example.com/', title: 'Example Domain' },
        { id: 12, url: 'https://example.org/', title: 'Example Domain' },
      ],
    });
    const document = makeDocument();

    const context = {
      console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math, URL, URLSearchParams,
      chrome, document, fetch, navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
    };
    vm.createContext(context);
    context.globalThis = context;
    context.self = context;
    context.importScripts = (file) => loadScript(context, file);

    loadScript(context, 'background.js');
    loadScript(context, 'popup.js');

    // popup.js auto-refresh() is fire-and-forget; wait for the preview to render.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const preview = document.getElementById('preview');
      const html = preview.innerHTML + preview.textContent;
      if (html.includes('example.com') || html.includes('Example Domain') || html.includes('窗口')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const preview = document.getElementById('preview');
    const previewText = (preview.innerHTML || '') + (preview.children || []).map((c) => c.textContent || '').join(' ');
    // titles are rendered; urls are in title attributes. Either is fine.
    assert.match(String(preview.textContent || preview.innerHTML || previewText), /窗口|Example|example/);
    const pairDeadline = Date.now() + 3000;
    while (Date.now() < pairDeadline) {
      if (!document.getElementById('btnSave').disabled && /已与本机 TraceHub 配对/.test(document.getElementById('status').textContent)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(document.getElementById('btnSave').disabled, false, 'Save should be enabled only after health and a successful pair');
    assert.match(document.getElementById('status').textContent, /已与本机 TraceHub 配对/);

    document.getElementById('btnSave').click();
    const saveDeadline = Date.now() + 3000;
    while (Date.now() < saveDeadline) {
      const status = document.getElementById('status').textContent;
      if (status.includes('已保存') || status.includes('is not a function') || status.includes('失败') || status.includes('未连')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = document.getElementById('status').textContent;
    assert.doesNotMatch(status, /is not a function/);
    assert.match(status, /已保存 2 个页签/);
    assert.equal(received.length, 1);
    const urls = received[0].raw.windows[0].tabs.map((t) => t.url);
    assert.deepEqual(urls, ['https://example.com/', 'https://example.org/']);
    assert.equal(received[0].meta.extensionId, 'abcdefghijklmnopqrst');
    assert.equal(chrome._storage.lastSnapshotId, 'snap-gui-reg-001');
  });

  it('save fails clearly when the pairing token is missing (does not throw api is not a function)', async () => {
    const chrome = makeChrome({
      token: '',
      port,
      extensionId: 'abcdefghijklmnopqrst',
      tabs: [{ id: 1, url: 'https://example.com/', title: 'Ex' }],
    });
    const context = {
      console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math, URL, URLSearchParams,
      chrome, fetch, navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
    };
    vm.createContext(context);
    context.globalThis = context;
    context.self = context;
    context.importScripts = (file) => loadScript(context, file);
    loadScript(context, 'background.js');
    const result = await context.pushSnapshot().then((r) => r, (e) => ({ ok: false, error: e.message }));
    assert.equal(result.ok, false);
    assert.match(result.error, /配对令牌/);
    assert.doesNotMatch(result.error, /is not a function/);
  });
});


describe('extension options save actually pairs (not just local storage)', () => {
  let bridge;
  let port;

  before(async () => {
    bridge = new TabBridge({
      port: 0,
      getToken: () => TOKEN,
      onSnapshot: async () => ({ ok: true, snapshotId: 'x', tabCount: 0 }),
      onCommandResult: async () => {},
    });
    port = await bridge.start();
  });

  after(async () => {
    if (bridge) await bridge.stop();
  });

  function loadOptions(chrome, document) {
    const context = {
      console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math,
      chrome, document, fetch, navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
    };
    vm.createContext(context);
    context.globalThis = context;
    context.self = context;
    context.importScripts = (file) => loadScript(context, file);
    loadScript(context, 'background.js');
    loadScript(context, 'options.js');
    return context;
  }

  function makeOptionsDocument() {
    const nodes = new Map();
    const makeEl = (id, tag) => {
      const el = {
        id,
        tagName: (tag || 'input').toUpperCase(),
        textContent: '',
        className: '',
        value: '',
        checked: false,
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = this.listeners[type] || []; this.listeners[type].push(fn); },
        click() { for (const fn of this.listeners.click || []) fn(); },
      };
      nodes.set(id, el);
      return el;
    };
    makeEl('port');
    makeEl('token');
    makeEl('profileLabel');
    makeEl('includeIncognito');
    makeEl('save', 'button');
    makeEl('msg', 'span');
    return {
      getElementById(id) { return nodes.get(id) || null; },
      _nodes: nodes,
    };
  }

  it('saving a valid token posts /v1/pair and reports success, updating lastSeenAt', async () => {
    const chrome = makeChrome({ token: '', port, extensionId: 'opt-ext-1', tabs: [] });
    const document = makeOptionsDocument();
    loadOptions(chrome, document);
    document.getElementById('port').value = String(port);
    document.getElementById('token').value = TOKEN;
    const before = bridge.lastSeenAt;
    document.getElementById('save').click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (/已与本机 TraceHub 配对/.test(document.getElementById('msg').textContent)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(document.getElementById('msg').textContent, /已与本机 TraceHub 配对/);
    assert.doesNotMatch(document.getElementById('msg').textContent, /^已保存。$/);
    assert.equal(chrome._storage.token, TOKEN);
    assert.ok(bridge.lastSeenAt && (!before || bridge.lastSeenAt >= before));
    assert.equal(bridge.lastExtensionId, 'opt-ext-1');
  });

  it('a wrong token or missing app is reported as not paired, never as a silent success', async () => {
    const chrome = makeChrome({ token: '', port, extensionId: 'opt-ext-2', tabs: [] });
    const document = makeOptionsDocument();
    loadOptions(chrome, document);
    document.getElementById('port').value = String(port);
    document.getElementById('token').value = 'definitely-wrong-token';
    document.getElementById('save').click();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (/未成功|无效|失败/.test(document.getElementById('msg').textContent)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(document.getElementById('msg').textContent, /未成功|无效/);
    assert.doesNotMatch(document.getElementById('msg').textContent, /已与本机 TraceHub 配对/);
  });

  it('popup does not treat unauthenticated health as already paired', async () => {
    const chrome = makeChrome({
      token: 'wrong-token',
      port,
      extensionId: 'opt-ext-3',
      tabs: [{ id: 1, url: 'https://example.com/', title: 'Ex' }],
    });
    const document = makeDocument();
    const context = {
      console, ...hostTimers(), Date, Map, Number, String, Boolean, Array, Object, Error, JSON, Math, URL, URLSearchParams,
      chrome, document, fetch, navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0' },
    };
    vm.createContext(context);
    context.globalThis = context;
    context.self = context;
    context.importScripts = (file) => loadScript(context, file);
    loadScript(context, 'background.js');
    loadScript(context, 'popup.js');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const text = document.getElementById('status').textContent;
      if (text && text !== '正在保存快照…') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = document.getElementById('status').textContent;
    assert.doesNotMatch(status, /已与本机 TraceHub 配对/);
    assert.doesNotMatch(status, /^已连上本机应用/);
    assert.equal(document.getElementById('btnSave').disabled, true);
    assert.match(status, /令牌|配对|无效|尚未/);
  });
});
