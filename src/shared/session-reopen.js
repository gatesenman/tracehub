'use strict';

/**
 * Reopen session-file snapshots as "open URLs in a new window per original window".
 * This is not a faithful layout restore: no tab groups, no pin, no login, no bounds.
 * Launch arguments are allow-listed and URLs are re-validated.
 */

const path = require('path');
const { RESTORABLE_URL } = require('./snapshot-core');

const PROFILE_DIR_RE = /^(Default|Guest Profile|Profile \d+)$/;
const ALLOWED_BROWSER_IDS = new Set(['chrome', 'edge']);

const FORBIDDEN_FLAG_PREFIXES = Object.freeze([
  '--load-extension',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--disable-web-security',
  '--user-data-dir',
  '--profile-directory', // only allowed as a single validated --profile-directory=Name form, checked separately
  '--js-flags',
  '--proxy-server',
  '--host-rules',
  '--host-resolver-rules',
  '--disable-extensions',
  '--app',
  '--gpu-launcher',
  '--utility-cmd-prefix',
  '--renderer-cmd-prefix',
  '--crash-dumps-dir',
]);

const REOPEN_LIMITATION = '将按窗口在目标浏览器中重新打开网址，不能恢复标签分组、固定状态、窗口位置/最大化、登录状态、未提交表单或滚动位置。这不是扩展按布局恢复。';
const LARGE_REOPEN_THRESHOLD = 30;
const DEFAULT_MAX_URLS = 200;

function largeReopenConfirmText(plan) {
  const n = (plan && (plan.urlCount || plan.total)) || 0;
  const w = (plan && plan.windowCount) || 0;
  const clipped = !!(plan && plan.windows && plan.windows.some((x) => x.clipped));
  return `即将一次性按窗口打开 ${n} 个网址（${w} 个窗口）。数量较多，需要再次确认后才会启动浏览器。无法恢复分组、固定、登录或表单。` + (clipped ? ' 超过上限的网址已被截掉，不会全部打开。' : '');
}

function assertSafeProfileDirectory(name) {
  const s = String(name || '');
  if (!s) return '';
  if (/[\\/\0]/.test(s) || s.includes('..') || s.includes(':') || !PROFILE_DIR_RE.test(s)) {
    const err = new Error('拒绝不安全的浏览器配置目录参数');
    err.code = 'UNSAFE_PROFILE';
    throw err;
  }
  return s;
}

function assertSafeHttpUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (e) {
    const err = new Error('拒绝无法解析的网址');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('只允许重新打开 http(s) 网址');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  if (u.username || u.password) {
    const err = new Error('拒绝带有用户名或密码的网址');
    err.code = 'UNSAFE_URL';
    throw err;
  }
  return u.href;
}

function looksLikeFlag(s) {
  return String(s).startsWith('-');
}

function assertSafeLaunchArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (const a of list) {
    const s = String(a);
    if (s === '--new-window') continue;
    if (s.startsWith('--profile-directory=')) {
      assertSafeProfileDirectory(s.slice('--profile-directory='.length));
      continue;
    }
    if (RESTORABLE_URL.test(s)) {
      assertSafeHttpUrl(s);
      continue;
    }
    for (const flag of FORBIDDEN_FLAG_PREFIXES) {
      if (s === flag || s.startsWith(`${flag}=`) || s.startsWith(`${flag} `)) {
        const err = new Error('拒绝带有调试、配置目录注入或不安全参数的启动');
        err.code = 'FORBIDDEN_FLAG';
        throw err;
      }
    }
    if (looksLikeFlag(s)) {
      const err = new Error('拒绝未允许的启动参数：' + s.slice(0, 80));
      err.code = 'FORBIDDEN_FLAG';
      throw err;
    }
    const err = new Error('拒绝无法识别的启动参数');
    err.code = 'FORBIDDEN_FLAG';
    throw err;
  }
  return list.slice();
}

function windowsFromSnapshot(snapshot) {
  return (snapshot && snapshot.windows) || [];
}

function planWindowReopen(snapshot, { maxUrls = DEFAULT_MAX_URLS } = {}) {
  const windows = [];
  let skippedNonHttp = 0;
  let pinnedRecorded = 0;
  let total = 0;
  for (const w of windowsFromSnapshot(snapshot)) {
    const urls = [];
    const tabRowIds = [];
    for (const t of w.tabs || []) {
      if (t && t.pinned) pinnedRecorded += 1;
      const url = t && t.url;
      if (!url || !RESTORABLE_URL.test(url)) {
        skippedNonHttp += 1;
        continue;
      }
      try {
        urls.push(assertSafeHttpUrl(url));
        tabRowIds.push(t.id || null);
      } catch (e) {
        skippedNonHttp += 1;
      }
    }
    if (urls.length) {
      total += urls.length;
      windows.push({
        windowIndex: w.windowIndex,
        windowId: w.windowId,
        tabRowIds,
        urls,
      });
    }
  }
  const clipped = [];
  let used = 0;
  for (const w of windows) {
    if (used >= maxUrls) break;
    const urls = w.urls.slice(0, Math.max(0, maxUrls - used));
    used += urls.length;
    clipped.push({ ...w, urls, tabRowIds: w.tabRowIds.slice(0, urls.length), clipped: urls.length < w.urls.length });
  }
  return {
    windows: clipped,
    windowCount: clipped.length,
    urlCount: used,
    skippedNonHttp,
    skippedLimit: total - used,
    skipped: skippedNonHttp + total - used,
    pinnedRecorded,
    limitation: REOPEN_LIMITATION,
    via: 'session-file-window-reopen',
    total: used,
    needsSecondConfirm: used >= LARGE_REOPEN_THRESHOLD,
    largeThreshold: LARGE_REOPEN_THRESHOLD,
    maxUrls,
    secondConfirmText: used >= LARGE_REOPEN_THRESHOLD ? largeReopenConfirmText({ urlCount: used, windowCount: clipped.length, windows: clipped }) : '',
  };
}

