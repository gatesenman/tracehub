'use strict';

/**
 * Main-process orchestration for the extension-free session-file snapshot path.
 * Filesystem and process launch are injectable so tests never touch a real
 * user profile or spawn a real browser.
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  defaultChromiumRoots,
  listChromiumProfiles,
  publicProfileList,
  previewProfile,
} = require('../shared/session-capture');
const { defaultIO } = require('../shared/session-files');
const reopen = require('../shared/session-reopen');
const snap = require('./snapshot-store');
const { resolveExecutable } = require('./browser-launch');

const previews = new Map();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

let runtime = { io: null, roots: null, spawnFn: null, resolveExeFn: null, resolveExeOpts: null };

function setSessionFileRuntime(next = {}) {
  runtime = { ...runtime, ...next };
}

function clearSessionFileRuntime() {
  runtime = { io: null, roots: null, spawnFn: null, resolveExeFn: null, resolveExeOpts: null };
  previews.clear();
}

function forgetExpired(now = Date.now()) {
  for (const [id, rec] of previews) {
    if (now - rec.at > PREVIEW_TTL_MS) previews.delete(id);
  }
}

function resolveRoots(opts = {}) {
  if (Array.isArray(opts.roots)) return opts.roots;
  if (Array.isArray(runtime.roots)) return runtime.roots;
  if (process.env.TRACEHUB_SESSION_ROOTS) {
    try {
      const parsed = JSON.parse(process.env.TRACEHUB_SESSION_ROOTS);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* ignore */ }
  }
  return defaultChromiumRoots({ platform: opts.platform || process.platform, env: opts.env || process.env });
}

function listProfilesPublic(opts = {}) {
  const io = opts.io || runtime.io || defaultIO();
  const roots = resolveRoots(opts);
  return publicProfileList(listChromiumProfiles({ roots, io }));
}

function findProfileRecord(key, opts = {}) {
  const io = opts.io || runtime.io || defaultIO();
  const roots = resolveRoots(opts);
  const list = listChromiumProfiles({ roots, io });
  return list.find((p) => p.key === key) || null;
}

function previewByKey(key, opts = {}) {
  const rec = findProfileRecord(key, opts);
  if (!rec) {
    return { ok: false, error: '未找到这个 Chrome / Edge 配置，或其中没有会话文件。', windows: [], tabCount: 0 };
  }
  const roots = resolveRoots(opts);
  const result = previewProfile({
    browserId: rec.browserId,
    browserName: rec.browserName,
    profile: rec.profile,
    profileDir: rec._profileDir,
    io: opts.io || runtime.io || defaultIO(),
    roots,
  });
  if (!result.ok) return result;
  forgetExpired();
  const previewId = crypto.randomUUID();
  previews.set(previewId, { key, rec, at: Date.now(), result });
  const { payload, ...publicResult } = result;
  return { ...publicResult, previewId, payload };
}

function savePreview({ previewId, confirmed }, opts = {}) {
  if (!confirmed) return { ok: false, error: '请先预览并确认后再保存。不会自动采集。', cancelled: true };
  forgetExpired();
  const held = previews.get(previewId);
  if (!held) return { ok: false, error: '预览已过期，请重新选择配置并预览。' };
  // Persist the exact main-process-held preview the user confirmed, not a
  // re-read that may contain newly opened, never-previewed pages. Renderer
  // payload fields are never trusted; only the opaque previewId is used.
  const again = held.result;
  if (!again || !again.ok) return { ok: false, error: '预览不可用，请重新预览。' };
  const store = opts.store;
  if (!store) return { ok: false, error: '内部错误：没有可用的存储' };
  const saved = snap.saveSnapshot(store, again.payload, {
    source: 'session-file',
    browserId: again.browserId,
    browserName: again.browserName,
    profile: again.profile,
    origin: again.origin,
  });
  previews.delete(previewId);
  return {
    ok: true,
    snapshot: saved,
    honesty: again.honesty,
    stale: !!again.stale,
    locked: !!again.locked,
    message: again.stale
      ? `已保存 ${saved.tabCount} 个页签。${again.honesty}`
      : `已保存 ${saved.tabCount} 个页签（来自会话文件）。${again.honesty}`,
  };
}

