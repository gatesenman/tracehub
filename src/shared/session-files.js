'use strict';

/**
 * Choose and copy Chromium session files (injectable FS).
 * Never reads History. On exclusive lock, fall back to an older unlocked
 * file and mark the result stale. An unreadable/empty current file is a
 * failure, not a successful empty tab list.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parseSession, SnssError } = require('./snss');

const RETRY_DELAYS = [50, 150, 400];
const LOCK_TTL_MS = 5 * 60 * 1000;
const lockedCache = new Map();

function clearLockedCache() {
  lockedCache.clear();
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) { /* ignore */ }
}

function defaultIO() {
  return {
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    lstat: (p) => fs.lstatSync(p),
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, b) => fs.writeFileSync(p, b),
    readdir: (p) => fs.readdirSync(p),
    stat: (p) => fs.statSync(p),
    isDirectory: (p) => {
      try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
    },
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    rm: (p) => { try { fs.rmSync(p, { force: true }); } catch (e) { /* ignore */ } },
    tmpdir: () => path.join(os.tmpdir(), 'tracehub-session-read'),
    sleep: sleepSync,
    sig: (p) => {
      try {
        const st = fs.statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch (e) {
        return null;
      }
    },
  };
}

/**
 * Copy a possibly-locked file to a temp path. Never throws; null when unreadable.
 * Order: readFile → short retries. Does not spawn shells or use VSS.
 */
let lastCopyInfo = { racy: false, source: null };

function getLastCopyInfo() {
  return { racy: !!lastCopyInfo.racy, source: lastCopyInfo.source || null };
}

