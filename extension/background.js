importScripts('close-guard.js');
'use strict';

const DEFAULT_PORT = 17862;
const ALARM = 'tracehub-poll';

async function settings() {
  const s = await chrome.storage.local.get({
    port: DEFAULT_PORT,
    token: '',
    profileLabel: '',
    includeIncognito: false,
  });
  return s;
}

function detectBrowser() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return { id: 'edge', name: 'Microsoft Edge' };
  if (/OPR\//.test(ua) || /Opera/.test(ua)) return { id: 'opera', name: 'Opera' };
  if (/Brave/.test(ua) || (navigator.brave && typeof navigator.brave.isBrave === 'function')) {
    return { id: 'brave', name: 'Brave' };
  }
  if (/Vivaldi/.test(ua)) return { id: 'vivaldi', name: 'Vivaldi' };
  if (/Firefox\//.test(ua)) return { id: 'firefox', name: 'Mozilla Firefox' };
  return { id: 'chrome', name: 'Google Chrome' };
}

async function collectLiveTabs() {
  const cfg = await settings();
  const browser = detectBrowser();
  if (cfg.profileLabel) browser.profile = cfg.profileLabel;
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] });
  let groups = [];
  try {
    if (chrome.tabGroups && chrome.tabGroups.query) groups = await chrome.tabGroups.query({});
  } catch (e) {
    groups = [];
  }
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const outWindows = [];
  for (const w of windows) {
    if (w.incognito && !cfg.includeIncognito) continue;
    const tabs = [];
    for (const t of w.tabs || []) {
      if (t.incognito && !cfg.includeIncognito) continue;
      const g = t.groupId != null && t.groupId >= 0 ? groupMap.get(t.groupId) : null;
      tabs.push({
        tabId: t.id,
        index: t.index,
        url: t.url || t.pendingUrl || '',
        title: t.title || t.url || '',
        pinned: !!t.pinned,
        active: !!t.active,
        discarded: !!t.discarded,
        incognito: !!t.incognito,
        favIconUrl: t.favIconUrl || '',
        groupId: t.groupId != null && t.groupId >= 0 ? t.groupId : null,
        groupTitle: g ? g.title || '' : '',
        groupColor: g ? g.color || '' : '',
      });
    }
    if (!tabs.length) continue;
    outWindows.push({
      windowId: w.id,
      focused: !!w.focused,
      incognito: !!w.incognito,
      type: w.type || 'normal',
      state: w.state || 'normal',
      left: w.left, top: w.top, width: w.width, height: w.height,
      tabs,
    });
  }
  return {
    schemaVersion: 1,
    source: 'extension',
    capturedAt: Date.now(),
    browser,
    windows: outWindows,
  };
}

function baseUrl(port) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

