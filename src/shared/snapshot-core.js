'use strict';

/**
 * Pure snapshot / close-gate / restore-batch / local categorize helpers.
 * No Electron, no filesystem, no network — safe to unit-test in Node.
 */

const SCHEMA_VERSION = 1;
const DEFAULT_RESTORE_BATCH = 8;
const MAX_RESTORE_BATCH = 20;
const RESTORABLE_URL = /^https?:\/\//i;

const DOMAIN_RULES = [
  [/github\.com|gitlab\.com|stackoverflow\.com|npmjs\.com|developer\.|docs\.|nodejs\.org|rust-lang\.org|python\.org/, '开发/文档'],
  [/youtube\.com|youtu\.be|bilibili\.com|netflix\.com|twitch\.tv|iqiyi\.com|youku\.com|vimeo\.com/, '视频娱乐'],
  [/twitter\.com|x\.com|facebook\.com|instagram\.com|weibo\.com|reddit\.com|zhihu\.com|xiaohongshu\.com|linkedin\.com/, '社交媒体'],
  [/amazon\.|taobao\.com|tmall\.com|jd\.com|ebay\.com|pinduoduo\.|shopping|aliexpress\./, '购物'],
  [/news|bbc\.|cnn\.|nytimes\.com|sina\.com|163\.com|sohu\.com|theguardian\.|reuters\./, '新闻资讯'],
  [/mail\.|gmail\.com|outlook\.|notion\.so|slack\.com|office\.com|feishu\.cn|teams\.microsoft/, '工作工具'],
  [/wikipedia\.org|coursera\.org|udemy\.com|edx\.org|khanacademy\.org|zhihu\.com\/question/, '学习'],
];

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asBool(v) {
  return v === true || v === 1 || v === '1';
}

/**
 * Validate a raw snapshot payload (from the extension or a JSON import).
 * Returns { ok: true, value } or { ok: false, error }.
 * Never treats browsing-history rows as a valid live-tab snapshot.
 */
function validateSnapshotPayload(raw) {
  if (raw == null) return { ok: false, error: '空快照：没有数据' };
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: '畸形输入：不是合法 JSON' };
    }
  }
  if (!isObject(raw)) return { ok: false, error: '畸形输入：快照必须是对象' };
  if (raw.fromHistory === true || raw.source === 'history') {
    return { ok: false, error: '拒绝：不能用浏览历史冒充已打开页签' };
  }
  if (!Array.isArray(raw.windows)) {
    return { ok: false, error: '畸形输入：缺少 windows 数组' };
  }
  let tabCount = 0;
  for (let wi = 0; wi < raw.windows.length; wi++) {
    const w = raw.windows[wi];
    if (!isObject(w)) return { ok: false, error: `畸形输入：windows[${wi}] 不是对象` };
    if (!Array.isArray(w.tabs)) return { ok: false, error: `畸形输入：windows[${wi}] 缺少 tabs 数组` };
    for (let ti = 0; ti < w.tabs.length; ti++) {
      const t = w.tabs[ti];
      if (!isObject(t)) return { ok: false, error: `畸形输入：windows[${wi}].tabs[${ti}] 不是对象` };
      if (typeof t.url !== 'string' || !t.url.trim()) {
        return { ok: false, error: `畸形输入：windows[${wi}].tabs[${ti}] 缺少 url` };
      }
      tabCount += 1;
    }
  }
  if (tabCount === 0) return { ok: false, error: '空快照：没有任何页签' };
  return { ok: true, value: raw };
}


function resolveSnapshotSource(src, extras = {}) {
  const fromExtras = extras && extras.source;
  if (fromExtras === 'extension') return 'extension';
  if (fromExtras === 'session-file' || (src && src.source === 'session-file')) return 'session-file';
  if (fromExtras === 'file-import' || (src && src.source === 'file-import')) return 'file-import';
  if (src && src.source === 'extension') return 'extension';
  return 'extension';
}

function sanitizeOrigin(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const rawBase = String(origin.sourceFileBase || origin.sourceFile || origin.sourcePath || origin.path || '');
  const base = rawBase.replace(/\\/g, '/').split('/').pop() || '';
  const safeBase = base.replace(/[^\w.\u4e00-\u9fff +()-]/g, '_').slice(0, 180);
  const mtime = Number(origin.sourceMtime);
  return {
    source: 'session-file',
    locked: !!origin.locked,
    stale: !!origin.stale,
    sourceMtime: Number.isFinite(mtime) ? mtime : null,
    sourceFileBase: safeBase,
    truncated: !!origin.truncated,
    ignoredTabGroupCommands: Number(origin.ignoredTabGroupCommands) || 0,
  };
}

function isSessionFileSnapshot(snapshot) {
  return !!(snapshot && snapshot.source === 'session-file');
}

function canPreciseClose(snapshot) {
  return !!(
    snapshot
    && snapshot.source === 'extension'
    && snapshot.extensionId
    && (snapshot.persisted === true || snapshot.persisted === 1)
    && snapshot.closeStatus !== 'done'
    && snapshot.closeStatus !== 'cancelled'
  );
}