function copyLocked(src, label = 'session', io = defaultIO()) {
  lastCopyInfo = { racy: false, source: src };
  if (!io.exists(src)) return null;
  const sig = io.sig ? io.sig(src) : null;
  const hit = sig ? lockedCache.get(src) : undefined;
  if (hit && hit.sig === sig && Date.now() - hit.at < LOCK_TTL_MS) return null;
  const dir = io.tmpdir ? io.tmpdir() : path.join(os.tmpdir(), 'tracehub-session-read');
  try { if (io.mkdir) io.mkdir(dir); } catch (e) { /* ignore */ }
  const dest = path.join(dir, `${label}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`);
  const tryRead = () => {
    const before = io.sig ? io.sig(src) : null;
    const buf = io.readFile(src);
    const after = io.sig ? io.sig(src) : before;
    const racy = !!(before && after && before !== after);
    if (io.writeFile) io.writeFile(dest, buf);
    return { value: io.writeFile ? dest : buf, racy };
  };
  const attempts = [0, ...RETRY_DELAYS];
  let lastErr = null;
  let lastOk = null;
  for (let i = 0; i < attempts.length; i += 1) {
    if (attempts[i] && io.sleep) io.sleep(attempts[i]);
    try {
      const got = tryRead();
      lastOk = got;
      if (!got.racy) {
        lastCopyInfo = { racy: false, source: src };
        return got.value;
      }
      // File changed during the read (append / rewrite). Retry for a stable copy.
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastOk) {
    lastCopyInfo = { racy: true, source: src };
    return lastOk.value;
  }
  if (sig) lockedCache.set(src, { sig, at: Date.now() });
  lastCopyInfo = { racy: false, source: src };
  return null;
}


/** True when `target` is `root` or a descendant. */
function isPathInside(root, target) {
  if (!root || !target) return false;
  const r = path.resolve(String(root));
  const t = path.resolve(String(target));
  const rel = path.relative(r, t);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Fail closed for missing canonicalization, symlinks/junctions or escaped targets. */
function safeDiskChild(root, target, io) {
  try {
    if (!io.realpath || !io.lstat || !isPathInside(root, target)) return false;
    const canonicalRoot = io.realpath(root);
    const canonicalTarget = io.realpath(target);
    if (!isPathInside(canonicalRoot, canonicalTarget)) return false;
    const relative = path.relative(path.resolve(root), path.resolve(target));
    let current = path.resolve(root);
    if (io.lstat(current).isSymbolicLink()) return false;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (io.lstat(current).isSymbolicLink()) return false;
    }
    return true;
  } catch (e) { return false; }
}

function isSafeEntryName(name) {
  const s = String(name || '');
  if (!s || s === '.' || s === '..') return false;
  if (s.includes('\0') || s.includes('/') || s.includes('\\')) return false;
  if (s.includes('..')) return false;
  if (path.basename(s) !== s) return false;
  return true;
}

/** Join names under root; return null if any segment would escape. */
function joinUnder(root, ...names) {
  if (!root) return null;
  let cur = path.resolve(String(root));
  for (const n of names) {
    if (!isSafeEntryName(n)) return null;
    const next = path.resolve(cur, String(n));
    if (!isPathInside(cur, next) || next === cur) return null;
    cur = next;
  }
  return cur;
}

function listSessionFiles(profileDir, io = defaultIO()) {
  const out = [];
  if (!profileDir) return out;
  const add = (p, kind) => {
    if (!p || !safeDiskChild(profileDir, p, io)) return;
    try {
      if (!io.exists(p)) return;
      const st = io.stat(p);
      out.push({ path: p, kind, mtime: st.mtimeMs != null ? st.mtimeMs : +st.mtime, size: st.size || 0 });
    } catch (e) { /* ignore */ }
  };
  const sessionsDir = joinUnder(profileDir, 'Sessions');
  if (sessionsDir && safeDiskChild(profileDir, sessionsDir, io) && io.exists(sessionsDir)) {
    let names = [];
    try { names = io.readdir(sessionsDir); } catch (e) { names = []; }
    for (const f of names) {
      const name = typeof f === 'string' ? f : (f && f.name) || '';
      if (/^Session_/.test(name)) add(joinUnder(sessionsDir, name), 'session');
      else if (/^Tabs_/.test(name)) add(joinUnder(sessionsDir, name), 'tabs');
    }
  }
  for (const [name, kind] of [
    ['Current Session', 'session'],
    ['Current Tabs', 'tabs'],
    ['Last Session', 'session'],
    ['Last Tabs', 'tabs'],
  ]) {
    add(joinUnder(profileDir, name), kind);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const HTTP_RE = /^https?:\/\//i;
const NOISE = /^(about:blank|about:newtab|chrome:\/\/newtab|chrome-search:|edge:\/\/newtab|chrome:\/\/new-tab-page)/i;

function isHttp(url) {
  return HTTP_RE.test(String(url || ''));
}

function filterHttpTabs(tabs) {
  return (tabs || []).filter((t) => isHttp(t.url));
}

function liveCount(windows) {
  return (windows || []).reduce((n, w) => n + ((w.tabs || []).length), 0);
}

/**
 * Classify a listed file. Tabs_* / Current Tabs / Last Tabs are Tab Restore
 * Service files (recently closed) with a different command-id set and must
 * never be parsed as a live Session Service snapshot.
 */
function sessionFileRole(f) {
  const base = path.basename(String((f && f.path) || ''));
  if ((f && f.kind) === 'tabs' || /^Tabs_/i.test(base) || base === 'Current Tabs' || base === 'Last Tabs') {
    return 'tabs-restore';
  }
  if (base === 'Last Session') return 'last-session';
  return 'session';
}

/**
 * Walk Session Service files newest → oldest. Official Chromium prefers the
 * newest file that contains the initial-state marker (command 255). Tabs_*
 * files are ignored. Tab count is not a tie-breaker (an older file with more
 * pages must not beat a newer readable Session file). If the newest file is
 * locked, fall back and mark stale.
 */
function pickChromiumSession(files, readFn) {
  const res = {
    windows: [],
    stale: false,
    locked: false,
    sourceMtime: null,
    sourceFile: null,
    truncated: false,
    ignoredTabGroupCommands: 0,
    error: null,
    parsed: false,
    hasMarker: false,
    lastSession: false,
    incompleteNewest: false,
    legacyVersion: false,
    racy: false,
  };
  const sessionFiles = (files || []).filter((f) => sessionFileRole(f) !== 'tabs-restore');
  const newestSession = sessionFiles[0] || null;
  const parsedList = [];
  for (const f of sessionFiles) {
    let buf = null;
    try { buf = readFn(f); } catch (e) { buf = null; }
    if (!buf) {
      if (f === newestSession) res.locked = true;
      continue;
    }
    try {
      const parsed = parseSession(buf);
      parsedList.push({ f, parsed, error: null });
    } catch (e) {
      parsedList.push({ f, parsed: null, error: e });
    }
  }

  const usable = parsedList.filter((x) => x.parsed);
  const withMarker = usable.filter((x) => x.parsed.hasMarker);
  // Prefer the newest file that has the official marker; otherwise the newest
  // readable plaintext file (legacy v1 has no marker).
  const chosen = (withMarker[0] || usable[0]) || null;
  if (!chosen) {
    const firstErr = parsedList.find((x) => x.error);
    if (firstErr) {
      const e = firstErr.error;
      res.error = e instanceof SnssError ? e.message : (e.message || String(e));
    } else if (res.locked) {
      res.error = '当前会话文件被浏览器占用，未能读到页签';
    }
    return res;
  }

  const parsed = chosen.parsed;
  res.windows = parsed.windows || [];
  res.truncated = !!parsed.truncated;
  res.ignoredTabGroupCommands = parsed.ignoredTabGroupCommands || 0;
  res.hasMarker = !!parsed.hasMarker;
  res.legacyVersion = !!parsed.legacyVersion;
  res.parsed = true;
  res.sourceMtime = chosen.f.mtime;
  res.sourceFile = chosen.f.path;
  res.lastSession = sessionFileRole(chosen.f) === 'last-session';
  const newestUsable = usable.find((x) => x.f === newestSession);
  if (newestSession && chosen.f !== newestSession) {
    if (newestUsable && !newestUsable.parsed.hasMarker) res.incompleteNewest = true;
    res.stale = true;
  }
  if (res.locked) res.stale = true;
  return res;
}

function basenameSafe(p) {
  if (!p) return '';
  const base = path.basename(String(p));
  return base.replace(/[^\w.\u4e00-\u9fff +()-]/g, '_').slice(0, 180);
}

/** Persistable origin: basename + timestamps, never a full filesystem path. */
function redactOrigin(readResult) {
  const mtime = readResult && readResult.sourceMtime != null ? Number(readResult.sourceMtime) : null;
  return {
    source: 'session-file',
    locked: !!(readResult && readResult.locked),
    stale: !!(readResult && readResult.stale),
    lastSession: !!(readResult && readResult.lastSession),
    incompleteNewest: !!(readResult && readResult.incompleteNewest),
    hasMarker: !!(readResult && readResult.hasMarker),
    legacyVersion: !!(readResult && readResult.legacyVersion),
    sourceMtime: Number.isFinite(mtime) ? mtime : null,
    sourceFileBase: basenameSafe(readResult && readResult.sourceFile),
    truncated: !!(readResult && readResult.truncated),
    racy: !!(readResult && readResult.racy),
    ignoredTabGroupCommands: (readResult && readResult.ignoredTabGroupCommands) || 0,
  };
}

function formatSourceClock(mtime) {
  if (!mtime) return '';
  const d = new Date(Number(mtime));
  if (Number.isNaN(+d)) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function honestyNote(origin) {
  if (!origin) return '';
  const when = formatSourceClock(origin.sourceMtime);
  if (origin.lastSession && !origin.locked && !origin.stale) {
    return when
      ? `来源是上次会话文件（${origin.sourceFileBase || 'Last Session'}，文件时间 ${when}）。通常是浏览器上一次退出时的状态，不是正在运行中的页签条。`
      : '来源是上次会话文件。通常是浏览器上一次退出时的状态，不是正在运行中的页签条。';
  }
  if (origin.incompleteNewest) {
    return when
      ? `最新会话文件没有完整的初始状态标记，已改用 ${when} 那份带标记的较旧文件。这不是此刻页签条。`
      : '最新会话文件没有完整的初始状态标记，已改用带标记的较旧文件。这不是此刻页签条。';
  }
  if (origin.stale || origin.locked) {
    return when
      ? `这是 ${when} 的会话存档，不是此刻页签条。当前会话文件可能被浏览器占用，已回退到较旧、可读取的文件。`
      : '读到的是较旧的会话存档，不是此刻页签条。当前会话文件可能被浏览器占用。';
  }
  if (origin.legacyVersion) {
    return (when ? `来源文件时间 ${when}。` : '') + '这是较旧的明文会话格式（版本 1），现代 Chrome 已不再写入。';
  }
  if (origin.racy) {
    return (when ? `来源文件时间 ${when}。` : '') + '读盘过程中文件仍在变化（浏览器可能正在写入），已多次重试后保留最后一次成功读到的内容，不能保证是完整的最终状态。';
  }
  if (origin.truncated) {
    return (when ? `来源文件时间 ${when}。` : '') + '文件末尾可能不完整（浏览器正在写入），已保留已读到的部分。';
  }
  return when
    ? `来源是会话文件（${origin.sourceFileBase || 'Session'}，文件时间 ${when}）。刚打开、尚未写盘的页签可能不会出现。不能保证与此刻页签条完全一致。`
    : '来源是会话文件。刚打开、尚未写盘的页签可能不会出现。不能保证与此刻页签条完全一致。';
}

module.exports = {
  RETRY_DELAYS,
  LOCK_TTL_MS,
  clearLockedCache,
  defaultIO,
  copyLocked,
  getLastCopyInfo,
  safeDiskChild,
  isPathInside,
  isSafeEntryName,
  joinUnder,
  listSessionFiles,
  sessionFileRole,
  pickChromiumSession,
  liveCount,
  filterHttpTabs,
  isHttp,
  NOISE,
  redactOrigin,
  basenameSafe,
  formatSourceClock,
  honestyNote,
  parseSession,
};
