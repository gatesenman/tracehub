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
const MIN_VERSION = 1;
const MAX_VERSION = 4;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMMANDS = 200000;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_TABS = 20000;
const MAX_WINDOWS = 2000;

/** Chromium SessionService command ids. */
const SESSION_CMD = Object.freeze({
  SetTabWindow: 0,
  SetTabIndexInWindow: 2,
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
  if (version < MIN_VERSION || version > MAX_VERSION) {
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
  return { version, commands, truncated };
}

/** Minimal Chromium base::Pickle reader (uint32 payload length, 4-byte aligned fields). */
class PickleReader {
  constructor(b) {
    if (!Buffer.isBuffer(b) || b.length < 4) throw new SnssError('pickle 过短', 'PICKLE');
    this.b = b;
    this.p = 4;
    const declared = b.readUInt32LE(0);
    if (declared > MAX_FILE_BYTES) throw new SnssError('pickle 声明长度过大', 'TOO_LARGE');
    this.end = Math.min(b.length, 4 + declared);
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
    this.need(len);
    const s = this.b.toString('utf8', this.p, this.p + len);
    this.p += (len + 3) & ~3;
    return s;
  }
  string16() {
    const chars = this.int();
    if (chars < 0 || chars * 2 > MAX_STRING_BYTES) throw new SnssError('pickle 字符串长度不合法', 'TOO_LARGE');
    const bytes = chars * 2;
    this.need(bytes);
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
    let title = '';
    try { title = r.string16(); } catch (e) { /* some entries omit the title */ }
    return { tabId, nav: { index, url, title } };
  } catch (e) {
    return null;
  }
}

function i32(b, o) {
  return (Buffer.isBuffer(b) && b.length >= o + 4) ? b.readInt32LE(o) : 0;
}

/**
 * Rebuild the live window → tab tree from a Session_* / "Current Session" file.
 * Closed tabs/windows are excluded. The selected navigation is the current URL.
 */
function parseSession(buf) {
  const { version, commands, truncated } = readCommands(buf);
  const tabs = new Map();
  const windows = new Map();
  const closedTabs = new Set();
  const closedWindows = new Set();
  let setTabGroupCount = 0;
  let setWindowTypeCount = 0;

  const tab = (id) => {
    let t = tabs.get(id);
    if (!t) {
      t = { id, windowId: -1, index: 0, pinned: false, selectedNav: -1, lastActive: null, navs: new Map() };
      tabs.set(id, t);
    }
    return t;
  };

  for (const { id, payload: b } of commands) {
    switch (id) {
      case SESSION_CMD.SetTabWindow: {
        const t = tab(i32(b, 4));
        t.windowId = i32(b, 0);
        if (!windows.has(t.windowId)) windows.set(t.windowId, { selectedTab: 0 });
        closedTabs.delete(t.id);
        break;
      }
      case SESSION_CMD.SetTabIndexInWindow:
        tab(i32(b, 0)).index = i32(b, 4);
        break;
      case SESSION_CMD.UpdateTabNavigation: {
        const r = parseNavigation(b);
        if (r) tab(r.tabId).navs.set(r.nav.index, r.nav);
        break;
      }
      case SESSION_CMD.SetSelectedNavigationIndex:
        tab(i32(b, 0)).selectedNav = i32(b, 4);
        break;
      case SESSION_CMD.SetSelectedTabInIndex: {
        const w = i32(b, 0);
        windows.set(w, { selectedTab: i32(b, 4) });
        closedWindows.delete(w);
        break;
      }
      case SESSION_CMD.SetPinnedState:
        tab(i32(b, 0)).pinned = b.length > 4 && b[4] !== 0;
        break;
      case SESSION_CMD.LastActiveTime:
        if (b.length >= 12) tab(i32(b, 0)).lastActive = Number(b.readBigInt64LE(4));
        break;
      case SESSION_CMD.TabClosed:
        closedTabs.add(i32(b, 0));
        break;
      case SESSION_CMD.WindowClosed:
        closedWindows.add(i32(b, 0));
        break;
      case SESSION_CMD.TabNavigationPathPruned: {
        const t = tab(i32(b, 0));
        const start = i32(b, 4);
        const count = i32(b, 8);
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
    windows: list,
    ignoredTabGroupCommands: setTabGroupCount,
    ignoredWindowTypeCommands: setWindowTypeCount,
  };
}

module.exports = {
  MAGIC,
  MIN_VERSION,
  MAX_VERSION,
  MAX_FILE_BYTES,
  MAX_COMMANDS,
  MAX_STRING_BYTES,
  SESSION_CMD,
  SnssError,
  readCommands,
  PickleReader,
  parseSession,
};