function normalizeSnapshot(raw, extras = {}) {
  const checked = validateSnapshotPayload(raw);
  if (!checked.ok) throw new Error(checked.error);
  const src = checked.value;
  const capturedAt = asInt(src.capturedAt, Date.now()) || Date.now();
  const browser = isObject(src.browser) ? src.browser : {};
  const windows = src.windows.map((w, wi) => {
    const tabs = w.tabs.map((t, ti) => {
      const url = String(t.url).trim();
      return {
        tabId: t.tabId != null ? asInt(t.tabId, null) : (t.id != null ? asInt(t.id, null) : null),
        sessionTabId: t.sessionTabId != null ? asInt(t.sessionTabId, null) : null,
        tabIndex: t.index != null ? asInt(t.index, ti) : ti,
        url,
        title: typeof t.title === 'string' && t.title ? t.title : url,
        pinned: asBool(t.pinned),
        active: asBool(t.active),
        discarded: asBool(t.discarded),
        incognito: asBool(t.incognito) || asBool(w.incognito),
        favicon: typeof t.favIconUrl === 'string' ? t.favIconUrl : (t.favicon || ''),
        groupId: t.groupId != null && asInt(t.groupId, -1) >= 0 ? asInt(t.groupId) : null,
        groupTitle: typeof t.groupTitle === 'string' ? t.groupTitle : '',
        groupColor: typeof t.groupColor === 'string' ? t.groupColor : '',
        domain: domainOf(url),
        restorable: RESTORABLE_URL.test(url),
        category: '',
        tags: [],
        purpose: '',
        summary: '',
        userGroup: '',
        hiddenDup: false,
        restoreStatus: 'none',
        restoreError: '',
      };
    }).sort((a, b) => a.tabIndex - b.tabIndex);
    return {
      windowId: w.windowId != null ? asInt(w.windowId, null) : (w.id != null ? asInt(w.id, null) : null),
      windowIndex: wi,
      focused: asBool(w.focused),
      incognito: asBool(w.incognito),
      type: typeof w.type === 'string' ? w.type : 'normal',
      state: typeof w.state === 'string' ? w.state : 'normal',
      left: w.left != null ? asInt(w.left, null) : null,
      top: w.top != null ? asInt(w.top, null) : null,
      width: w.width != null ? asInt(w.width, null) : null,
      height: w.height != null ? asInt(w.height, null) : null,
      tabs,
    };
  });
  const source = resolveSnapshotSource(src, extras);
  if (source === 'session-file') {
    for (const w of windows) {
      for (const tab of w.tabs) {
        if (tab.sessionTabId == null && tab.tabId != null) tab.sessionTabId = tab.tabId;
        tab.tabId = null;
      }
    }
  }
  const origin = source === 'session-file' ? sanitizeOrigin(src.origin || extras.origin || {}) : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    source,
    origin,
    capturedAt,
    title: typeof src.title === 'string' && src.title.trim()
      ? src.title.trim()
      : defaultSnapshotTitle(capturedAt, windows),
    browserId: String(browser.id || extras.browserId || 'unknown'),
    browserName: String(browser.name || extras.browserName || '未知浏览器'),
    profile: String(browser.profile || extras.profile || ''),
    windows,
    tabCount: countTabs(windows),
  };
}

function countTabs(windows) {
  return windows.reduce((n, w) => n + w.tabs.length, 0);
}

function defaultSnapshotTitle(ts, windows) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = countTabs(windows);
  const w = windows.length;
  return `${when} · ${w} 个窗口 · ${n} 个页签`;
}

/**
 * Close is allowed only after a successful persist AND explicit user confirmation.
 * Default is not to close. Cancel stays cancelled.
 */
function assertCloseable(snapshot, { userConfirmed = false, ackUnsavedRisk = false } = {}) {
  if (!snapshot) return { ok: false, error: '没有指定快照' };
  if (snapshot.source === 'session-file' || snapshot.source === 'file-import') {
    return { ok: false, error: '会话文件快照和导入快照不能按 tabId 关闭浏览器里的页签。即使数据里带有 id，也不会发出关闭指令。' };
  }
  if (snapshot.persisted !== true && snapshot.persisted !== 1) {
    return { ok: false, error: '快照尚未成功保存到本地，不能关闭浏览器页签' };
  }
  if (!snapshot.tabCount) return { ok: false, error: '空快照不能触发关闭' };
  if (snapshot.closeStatus === 'done') return { ok: false, error: '这些页签已经关闭过，无需重复关闭' };
  if (snapshot.closeStatus === 'cancelled') return { ok: false, error: '关闭已取消' };
  if (!userConfirmed) return { ok: false, error: '关闭已取消：需要你在应用里明确确认' };
  if (!ackUnsavedRisk) {
    return { ok: false, error: '请先确认已了解未保存表单可能丢失的风险' };
  }
  return { ok: true };
}

function markCloseCancelled(snapshot) {
  return { ...snapshot, closeStatus: 'cancelled', closeError: '用户取消' };
}

