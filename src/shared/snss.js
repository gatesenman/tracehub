'use strict';

/**
 * Chromium SNSS ("Session Service") file parser.
 *
 * File layout (little-endian), as documented in Chromium:
 *   "SNSS" | int32 version | command*
 *   command = uint16 size | uint8 id | payload (size - 1 bytes)
 *
 * Command ids and payload shapes follow Chromium's SessionService
 * (components/sessions/core/session_service_commands.cc / .h). Chromium
 * source is BSD-licensed. This file is an independent TraceHub implementation.
 *
 * We studied the product approach of gatesenman/tabnest@fa599e443eb29ba64a8044baf0f41fdbf5d2b1e3
 * (session-file read, lock fallback). That repository has no LICENSE file
 * at its root and GitHub does not detect a license; only package.json
 * states "MIT". TraceHub therefore does not copy TabNest source or fixtures.
 *
 * This parser reconstructs open windows and tabs (url, title, order, pinned,
 * selected navigation). It does not interpret tab groups or window type/bounds
 * as a supported restore feature. It never reads History databases.
 */

const MAGIC = 'SNSS';
/** Official Chromium (command_storage_backend.cc): v3 is current plaintext with marker; v1 is pre-2021 plaintext, no longer written; v2/v4/v5 are encrypted and must not be parsed as cleartext. */
const LEGACY_PLAINTEXT_VERSION = 1;
const FILE_VERSION_WITH_MARKER = 3;
const ENCRYPTED_VERSIONS = Object.freeze([2, 4, 5]);
const INITIAL_STATE_MARKER_ID = 255;
const MIN_VERSION = 1;
const MAX_VERSION = 3;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMMANDS = 200000;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_TABS = 20000;
const MAX_WINDOWS = 2000;

/** Chromium SessionService command ids. */
const SESSION_CMD = Object.freeze({
  SetTabWindow: 0,
  SetTabIndexInWindow: 2,
  TabNavigationPathPrunedFromBack: 5,
  TabNavigationPathPrunedFromFront: 11,
  UpdateTabNavigation: 6,
  SetSelectedNavigationIndex: 7,
  SetSelectedTabInIndex: 8,
  SetWindowType: 9,
  SetPinnedState: 12,
  TabClosed: 16,
  WindowClosed: 17,
  SetActiveWindow: 20,
  LastActiveTime: 21,
  TabNavigationPathPruned: 24,
  SetTabGroup: 25,
});

class SnssError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SnssError';
    this.code = code || 'SNSS';
  }
}

function readCommands(buf) {
  if (!Buffer.isBuffer(buf)) throw new SnssError('不是会话文件缓冲区', 'INVALID_INPUT');
  if (buf.length > MAX_FILE_BYTES) {
    throw new SnssError(`会话文件过大（超过 ${MAX_FILE_BYTES} 字节），已拒绝读取`, 'TOO_LARGE');
  }
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== MAGIC) {
    throw new SnssError('不是有效的 SNSS 会话文件（文件头无效）', 'INVALID_HEADER');
  }
  const version = buf.readInt32LE(4);
  if (ENCRYPTED_VERSIONS.includes(version)) {
    throw new SnssError(`这是加密的会话文件（SNSS 版本 ${version}），当前版本无法解密读取。不会把它当作空会话或明文解析。`, 'ENCRYPTED');
  }
  if (version !== LEGACY_PLAINTEXT_VERSION && version !== FILE_VERSION_WITH_MARKER) {
    throw new SnssError(`不支持的 SNSS 版本 ${version}`, 'UNSUPPORTED_VERSION');
  }
  const commands = [];
  let p = 8;
  let truncated = false;
  while (p + 2 <= buf.length) {
    const size = buf.readUInt16LE(p);
    p += 2;
    // A zero-size command is a terminator. A short remaining payload means a mid-write.
    if (size === 0) break;
    if (p + size > buf.length) { truncated = true; break; }
    if (commands.length >= MAX_COMMANDS) {
      throw new SnssError('会话文件命令过多，已拒绝读取', 'TOO_MANY_COMMANDS');
    }
    commands.push({ id: buf.readUInt8(p), payload: buf.subarray(p + 1, p + size) });
    p += size;
  }
  if (p < buf.length) truncated = true;
  const hasMarker = commands.some((c) => c.id === INITIAL_STATE_MARKER_ID);
  return {
    version,
    commands,
    truncated,
    hasMarker,
    legacyVersion: version === LEGACY_PLAINTEXT_VERSION,
  };
}