async function bridgeRequest(pathname, { method = 'GET', body } = {}) {
  const cfg = await settings();
  if (!cfg.token) {
    const err = new Error('尚未填写配对令牌。请在 TraceHub 设置里复制令牌，粘贴到本扩展选项页。');
    err.code = 'NO_TOKEN';
    throw err;
  }
  const res = await fetch(baseUrl(cfg.port) + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-TraceHub-Token': cfg.token,
      'X-Extension-Id': chrome.runtime.id,
      'X-TraceHub-Browser': detectBrowser().id,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok || (json && json.ok === false)) {
    const err = new Error((json && json.error) || `应用未响应（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function health() {
  const cfg = await settings();
  try {
    const res = await fetch(baseUrl(cfg.port) + '/v1/health', { method: 'GET' });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch (e) {
    return { ok: false, error: '本机应用未在运行或桥接未开启' };
  }
}

async function pushSnapshot() {
  const payload = await collectLiveTabs();
  const tabCount = payload.windows.reduce((n, w) => n + w.tabs.length, 0);
  if (!tabCount) throw new Error('当前没有可保存的页签（隐身窗口默认跳过）');
  await bridgeRequest('/v1/pair', { method: 'POST', body: { extensionId: chrome.runtime.id, browser: payload.browser } });
  const result = await bridgeRequest('/v1/snapshot', { method: 'POST', body: payload });
  await chrome.storage.local.set({ lastSnapshotId: result.snapshotId, lastTabCount: result.tabCount, lastSavedAt: Date.now() });
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.05 }); // ~3s
  return { ...result, tabCount: result.tabCount || tabCount, captured: payload };
}

async function handleCloseCommand(cmd) {
  const guard = self.TraceHubCloseGuard;
  const payload = cmd.payload || {};
  const browser = detectBrowser();
  const viewer = { extensionId: chrome.runtime.id, browserId: browser.id };
  if (guard && !guard.audienceMatches(cmd, viewer)) {
    return { commandId: cmd.id, type: 'close', ok: false, closedCount: 0, snapshotId: payload.snapshotId, message: '这条关闭指令不是发给当前扩展/浏览器的，已忽略。' };
  }
  if (guard && guard.commandExpired(cmd.createdAt, Date.now(), cmd.expiresAt ? (cmd.expiresAt - cmd.createdAt) : undefined)) {
    return { commandId: cmd.id, type: 'close', ok: false, closedCount: 0, snapshotId: payload.snapshotId, message: '关闭指令已过期，已忽略以免误关。请在应用里重新确认。' };
  }
  const expectedTabs = Array.isArray(payload.expectedTabs) ? payload.expectedTabs : [];
  if (!expectedTabs.length || expectedTabs.some((t) => !t.url || t.tabId == null)) {
    return { commandId: cmd.id, type: 'close', ok: false, closedCount: 0, snapshotId: payload.snapshotId, message: '关闭指令缺少「页签 ID + 原始网址」，已拒绝执行，以免在页签 ID 复用后误关。' };
  }
  const live = [];
  for (const exp of expectedTabs) {
    try { live.push(await chrome.tabs.get(exp.tabId)); }
    catch (e) { /* missing */ }
  }
  if (!guard) {
    return { commandId: cmd.id, type: 'close', ok: false, closedCount: 0, snapshotId: payload.snapshotId, message: '关闭防护模块未加载，已拒绝执行以免误关。' };
  }
  const plan = guard.planCloseTargets(expectedTabs, live);
  const closed = [];
  const failed = [];
  // chrome.tabs.remove may bypass a page's beforeunload dialog. We never claim
  // unsaved forms are protected; the desktop app requires an explicit risk ack.
  for (const item of plan.closable) {
    try {
      await chrome.tabs.remove(item.expected.tabId);
      closed.push(item.expected.tabId);
    } catch (e) {
      failed.push({ tabId: item.expected.tabId, url: item.expected.url, error: String(e.message || e) });
    }
  }
  return {
    commandId: cmd.id,
    type: 'close',
    snapshotId: payload.snapshotId,
    ok: failed.length === 0,
    closedCount: closed.length,
    closedTabIds: closed,
    failed,
    skipped: plan.skipped,
    message: (failed.length ? `已关闭 ${closed.length} 个，${failed.length} 个失败。` : `已关闭 ${closed.length} 个页签。`)
      + (plan.skipped.length ? `${plan.skipped.length} 个因地址变化或不存在已跳过。` : '')
      + '不能保护未保存表单。',
  };
}

async function createRestoreWindow(win, urls, guard) {
  const attempts = (guard && guard.buildWindowCreateAttempts)
    ? guard.buildWindowCreateAttempts(win, urls)
    : [{ url: urls, focused: true, type: 'normal' }];
  let lastErr = new Error('无法创建窗口');
  for (const raw of attempts) {
    const data = { url: raw.url, focused: true, type: raw.type || 'normal' };
    if (raw.state) data.state = raw.state;
    if (raw.left != null) data.left = raw.left;
    if (raw.top != null) data.top = raw.top;
    if (raw.width != null) data.width = raw.width;
    if (raw.height != null) data.height = raw.height;
    try {
      const created = await chrome.windows.create(data);
      return { created, restUrls: raw.restUrls || [] };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function listWindowTabs(windowId, expected) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ windowId }); } catch (e) { tabs = []; }
  if ((!tabs || tabs.length < expected) && expected) {
    try { await new Promise((r) => setTimeout(r, 50)); } catch (e) { /* ignore */ }
    try { tabs = await chrome.tabs.query({ windowId }); } catch (e) { /* keep */ }
  }
  return (tabs || []).slice().sort((a, b) => a.index - b.index);
}

async function applyPinsAndGroups(wantTabs, gotTabs, windowId, guard) {
  const n = Math.min(wantTabs.length, gotTabs.length);
  const byGroup = new Map();
  for (let i = 0; i < n; i++) {
    const want = wantTabs[i];
    const got = gotTabs[i];
    if (want.pinned) {
      try { await chrome.tabs.update(got.id, { pinned: true }); } catch (e) { /* ignore */ }
    }
    const title = String(want.userGroup || want.groupTitle || '').trim();
    if (!title) continue;
    if (!byGroup.has(title)) byGroup.set(title, { color: want.groupColor, ids: [] });
    byGroup.get(title).ids.push(got.id);
  }
  const groups = [];
  if (!chrome.tabs.group || !chrome.tabGroups) return groups;
  for (const [title, g] of byGroup) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: g.ids, createProperties: { windowId } });
      const patch = { title };
      if (guard && guard.isAllowedTabGroupColor && guard.isAllowedTabGroupColor(g.color)) {
        patch.color = String(g.color).toLowerCase();
      }
      try { await chrome.tabGroups.update(groupId, patch); } catch (e) { /* title may fail; tabs are still grouped */ }
      groups.push({ title, groupId, ok: true });
    } catch (e) {
      groups.push({ title, ok: false, error: String(e.message || e) });
    }
  }
  return groups;
}

async function handleRestoreCommand(cmd) {
  const guard = self.TraceHubCloseGuard;
  const payload = cmd.payload || {};
  const browser = detectBrowser();
  const viewer = { extensionId: chrome.runtime.id, browserId: browser.id };
  if (guard && !guard.audienceMatches(cmd, viewer)) {
    return { commandId: cmd.id, type: 'restore', ok: false, openedCount: 0, snapshotId: payload.snapshotId, message: '这条恢复指令不是发给当前扩展的，已忽略。' };
  }
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  const opened = [];
  const failed = [];
  const groupResults = [];
  for (const w of windows) {
    const tabs = (w.tabs || []).filter((t) => guard ? guard.isRestorableUrl(t.url) : /^https?:\/\//i.test(t.url || ''));
    if (!tabs.length) continue;
    const urls = tabs.map((t) => t.url);
    try {
      const { created, restUrls } = await createRestoreWindow(w, urls, guard);
      if (restUrls && restUrls.length && created && created.id) {
        for (const u of restUrls) {
          try { await chrome.tabs.create({ windowId: created.id, url: u, active: false }); }
          catch (e) { failed.push({ url: u, error: String(e.message || e) }); }
        }
      }
      const got = created && created.id ? await listWindowTabs(created.id, tabs.length) : (created.tabs || []);
      // If create used a url array but returned fewer tabs, open the missing ones.
      if (created && created.id && got.length < tabs.length) {
        const have = new Set(got.map((t) => t.url));
        for (const t of tabs) {
          if (have.has(t.url)) continue;
          try {
            const added = await chrome.tabs.create({ windowId: created.id, url: t.url, active: false });
            got.push(added);
            have.add(t.url);
          } catch (e) {
            failed.push({ url: t.url, error: String(e.message || e) });
          }
        }
      }
      const aligned = (got || []).slice().sort((a, b) => a.index - b.index);
      for (let i = 0; i < tabs.length; i++) {
        const want = tabs[i];
        const match = aligned.find((g) => g.url === want.url) || aligned[i];
        if (!match) {
          if (!failed.some((f) => f.url === want.url)) failed.push({ url: want.url, error: '窗口已打开但未能核对到该页签' });
          continue;
        }
        opened.push({ url: want.url, tabId: match.id, windowId: created.id, pinned: !!want.pinned });
      }
      if (created && created.id) {
        const gr = await applyPinsAndGroups(tabs, aligned, created.id, guard);
        groupResults.push(...gr);
      }
    } catch (e) {
      for (const t of tabs) failed.push({ url: t.url, error: String(e.message || e) });
    }
  }
  return {
    commandId: cmd.id,
    type: 'restore',
    snapshotId: payload.snapshotId,
    ok: failed.length === 0 && opened.length > 0,
    openedCount: opened.length,
    opened,
    failed,
    groups: groupResults,
    message: failed.length
      ? `已打开 ${opened.length} 个页签，${failed.length} 个失败：${failed[0].error || '扩展打开失败'}`
      : `已打开 ${opened.length} 个页签（不会恢复登录态、表单或滚动位置）`,
  };
}

async function pollPending() {
  const h = await health();
  if (!h.ok) return { ok: false, offline: true };
  const cfg = await settings();
  if (!cfg.token) return { ok: false, offline: false, error: 'NO_TOKEN' };
  const res = await bridgeRequest('/v1/pending');
  const results = [];
  for (const cmd of res.commands || []) {
    let result;
    try {
      if (cmd.type === 'close') result = await handleCloseCommand(cmd);
      else if (cmd.type === 'restore') result = await handleRestoreCommand(cmd);
      else result = { commandId: cmd.id, ok: false, message: '未知命令，已忽略' };
    } catch (e) {
      result = { commandId: cmd.id, ok: false, message: String(e.message || e) };
    }
    try { await bridgeRequest('/v1/command-result', { method: 'POST', body: result }); } catch (e) { /* app offline mid-way */ }
    results.push(result);
    chrome.runtime.sendMessage({ type: 'command-result', result }).catch(() => {});
  }
  return { ok: true, results };
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) pollPending().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'health') return health();
    if (msg.type === 'collect') return collectLiveTabs();
    if (msg.type === 'save') return pushSnapshot();
    if (msg.type === 'poll') return pollPending();
    return { ok: false, error: 'unknown' };
  };
  run().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

function ensurePollAlarm() {
  try { chrome.alarms.create(ALARM, { periodInMinutes: 0.25 }); } catch (e) { /* ignore */ }
}
ensurePollAlarm();
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(ensurePollAlarm);
chrome.runtime.onInstalled.addListener(ensurePollAlarm);
