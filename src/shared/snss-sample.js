/** Synthetic SNSS samples for isolated tests and self-test. Not user data. */
'use strict';

const { SESSION_CMD } = require('./snss');

function pickle(...parts) {
  const chunks = [];
  for (const p of parts) {
    if (typeof p === 'number') {
      const b = Buffer.alloc(4);
      b.writeInt32LE(p);
      chunks.push(b);
    } else if (typeof p === 'string') {
      const raw = Buffer.from(p, 'utf8');
      const len = Buffer.alloc(4);
      len.writeInt32LE(raw.length);
      const pad = Buffer.alloc((4 - (raw.length % 4)) % 4);
      chunks.push(len, raw, pad);
    } else if (p && Object.prototype.hasOwnProperty.call(p, 's16')) {
      const raw = Buffer.from(p.s16, 'utf16le');
      const len = Buffer.alloc(4);
      len.writeInt32LE(p.s16.length);
      const pad = Buffer.alloc((4 - (raw.length % 4)) % 4);
      chunks.push(len, raw, pad);
    } else {
      throw new Error('bad pickle part');
    }
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function cmd(id, payload) {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(payload.length + 1);
  return Buffer.concat([size, Buffer.from([id]), payload]);
}

function i32(...ns) {
  const b = Buffer.alloc(ns.length * 4);
  ns.forEach((n, i) => b.writeInt32LE(n, i * 4));
  return b;
}

function snss(commands, version = 3) {
  const magic = Buffer.from('SNSS');
  const ver = Buffer.alloc(4);
  ver.writeInt32LE(version);
  return Buffer.concat([magic, ver, ...commands]);
}

function nav(tab, idx, url, title) {
  return cmd(SESSION_CMD.UpdateTabNavigation, pickle(tab, idx, url, { s16: title }));
}

function tabWindow(windowId, tabId) {
  return cmd(SESSION_CMD.SetTabWindow, i32(windowId, tabId));
}

function tabIndex(tabId, index) {
  return cmd(SESSION_CMD.SetTabIndexInWindow, i32(tabId, index));
}

function selectedNav(tabId, index) {
  return cmd(SESSION_CMD.SetSelectedNavigationIndex, i32(tabId, index));
}

function selectedTab(windowId, index) {
  return cmd(SESSION_CMD.SetSelectedTabInIndex, i32(windowId, index));
}

function pinned(tabId, on) {
  return cmd(SESSION_CMD.SetPinnedState, Buffer.concat([i32(tabId), Buffer.from([on ? 1 : 0])]));
}

function tabClosed(tabId) {
  return cmd(SESSION_CMD.TabClosed, i32(tabId));
}

function windowClosed(windowId) {
  return cmd(SESSION_CMD.WindowClosed, i32(windowId));
}

function pruned(tabId, start, count) {
  return cmd(SESSION_CMD.TabNavigationPathPruned, i32(tabId, start, count));
}

function setTabGroup(tabId, groupId) {
  return cmd(SESSION_CMD.SetTabGroup, i32(tabId, groupId));
}

function sampleTwoWindows() {
  return snss([
    tabWindow(1, 10), tabIndex(10, 0), pinned(10, true),
    nav(10, 0, 'https://github.com/electron/electron', 'Electron'),
    selectedNav(10, 0),
    tabWindow(1, 11), tabIndex(11, 1),
    nav(11, 0, 'https://example.com/old', 'old'),
    nav(11, 1, 'https://example.com/new', 'Example'),
    selectedNav(11, 1),
    pruned(11, 0, 1),
    selectedNav(11, 0),
    tabWindow(1, 12), tabIndex(12, 2),
    nav(12, 0, 'chrome://settings/', 'Settings'),
    selectedNav(12, 0),
    tabWindow(1, 13), nav(13, 0, 'https://gone.example/', 'Gone'), tabClosed(13),
    selectedTab(1, 0),
    tabWindow(2, 20), tabIndex(20, 0),
    nav(20, 0, 'https://www.bilibili.com/', '哔哩哔哩'),
    selectedNav(20, 0),
    selectedTab(2, 0),
    setTabGroup(10, 5),
    setTabGroup(11, 5),
  ]);
}

module.exports = {
  pickle, cmd, i32, snss, nav, tabWindow, tabIndex, selectedNav, selectedTab,
  pinned, tabClosed, windowClosed, pruned, setTabGroup, sampleTwoWindows, SESSION_CMD,
};
