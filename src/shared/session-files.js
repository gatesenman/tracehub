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
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, b) => fs.writeFileSync(p, b),
    readdir: (p) => fs.readdirSync(p),
    stat: (p) => fs.statSync(p),
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
function copyLocked(src, label = 'session', io = defaultIO()) {
  if (!io.exists(src)) return null;
  const sig = io.sig ? io.sig(src) : null;
  const hit = sig ? lockedCache.get(src) : undefined;
  if (hit && hit.sig === sig && Date.now() - hit.at < LOCK_TTL_MS) return null;
  const dir = io.tmpdir ? io.tmpdir() : path.join(os.tmpdir(), 'tracehub-session-read');
  try { if (io.mkdir) io.mkdir(dir); } catch (e) { /* ignore */ }
  const dest = path.join(dir, `${label}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`);
  const tryRead = () => {
    const buf = io.readFile(src);
    if (io.writeFile) io.writeFile(dest, buf);
    return io.writeFile ? dest : buf;
  };
  try {
    return tryRead();
  } catch (e) {
    for (const ms of RETRY_DELAYS) {
      if (io.sleep) io.sleep(ms);
      try { return tryRead(); } catch (e2) { /* continue */ }
    }
    if (sig) lockedCache.set(src, { sig, at: Date.now() });
    return null;
  }
}

function listSessionFiles(profileDir, io = defaultIO()) {
  const out = [];
  const add = (p, kind) => {
    try {
      if (!io.exists(p)) return;
      const st = io.stat(p);
      out.push({ path: p, kind, mtime: st.mtimeMs != null ? st.mtimeMs : +st.mtime, size: st.size || 0 });
    } catch (e) { /* ignore */ }
  };
  const sessionsDir = path.join(profileDir, 'Sessions');
  if (io.exists(sessionsDir)) {
    let names = [];
    try { names = io.readdir(sessionsDir); } catch (e) { names = []; }
    for (const f of names) {
      const name = typeof f === 'string' ? f : (f && f.name) || '';
      if (/^Session_/.test(name)) add(path.join(sessionsDir, name), 'session');
      else if (/^Tabs_/.test(name)) add(path.join(sessionsDir, name), 'tabs');
    }
  }
  for (const [name, kind] of [
    ['Current Session', 'session'],
    ['Current Tabs', 'tabs'],
    ['Last Session', 'session'],
    ['Last Tabs', 'tabs'],
  ]) {
    add(path.join(profileDir, name), kind);
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
 * Walk files newest → oldest. First readable Session_* and first readable
 * Tabs_* are both parsed; the one with more live tabs wins. If the newest
 * Session_* could not be read, result is marked locked (and stale when a
 * fallback file is used).
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
  };
  const newestSession = (files || []).find((f) => f.kind === 'session');
  const got = {};
  for (const f of files || []) {
    if (got[f.kind]) continue;
    let buf = null;
    try { buf = readFn(f); } catch (e) { buf = null; }
    if (!buf) {
      if (f === newestSession) res.locked = true;
      continue;
    }
    got[f.kind] = { f, buf };
    if (got.session && got.tabs) break;
  }

  const tryParse = (b) => {
    try {
      return parseSession(b);
    } catch (e) {
      return { windows: [], error: e };
    }
  };
  const s = got.session ? tryParse(got.session.buf) : { windows: [] };
  const t = got.tabs ? tryParse(got.tabs.buf) : { windows: [] };
  const useTabs = liveCount(t.windows) > liveCount(s.windows);
  const chosen = useTabs ? t : s;
  const src = useTabs ? got.tabs : got.session;
  res.windows = chosen.windows || [];
  res.truncated = !!chosen.truncated;
  res.ignoredTabGroupCommands = chosen.ignoredTabGroupCommands || 0;
  if (chosen.error && !res.windows.length) {
    res.error = chosen.error instanceof SnssError ? chosen.error.message : (chosen.error.message || String(chosen.error));
  }
  if (src) {
    res.parsed = true;
    res.sourceMtime = src.f.mtime;
    res.sourceFile = src.f.path;
    const newestOfKind = (files || []).find((f) => f.kind === src.f.kind);
    res.stale = res.locked || (newestOfKind && newestOfKind !== src.f);
  } else if (res.locked) {
    res.error = res.error || '当前会话文件被浏览器占用，未能读到页签';
  }
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
    sourceMtime: Number.isFinite(mtime) ? mtime : null,
    sourceFileBase: basenameSafe(readResult && readResult.sourceFile),
    truncated: !!(readResult && readResult.truncated),
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
  if (origin.stale || origin.locked) {
    return when
      ? `这是 ${when} 的会话存档，不是此刻页签条。当前会话文件可能被浏览器占用，已回退到较旧、可读取的文件。`
      : '读到的是较旧的会话存档，不是此刻页签条。当前会话文件可能被浏览器占用。';
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
  listSessionFiles,
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