/** Minimal Chromium base::Pickle reader (uint32 payload length, 4-byte aligned fields). */
class PickleReader {
  constructor(b) {
    if (!Buffer.isBuffer(b) || b.length < 4) throw new SnssError('pickle 过短', 'PICKLE');
    this.b = b;
    this.p = 4;
    const declared = b.readUInt32LE(0);
    if (declared > MAX_FILE_BYTES) throw new SnssError('pickle 声明长度过大', 'TOO_LARGE');
    if (4 + declared > b.length) throw new SnssError('pickle 声明长度越界', 'PICKLE');
    this.end = 4 + declared;
  }
  need(n) {
    if (n < 0 || this.p + n > this.end) throw new SnssError('pickle 越界', 'PICKLE');
  }
  int() {
    this.need(4);
    const v = this.b.readInt32LE(this.p);
    this.p += 4;
    return v;
  }
  string() {
    const len = this.int();
    if (len < 0 || len > MAX_STRING_BYTES) throw new SnssError('pickle 字符串长度不合法', 'TOO_LARGE');
    this.need((len + 3) & ~3);
    const s = this.b.toString('utf8', this.p, this.p + len);
    this.p += (len + 3) & ~3;
    return s;
  }
  string16() {
    const chars = this.int();
    if (chars < 0 || chars * 2 > MAX_STRING_BYTES) throw new SnssError('pickle 字符串长度不合法', 'TOO_LARGE');
    const bytes = chars * 2;
    this.need((bytes + 3) & ~3);
    const s = this.b.toString('utf16le', this.p, this.p + bytes);
    this.p += (bytes + 3) & ~3;
    return s;
  }
}

function parseNavigation(payload) {
  try {
    const r = new PickleReader(payload);
    const tabId = r.int();
    const index = r.int();
    const url = r.string();
    const title = r.string16();
    return { tabId, nav: { index, url, title } };
  } catch (e) {
    return null;
  }
}

function i32(b, o) {
  return (Buffer.isBuffer(b) && b.length >= o + 4) ? b.readInt32LE(o) : 0;
}

/** Chromium SessionID is valid only when the underlying int32 is > 0 (0 and -1 are invalid). */
function isValidSessionId(id) {
  return Number.isInteger(id) && id > 0;
}

/**
 * LastActiveTimePayload is { int32 tab_id; int64 last_active_time } with 4 bytes of
 * alignment padding on official Chromium builds (16-byte span). Packed 12-byte
 * payloads are still accepted for synthetic / unusual writers.
 */