function localPreCategorize(tabs) {
  return (tabs || []).map((t) => {
    let category = '其他';
    const hayUrl = t.url || '';
    const hayDomain = t.domain || domainOf(hayUrl);
    for (const [re, cat] of DOMAIN_RULES) {
      if (re.test(hayDomain) || re.test(hayUrl)) {
        category = cat;
        break;
      }
    }
    const userGroup = t.groupTitle || t.userGroup || category;
    return {
      ...t,
      category,
      tags: t.tags && t.tags.length ? t.tags : (hayDomain ? [hayDomain] : []),
      userGroup,
      purpose: t.purpose || category,
    };
  });
}

/**
 * Dedup preview: same normalized URL (ignore hash). Does not delete; marks later copies.
 */
function dedupPreview(tabs) {
  const seen = new Map();
  const out = [];
  let dupes = 0;
  for (const t of tabs || []) {
    let key = t.url || '';
    try {
      const u = new URL(t.url);
      u.hash = '';
      key = u.href;
    } catch (e) { /* keep raw */ }
    if (seen.has(key)) {
      dupes += 1;
      out.push({ ...t, hiddenDup: true, dupOf: seen.get(key) });
    } else {
      seen.set(key, t.url);
      out.push({ ...t, hiddenDup: false, dupOf: null });
    }
  }
  return { tabs: out, uniqueCount: seen.size, duplicateCount: dupes };
}

function flattenTabs(snapshot) {
  const list = [];
  for (const w of snapshot.windows || []) {
    for (const t of w.tabs || []) list.push({ ...t, windowIndex: w.windowIndex, windowId: w.windowId });
  }
  return list;
}

/**
 * Restore plan: never dump every tab at once. Default batch size 8, cap 20.
 * Only http(s) URLs are restorable. Does not claim login/form/scroll restoration.
 */
function batchRestorePlan(tabs, { batchSize = DEFAULT_RESTORE_BATCH, offset = 0, skipDuplicates = false } = {}) {
  const size = Math.min(MAX_RESTORE_BATCH, Math.max(1, asInt(batchSize, DEFAULT_RESTORE_BATCH) || DEFAULT_RESTORE_BATCH));
  let list = (tabs || []).filter((t) => t.restorable !== false && RESTORABLE_URL.test(t.url || ''));
  if (skipDuplicates) list = list.filter((t) => !t.hiddenDup);
  const total = list.length;
  const start = Math.max(0, asInt(offset, 0));
  const batch = list.slice(start, start + size);
  const nextOffset = start + batch.length;
  return {
    total,
    batchSize: size,
    offset: start,
    nextOffset,
    remaining: Math.max(0, total - nextOffset),
    done: nextOffset >= total,
    batch,
    unrestorableSkipped: (tabs || []).length - (tabs || []).filter((t) => RESTORABLE_URL.test(t.url || '')).length,
    limitation: '只能重新打开网址，不能恢复原页面的登录状态、未提交表单、滚动位置或页面内存状态。',
  };
}

/** Default AI payload: URL + title only (no body). */
function minimizeAiPayload(tabs, { includeBody = false } = {}) {
  return (tabs || []).map((t) => {
    const row = { url: t.url, title: (t.title || '').slice(0, 200), domain: t.domain || domainOf(t.url) };
    if (includeBody && t.content) row.content = String(t.content).slice(0, 1500);
    return row;
  });
}

/**
 * Merge AI results onto local tabs. On failure or missing entries, keep local
 * category/purpose/summary so tab rows are never dropped.
 */
function mergeAiResults(localTabs, aiResults, { failed = false, error = '' } = {}) {
  const byUrl = new Map();
  for (const r of aiResults || []) {
    if (r && r.url) byUrl.set(r.url, r);
  }
  return {
    failed: !!failed,
    error: error || '',
    tabs: (localTabs || []).map((t) => {
      const r = byUrl.get(t.url);
      if (!r) return { ...t };
      return {
        ...t,
        category: r.category || t.category,
        tags: (r.tags && r.tags.length) ? r.tags : t.tags,
        purpose: r.purpose || r.category || t.purpose,
        summary: r.summary || t.summary,
      };
    }),
  };
}

const SAVE_POLICY = {
  star: { addBookmark: true, addReadLater: false },
  readLater: { addBookmark: false, addReadLater: true },
};

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_RESTORE_BATCH,
  MAX_RESTORE_BATCH,
  RESTORABLE_URL,
  DOMAIN_RULES,
  SAVE_POLICY,
  domainOf,
  validateSnapshotPayload,
  resolveSnapshotSource,
  sanitizeOrigin,
  isSessionFileSnapshot,
  canPreciseClose,
  normalizeSnapshot,
  countTabs,
  defaultSnapshotTitle,
  assertCloseable,
  markCloseCancelled,
  localPreCategorize,
  dedupPreview,
  flattenTabs,
  batchRestorePlan,
  minimizeAiPayload,
  mergeAiResults,
};