function exportableSnapshot(s) {
  if (!s) return null;
  const origin = s.origin ? {
    locked: !!s.origin.locked,
    stale: !!s.origin.stale,
    sourceMtime: s.origin.sourceMtime || null,
    sourceFileBase: s.origin.sourceFileBase || '',
    truncated: !!s.origin.truncated,
  } : undefined;
  return {
    schemaVersion: 1,
    source: s.source || 'file-import',
    title: s.title,
    capturedAt: s.createdAt,
    browser: { id: s.browserId, name: s.browserName, profile: s.profile },
    origin,
    windows: (s.windows || []).map((win) => ({
      windowId: win.windowId,
      windowIndex: win.windowIndex,
      focused: win.focused,
      incognito: win.incognito,
      type: win.type,
      state: win.state,
      left: win.left, top: win.top, width: win.width, height: win.height,
      tabs: (win.tabs || []).map((t) => ({
        index: t.tabIndex, url: t.url, title: t.title,
        pinned: t.pinned, active: t.active, discarded: t.discarded,
        favIconUrl: t.favicon, groupTitle: t.groupTitle, groupColor: t.groupColor,
        category: t.category, tags: t.tags, purpose: t.purpose, summary: t.summary, userGroup: t.userGroup,
        // never export chrome tabIds for session-file snapshots
        tabId: s.source === 'session-file' ? null : t.tabId,
      })),
    })),
  };
}

function sessionFileRestorePlan(s) {
  if (!s || s.source !== 'session-file') {
    return { ok: false, error: '这份快照不是会话文件快照，不能走按窗口重新打开的路径。' };
  }
  const plan = reopen.planWindowReopen(s);
  return {
    ok: true,
    via: 'session-file-window-reopen',
    plan,
    limitation: plan.limitation,
    snapshotTitle: s.title,
  };
}

async function restoreSessionFileSnapshot(s, opts = {}) {
  if (!s || s.source !== 'session-file') {
    return { ok: false, via: 'none', error: '这份快照不是会话文件快照，不能走按窗口重新打开的路径。' };
  }
  const plan = reopen.planWindowReopen(s);
  if (!plan.urlCount) return { ok: false, via: 'session-file-window-reopen', error: '没有可按窗口打开的 http(s) 网址', plan };
  if (plan.needsSecondConfirm && !opts.largeConfirmed) {
    return {
      ok: false,
      via: 'session-file-window-reopen',
      needsSecondConfirm: true,
      error: plan.secondConfirmText || '页签数量较多，需要再次确认后才会打开。',
      plan,
    };
  }
  const browserId = s.browserId === 'edge' ? 'edge' : 'chrome';
  const exe = (opts.resolveExeFn || runtime.resolveExeFn || resolveExecutable)(browserId, opts.resolveExeOpts || runtime.resolveExeOpts || {});
  const built = reopen.buildSessionReopenLaunches({
    browserId,
    exe,
    profile: s.profile,
    plan,
  });
  if (!built.ok) return { ok: false, via: 'session-file-window-reopen', error: built.error, plan };

  const spawnFn = opts.spawnFn || runtime.spawnFn || ((exePath, args) => new Promise((resolve, reject) => {
    try {
      const child = spawn(exePath, args, { detached: true, stdio: 'ignore' });
      child.on('error', (e) => reject(e));
      if (typeof child.unref === 'function') child.unref();
      resolve({ ok: true });
    } catch (e) {
      reject(e);
    }
  }));
  const result = await reopen.runSessionReopenLaunches(built, spawnFn);
  if (opts.store) {
    for (const id of result.openedTabRowIds || []) snap.updateTabMeta(opts.store,id,{restoreStatus:'opened',restoreError:''});
    for (const id of result.failedTabRowIds || []) snap.updateTabMeta(opts.store,id,{restoreStatus:'failed',restoreError:result.error || '启动失败'});
  }
  if (plan.skipped) result.message = (result.message || '') + ` 已跳过 ${plan.skipped} 个网址（数量上限 ${plan.skippedLimit}，不安全或不支持 ${plan.skippedNonHttp}）。`;
  return { ...result, plan, snapshot: opts.store ? snap.getSnapshot(opts.store, s.id) : s };
}

function registerSessionFileIpc({ ipcMain, store, getIo, getRoots }) {
  const ctx = () => ({ io: getIo ? getIo() : (runtime.io || undefined), roots: getRoots ? getRoots() : (runtime.roots || undefined), store });
  ipcMain.handle('sessionfile:list-profiles', async () => {
    try {
      return { ok: true, profiles: listProfilesPublic(ctx()), scope: '本轮只支持 Chrome / Edge。Firefox 和其他浏览器不在范围内。不会自动采集。' };
    } catch (e) {
      return { ok: false, error: e.message || String(e), profiles: [] };
    }
  });
  ipcMain.handle('sessionfile:preview', async (_e, { key }) => {
    try {
      return previewByKey(String(key || ''), ctx());
    } catch (e) {
      return { ok: false, error: e.message || String(e), windows: [], tabCount: 0 };
    }
  });
  ipcMain.handle('sessionfile:save', async (_e, payload) => {
    try {
      return savePreview({ previewId: payload && payload.previewId, confirmed: !!(payload && payload.confirmed) }, ctx());
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = {
  listProfilesPublic,
  previewByKey,
  savePreview,
  exportableSnapshot,
  sessionFileRestorePlan,
  restoreSessionFileSnapshot,
  registerSessionFileIpc,
  setSessionFileRuntime,
  clearSessionFileRuntime,
  _previews: previews,
};