function buildWindowLaunch({ browserId, exe, profile, urls, newWindow = true }) {
  if (!ALLOWED_BROWSER_IDS.has(browserId)) {
    return { ok: false, error: '本轮只支持在 Chrome 或 Edge 中按窗口重新打开网址' };
  }
  if (!exe || typeof exe !== 'string') {
    return { ok: false, error: `未找到 ${browserId === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} 程序，无法按窗口打开网址。` };
  }
  // Reject exe paths that look like injected args; caller resolves from a known candidate list.
  if (looksLikeFlag(exe)) {
    return { ok: false, error: '拒绝不安全的浏览器程序路径' };
  }
  const safeUrls = (urls || []).map((u) => assertSafeHttpUrl(u));
  if (!safeUrls.length) return { ok: false, error: '没有可打开的 http(s) 网址' };
  const args = [];
  const prof = assertSafeProfileDirectory(profile || '');
  if (prof) args.push(`--profile-directory=${prof}`);
  if (newWindow) args.push('--new-window');
  args.push(...safeUrls);
  return {
    ok: true,
    browserId,
    exe,
    args: assertSafeLaunchArgs(args),
    urlCount: safeUrls.length,
  };
}

function buildSessionReopenLaunches({ browserId, exe, profile, plan }) {
  const launches = [];
  for (const w of (plan && plan.windows) || []) {
    const one = buildWindowLaunch({
      browserId,
      exe,
      profile,
      urls: w.urls,
      newWindow: true,
    });
    if (!one.ok) return { ok: false, error: one.error, launches };
    launches.push({ ...one, windowIndex: w.windowIndex, tabRowIds: w.tabRowIds || [] });
  }
  if (!launches.length) return { ok: false, error: '没有可按窗口打开的网址', launches };
  return {
    ok: true,
    via: 'session-file-window-reopen',
    limitation: REOPEN_LIMITATION,
    launches,
  };
}

async function runSessionReopenLaunches(built, spawnFn) {
  if (!built || !built.ok) return { ok: false, via: 'session-file-window-reopen', error: (built && built.error) || '无法启动', opened: 0, failed: 0, windows: 0 };
  const opened = [];
  const failed = [];
  const openedTabRowIds = [];
  const failedTabRowIds = [];
  let windowOk = 0;
  for (const launch of built.launches) {
    try {
      const args = assertSafeLaunchArgs(launch.args);
      const r = await spawnFn(launch.exe, args);
      if (r && r.ok === false) {
        failedTabRowIds.push(...(launch.tabRowIds || []).filter(Boolean));
        failed.push({ windowIndex: launch.windowIndex, error: r.error || '启动失败', urls: launch.args.filter((a) => RESTORABLE_URL.test(a)) });
      } else {
        windowOk += 1;
        openedTabRowIds.push(...(launch.tabRowIds || []).filter(Boolean));
        for (const a of args) if (RESTORABLE_URL.test(a)) opened.push(a);
      }
    } catch (e) {
      failedTabRowIds.push(...(launch.tabRowIds || []).filter(Boolean));
      failed.push({ windowIndex: launch.windowIndex, error: e.message || String(e) });
    }
  }
  const failedN = failed.length;
  const openedN = opened.length;
  return {
    ok: failedN === 0,
    via: 'session-file-window-reopen',
    pending: false,
    opened: openedN,
    openedTabRowIds,
    failedTabRowIds,
    failed: failedN,
    windows: windowOk,
    failedWindows: failed,
    limitation: REOPEN_LIMITATION,
    message: failedN
      ? `已按窗口请目标浏览器打开 ${openedN} 个网址（${windowOk} 个窗口成功），${failedN} 个窗口未能启动。${REOPEN_LIMITATION}`
      : `已按窗口请目标浏览器打开 ${openedN} 个网址（${windowOk} 个窗口）。${REOPEN_LIMITATION}`,
  };
}

module.exports = {
  PROFILE_DIR_RE,
  REOPEN_LIMITATION,
  LARGE_REOPEN_THRESHOLD,
  DEFAULT_MAX_URLS,
  largeReopenConfirmText,
  ALLOWED_BROWSER_IDS,
  assertSafeProfileDirectory,
  assertSafeHttpUrl,
  assertSafeLaunchArgs,
  planWindowReopen,
  buildWindowLaunch,
  buildSessionReopenLaunches,
  runSessionReopenLaunches,
};
