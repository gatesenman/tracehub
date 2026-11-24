'use strict';

/**
 * Discover Chrome / Edge profiles and build a preview/save payload from
 * session files. All filesystem access is injectable so tests never touch
 * a real user profile. Firefox is out of scope for this round.
 */

const path = require('path');
const os = require('os');
const {
  defaultIO,
  listSessionFiles,
  pickChromiumSession,
  copyLocked,
  filterHttpTabs,
  redactOrigin,
  honestyNote,
} = require('./session-files');

const SUPPORTED = [
  { id: 'chrome', name: 'Google Chrome' },
  { id: 'edge', name: 'Microsoft Edge' },
];

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function defaultChromiumRoots({ platform = process.platform, env = process.env } = {}) {
  const p = pathApi(platform);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  const appSupport = p.join(home, 'Library', 'Application Support');
  const config = env.XDG_CONFIG_HOME || p.join(home, '.config');
  const roots = [];
  if (platform === 'win32') {
    roots.push({ id: 'chrome', name: 'Google Chrome', base: p.join(local, 'Google', 'Chrome', 'User Data') });
    roots.push({ id: 'edge', name: 'Microsoft Edge', base: p.join(local, 'Microsoft', 'Edge', 'User Data') });
  } else if (platform === 'darwin') {
    roots.push({ id: 'chrome', name: 'Google Chrome', base: p.join(appSupport, 'Google', 'Chrome') });
    roots.push({ id: 'edge', name: 'Microsoft Edge', base: p.join(appSupport, 'Microsoft Edge') });
  } else {
    roots.push({ id: 'chrome', name: 'Google Chrome', base: p.join(config, 'google-chrome') });
    roots.push({ id: 'edge', name: 'Microsoft Edge', base: p.join(config, 'microsoft-edge') });
  }
  return roots;
}

function isProfileDirName(name) {
  return name === 'Default' || name === 'Guest Profile' || /^Profile \d+$/.test(name);
}

function profileKey(browserId, profile) {
  return `${browserId}::${profile}`;
}

function listChromiumProfiles({ roots, io } = {}) {
  const fsio = io || defaultIO();
  const out = [];
  for (const root of roots || []) {
    if (!SUPPORTED.some((s) => s.id === root.id)) continue;
    if (!fsio.exists(root.base)) continue;
    let names = [];
    try { names = fsio.readdir(root.base); } catch (e) { continue; }
    for (const entry of names) {
      const name = typeof entry === 'string' ? entry : (entry && entry.name) || '';
      if (!isProfileDirName(name)) continue;
      const profileDir = path.join(root.base, name);
      const files = listSessionFiles(profileDir, fsio);
      out.push({
        key: profileKey(root.id, name),
        browserId: root.id,
        browserName: root.name,
        profile: name,
        sessionFileCount: files.length,
        hasSessionFiles: files.length > 0,
        // profileDir is kept only in memory for the reader; list API should strip it.
        _profileDir: profileDir,
      });
    }
  }
  return out;
}

function publicProfileList(list) {
  return (list || []).map((p) => ({
    key: p.key,
    browserId: p.browserId,
    browserName: p.browserName,
    profile: p.profile,
    sessionFileCount: p.sessionFileCount,
    hasSessionFiles: p.hasSessionFiles,
  }));
}

function readProfileSession(profileDir, io = defaultIO()) {
  const files = listSessionFiles(profileDir, io);
  return pickChromiumSession(files, (f) => {
    const copied = copyLocked(f.path, f.kind, io);
    if (!copied) return null;
    try {
      if (Buffer.isBuffer(copied)) return copied;
      const buf = io.readFile(copied);
      if (io.rm) io.rm(copied);
      return buf;
    } catch (e) {
      if (io.rm && !Buffer.isBuffer(copied)) io.rm(copied);
      return null;
    }
  });
}

function windowsToPayload(parsedWindows) {
  const windows = [];
  (parsedWindows || []).forEach((w, wi) => {
    const kept = filterHttpTabs(w.tabs || []);
    if (!kept.length) return;
    windows.push({
      windowId: w.id,
      windowIndex: windows.length,
      sourceWindowIndex: wi,
      focused: false,
      type: 'normal',
      state: 'normal',
      tabs: kept.map((t, ti) => ({
        // SNSS internal ids are not Chrome tabIds; do not expose them as closeable tabId.
        sessionTabId: t.id,
        tabId: null,
        index: t.index != null ? t.index : ti,
        url: t.url,
        title: t.title || t.url,
        pinned: !!t.pinned,
        active: w.selectedTab === t.index,
      })),
    });
  });
  windows.forEach((w, i) => { w.windowIndex = i; });
  return windows;
}

function failPreview(error, extra = {}) {
  return {
    ok: false,
    error,
    windows: [],
    tabCount: 0,
    windowCount: 0,
    origin: redactOrigin(extra.origin || extra),
    honesty: honestyNote(redactOrigin(extra.origin || extra)),
    ...extra.public,
  };
}

/**
 * Preview a profile's session files. Empty or locked-with-no-fallback is a
 * failure, never a successful 0-tab snapshot.
 */
function previewProfile({ browserId, browserName, profile, profileDir, io } = {}) {
  const supported = SUPPORTED.find((s) => s.id === browserId);
  if (!supported) {
    return failPreview('本轮只支持从 Chrome 或 Edge 的会话文件读取，Firefox 和其他浏览器不在范围内。');
  }
  if (!profileDir) return failPreview('未指定配置目录');
  const fsio = io || defaultIO();
  const raw = readProfileSession(profileDir, fsio);
  const origin = redactOrigin(raw);
  const name = browserName || supported.name;
  if (!raw.parsed && raw.locked) {
    return failPreview(
      '当前会话文件被浏览器占用，未能读到页签。不会把空列表当作成功。可以稍后再试，或使用可选的 Chrome / Edge 扩展读取实时页签。应用不会结束浏览器进程来解锁文件。',
      { origin: raw, public: { browserId, browserName: name, profile, locked: true, stale: false } }
    );
  }
  if (!raw.parsed) {
    return failPreview(
      raw.error || '未找到可读取的会话文件，或文件无法解析。不会把空列表当作成功。',
      { origin: raw, public: { browserId, browserName: name, profile, locked: !!raw.locked, stale: !!raw.stale } }
    );
  }
  const windows = windowsToPayload(raw.windows);
  const tabCount = windows.reduce((n, w) => n + w.tabs.length, 0);
  if (!tabCount) {
    return failPreview(
      '读到的会话文件里没有可保存的 http(s) 页签（可能只有内部新标签页，或文件不完整）。不会把空列表当作成功。',
      { origin: raw, public: { browserId, browserName: name, profile, locked: !!raw.locked, stale: !!raw.stale } }
    );
  }
  const honesty = honestyNote(origin);
  return {
    ok: true,
    browserId,
    browserName: name,
    profile: profile || '',
    windows,
    tabCount,
    windowCount: windows.length,
    origin,
    honesty,
    locked: !!origin.locked,
    stale: !!origin.stale,
    payload: {
      source: 'session-file',
      capturedAt: origin.sourceMtime || Date.now(),
      title: undefined,
      browser: { id: browserId, name, profile: profile || '' },
      windows,
      origin,
    },
  };
}

module.exports = {
  SUPPORTED,
  defaultChromiumRoots,
  listChromiumProfiles,
  publicProfileList,
  profileKey,
  isProfileDirName,
  previewProfile,
  windowsToPayload,
  readProfileSession,
};