function readLastActiveTime(b) {
  if (!Buffer.isBuffer(b)) return null;
  try {
    if (b.length >= 16) return Number(b.readBigInt64LE(8));
    if (b.length >= 12) return Number(b.readBigInt64LE(4));
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Rebuild the live window → tab tree from a Session_* / "Current Session" file.
 * Closed tabs/windows are excluded. The selected navigation is the current URL.
 */
function parseSession(buf) {
  const { version, commands, truncated, hasMarker, legacyVersion } = readCommands(buf);
  const tabs = new Map();
  const windows = new Map();
  const closedTabs = new Set();
  const closedWindows = new Set();
  let setTabGroupCount = 0;
  let setWindowTypeCount = 0;

  const tab = (id) => {
    if (!isValidSessionId(id)) return null;
    let t = tabs.get(id);
    if (!t) {
      t = { id, windowId: -1, index: 0, pinned: false, selectedNav: -1, lastActive: null, navs: new Map() };
      tabs.set(id, t);
    }
    return t;
  };

  for (const { id, payload: b } of commands) {
    if (id === INITIAL_STATE_MARKER_ID) continue;
    switch (id) {
      case SESSION_CMD.SetTabWindow: {
        const windowId = i32(b, 0);
        const tabId = i32(b, 4);
        if (!isValidSessionId(windowId) || !isValidSessionId(tabId)) break;
        const t = tab(tabId);
        t.windowId = windowId;
        if (!windows.has(t.windowId)) windows.set(t.windowId, { selectedTab: 0 });
        closedTabs.delete(t.id);
        break;
      }
      case SESSION_CMD.SetTabIndexInWindow: {
        const t = tab(i32(b, 0));
        if (t) t.index = i32(b, 4);
        break;
      }
      case SESSION_CMD.UpdateTabNavigation: {
        const r = parseNavigation(b);
        if (r && isValidSessionId(r.tabId)) {
          const t = tab(r.tabId);
          if (t) t.navs.set(r.nav.index, r.nav);
        }
        break;
      }
      case SESSION_CMD.SetSelectedNavigationIndex: {
        const t = tab(i32(b, 0));
        if (t) t.selectedNav = i32(b, 4);
        break;
      }
      case SESSION_CMD.SetSelectedTabInIndex: {
        const w = i32(b, 0);
        if (!isValidSessionId(w)) break;
        windows.set(w, { selectedTab: i32(b, 4) });
        // A selection update is not a window-open event; never resurrect a closed window.
        break;
      }
      case SESSION_CMD.SetPinnedState: {
        const t = tab(i32(b, 0));
        if (t) t.pinned = b.length > 4 && b[4] !== 0;
        break;
      }
      case SESSION_CMD.LastActiveTime: {
        const t = tab(i32(b, 0));
        if (t) {
          const ts = readLastActiveTime(b);
          if (ts != null) t.lastActive = ts;
        }
        break;
      }
      case SESSION_CMD.TabClosed: {
        const idClosed = i32(b, 0);
        if (isValidSessionId(idClosed)) closedTabs.add(idClosed);
        break;
      }
      case SESSION_CMD.WindowClosed: {
        const idClosed = i32(b, 0);
        if (isValidSessionId(idClosed)) closedWindows.add(idClosed);
        break;
      }
      case SESSION_CMD.TabNavigationPathPrunedFromBack: {
        if (b.length !== 8 || i32(b, 4) < 0) throw new SnssError('旧导航裁剪命令损坏', 'INVALID_COMMAND');
        const t = tab(i32(b, 0));
        if (t) for (const key of t.navs.keys()) if (key >= i32(b, 4)) t.navs.delete(key);
        break;
      }
      case SESSION_CMD.TabNavigationPathPrunedFromFront: {
        if (b.length !== 8 || i32(b, 4) <= 0) throw new SnssError('旧导航裁剪命令损坏', 'INVALID_COMMAND');
        const t = tab(i32(b, 0));
        if (!t) break;
        const count = i32(b, 4);
        t.selectedNav = t.selectedNav < count ? -1 : t.selectedNav - count;
        t.navs = new Map([...t.navs].filter(([k]) => k >= count).map(([k,v]) => [k-count,{...v,index:k-count}]));
        break;
      }
      case SESSION_CMD.TabNavigationPathPruned: {
        const t = tab(i32(b, 0));
        if (!t) break;
        const start = i32(b, 4);
        const count = i32(b, 8);
        if (start < 0 || count <= 0) break;
        if (t.selectedNav >= start && t.selectedNav < start + count) t.selectedNav = start - 1;
        else if (t.selectedNav >= start + count) t.selectedNav -= count;
        const next = new Map();
        for (const [k, v] of t.navs) {
          if (k < start) next.set(k, v);
          else if (k >= start + count) next.set(k - count, { ...v, index: k - count });
        }
        t.navs = next;
        break;
      }
      case SESSION_CMD.SetTabGroup:
        setTabGroupCount += 1;
        break;
      case SESSION_CMD.SetWindowType:
        setWindowTypeCount += 1;
        break;
      default:
        break;
    }
  }

  const out = new Map();
  for (const t of tabs.values()) {
    if (closedTabs.has(t.id) || t.windowId < 0 || closedWindows.has(t.windowId) || !t.navs.size) continue;
    if (out.size >= MAX_WINDOWS) break;
    const keys = [...t.navs.keys()].sort((a, b) => a - b);
    const cur = t.navs.get(t.selectedNav) || t.navs.get(keys[keys.length - 1]);
    if (!cur) continue;
    let w = out.get(t.windowId);
    if (!w) {
      w = { id: t.windowId, selectedTab: (windows.get(t.windowId) || {}).selectedTab || 0, tabs: [] };
      out.set(t.windowId, w);
    }
    if (w.tabs.length + 1 > MAX_TABS) continue;
    w.tabs.push({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      pinned: t.pinned,
      url: cur.url,
      title: cur.title,
      lastActive: t.lastActive,
      navigations: keys.map((k) => t.navs.get(k)),
    });
  }
  const list = [...out.values()].filter((w) => w.tabs.length);
  for (const w of list) w.tabs.sort((a, b) => a.index - b.index || a.id - b.id);
  list.sort((a, b) => a.id - b.id);
  return {
    version,
    truncated: !!truncated,
    hasMarker: !!hasMarker,
    legacyVersion: !!legacyVersion,
    windows: list,
    ignoredTabGroupCommands: setTabGroupCount,
    ignoredWindowTypeCommands: setWindowTypeCount,
  };
}

module.exports = {
  MAGIC,
  MIN_VERSION,
  MAX_VERSION,
  LEGACY_PLAINTEXT_VERSION,
  FILE_VERSION_WITH_MARKER,
  ENCRYPTED_VERSIONS,
  INITIAL_STATE_MARKER_ID,
  MAX_FILE_BYTES,
  MAX_COMMANDS,
  MAX_STRING_BYTES,
  SESSION_CMD,
  SnssError,
  isValidSessionId,
  readLastActiveTime,
  readCommands,
  PickleReader,
  parseSession,
};
