'use strict';

/**
 * Browser-safe helpers for close-target checks, command audience, expiry,
 * and restorable URL policy. Used by the desktop app, the extension
 * (importScripts), and Node tests. No Node-only APIs.
 */
var COMMAND_TTL_MS = 3 * 60 * 1000;
var UNSAFE_URL = /^(javascript|data|vbscript|file|about|blob):/i;
var RESTORABLE_URL = /^https?:\/\//i;

function normalizeUrlForMatch(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  try {
    var u = new URL(s);
    u.hash = '';
    var href = u.href;
    if (href.endsWith('/') && u.pathname === '/') {
      /* keep */
    } else if (href.endsWith('/') && u.search === '') {
      href = href.replace(/\/$/, '');
    }
    return href;
  } catch (e) {
    return s.replace(/#.*$/, '');
  }
}

function urlsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizeUrlForMatch(a) === normalizeUrlForMatch(b);
}

function isUnsafeUrl(url) {
  return UNSAFE_URL.test(String(url || ''));
}

function isRestorableUrl(url) {
  return RESTORABLE_URL.test(String(url || '')) && !isUnsafeUrl(url);
}

/**
 * Decide whether a live tab may be closed for a captured target.
 * Never close when the tab is missing or the URL has changed
 * (tab IDs are reused after a browser restart).
 */
function matchTabForClose(expected, live) {
  if (!expected || expected.tabId == null || !Number.isFinite(Number(expected.tabId))) {
    return { ok: false, reason: 'missing-id', message: '快照里没有可用的页签 ID' };
  }
  if (!live) {
    return { ok: false, reason: 'missing', message: '页签已不存在（可能已关闭或浏览器已重启）' };
  }
  var want = Number(expected.tabId);
  var got = Number(live.id != null ? live.id : live.tabId);
  if (want !== got) {
    return { ok: false, reason: 'id-mismatch', message: '页签 ID 不一致' };
  }
  var liveUrl = live.url || live.pendingUrl || '';
  if (!liveUrl) {
    return { ok: false, reason: 'url-unknown', message: '无法读取当前网址，已跳过以免误关' };
  }
  if (!urlsMatch(expected.url, liveUrl)) {
    return {
      ok: false,
      reason: 'url-changed',
      message: '当前页签地址已变化，已跳过以免误关「' + (live.title || liveUrl) + '」',
    };
  }
  return { ok: true, reason: 'match', message: '' };
}

function planCloseTargets(expectedTabs, liveTabs) {
  var liveById = new Map();
  (liveTabs || []).forEach(function (t) {
    var id = Number(t.id != null ? t.id : t.tabId);
    if (Number.isFinite(id)) liveById.set(id, t);
  });
  var closable = [];
  var skipped = [];
  (expectedTabs || []).forEach(function (exp) {
    var live = liveById.get(Number(exp.tabId));
    var m = matchTabForClose(exp, live);
    if (m.ok) closable.push({ expected: exp, live: live });
    else skipped.push({ expected: exp, reason: m.reason, message: m.message });
  });
  return { closable: closable, skipped: skipped };
}

function commandExpired(createdAt, now, ttlMs) {
  var created = Number(createdAt) || 0;
  var ttl = ttlMs == null ? COMMAND_TTL_MS : ttlMs;
  return !created || (Number(now) || Date.now()) - created > ttl;
}

function audienceMatches(command, viewer) {
  var aud = (command && command.audience) || (command && command.payload && command.payload.audience) || {};
  if (aud.extensionId) {
    var ext = viewer && viewer.extensionId;
    if (!ext || String(aud.extensionId) !== String(ext)) return false;
  }
  if (aud.browserId) {
    var browserId = viewer && viewer.browserId;
    if (!browserId || String(aud.browserId) !== String(browserId)) return false;
  }
  return true;
}


function isSpecialWindowState(state) {
  return state === 'minimized' || state === 'maximized' || state === 'fullscreen';
}

/**
 * Chrome rejects maximized/minimized/fullscreen when combined with bounds.
 * Return create-data attempts, most specific first, last is urls-only / first-url.
 */
function buildWindowCreateAttempts(win, urls) {
  var urlList = (urls || []).filter(Boolean);
  var attempts = [];
  if (!urlList.length) return attempts;
  var w = win || {};
  var state = w.state;
  if (isSpecialWindowState(state)) {
    attempts.push({
      url: urlList,
      focused: true,
      type: 'normal',
      state: state === 'fullscreen' ? 'normal' : state,
    });
  } else {
    var d = { url: urlList, focused: true, type: 'normal' };
    if (w.left != null && isFinite(Number(w.left))) d.left = Number(w.left);
    if (w.top != null && isFinite(Number(w.top))) d.top = Number(w.top);
    if (w.width != null && isFinite(Number(w.width))) d.width = Number(w.width);
    if (w.height != null && isFinite(Number(w.height))) d.height = Number(w.height);
    attempts.push(d);
  }
  attempts.push({ url: urlList, focused: true, type: 'normal' });
  if (urlList.length > 1) {
    attempts.push({ url: urlList[0], focused: true, type: 'normal', restUrls: urlList.slice(1) });
  }
  return attempts;
}

function isAllowedTabGroupColor(color) {
  return /^(grey|blue|red|yellow|green|pink|purple|cyan|orange)$/i.test(String(color || ''));
}

function sanitizeAiItem(raw, fallbackUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var url = typeof raw.url === 'string' && raw.url ? raw.url : fallbackUrl;
  if (!url) return null;
  var tags = Array.isArray(raw.tags)
    ? raw.tags.map(function (t) { return String(t || '').trim().slice(0, 40); }).filter(Boolean).slice(0, 12)
    : [];
  return {
    url: String(url).slice(0, 2000),
    category: String(raw.category || '').trim().slice(0, 40),
    purpose: String(raw.purpose || raw.category || '').trim().slice(0, 80),
    summary: String(raw.summary || '').trim().slice(0, 400),
    tags: tags,
  };
}

function sanitizeAiList(items, allowedUrls) {
  var allow = null;
  if (allowedUrls && allowedUrls.length) {
    allow = new Set(allowedUrls);
  }
  var out = [];
  (Array.isArray(items) ? items : []).forEach(function (it) {
    var s = sanitizeAiItem(it);
    if (!s) return;
    if (allow && !allow.has(s.url)) return;
    out.push(s);
  });
  return out;
}

var closeGuardApi = {
  COMMAND_TTL_MS: COMMAND_TTL_MS,
  UNSAFE_URL: UNSAFE_URL,
  RESTORABLE_URL: RESTORABLE_URL,
  normalizeUrlForMatch: normalizeUrlForMatch,
  urlsMatch: urlsMatch,
  isUnsafeUrl: isUnsafeUrl,
  isRestorableUrl: isRestorableUrl,
  matchTabForClose: matchTabForClose,
  planCloseTargets: planCloseTargets,
  commandExpired: commandExpired,
  audienceMatches: audienceMatches,
  sanitizeAiItem: sanitizeAiItem,
  sanitizeAiList: sanitizeAiList,
  isSpecialWindowState: isSpecialWindowState,
  buildWindowCreateAttempts: buildWindowCreateAttempts,
  isAllowedTabGroupColor: isAllowedTabGroupColor,
};

if (typeof module === 'object' && module.exports) {
  module.exports = closeGuardApi;
}
if (typeof globalThis !== 'undefined') {
  globalThis.TraceHubCloseGuard = closeGuardApi;
}
