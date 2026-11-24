'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pickChromiumSession, listSessionFiles, copyLocked, clearLockedCache, redactOrigin, honestyNote, filterHttpTabs } = require('../src/shared/session-files');
const { previewProfile, listChromiumProfiles, publicProfileList } = require('../src/shared/session-capture');
const { sampleTwoWindows, snss, tabWindow, nav, selectedNav, selectedTab } = require('./helpers/snss-build');
const { memoryIO } = require('./helpers/memory-fs');

const ROOT = '/fake/Chrome/User Data';
const PROF = '/fake/Chrome/User Data/Default';

describe('session file selection and preview', () => {
  beforeEach(() => clearLockedCache());

  it('lists Session_* and Tabs_* newest first, including legacy names', () => {
    const io = memoryIO({
      [PROF + '/Sessions/Session_1']: { buf: Buffer.from('SNSS'), mtime: 100 },
      [PROF + '/Sessions/Session_3']: { buf: Buffer.from('SNSS'), mtime: 300 },
      [PROF + '/Sessions/Tabs_2']: { buf: Buffer.from('SNSS'), mtime: 200 },
      [PROF + '/Current Session']: { buf: Buffer.from('SNSS'), mtime: 50 },
    });
    const files = listSessionFiles(PROF, io);
    assert.deepEqual(files.map((f) => f.path.split('/').pop() + ':' + f.kind), [
      'Session_3:session', 'Tabs_2:tabs', 'Session_1:session', 'Current Session:session',
    ]);
  });

  it('reads the newest Session_* when it is not locked (fresh)', () => {
    const fresh = sampleTwoWindows();
    const older = snss([tabWindow(9, 1), nav(1, 0, 'https://old.example/', 'old'), selectedNav(1, 0), selectedTab(9, 0)]);
    const files = [
      { path: 'Session_3', kind: 'session', mtime: 300 },
      { path: 'Session_2', kind: 'session', mtime: 200 },
    ];
    const r = pickChromiumSession(files, (f) => (f.path === 'Session_3' ? fresh : older));
    assert.equal(r.locked, false);
    assert.equal(r.stale, false);
    assert.equal(r.sourceFile, 'Session_3');
    assert.ok(r.windows.length >= 1);
  });

  it('falls back to an older unlocked file and flags stale when newest Session_* is locked', () => {
    const older = sampleTwoWindows();
    const files = [
      { path: '/p/Sessions/Session_3', kind: 'session', mtime: 300 },
      { path: '/p/Sessions/Session_2', kind: 'session', mtime: 200 },
    ];
    const r = pickChromiumSession(files, (f) => (f.path.endsWith('Session_3') ? null : older));
    assert.equal(r.locked, true);
    assert.equal(r.stale, true);
    assert.equal(r.sourceFile, '/p/Sessions/Session_2');
    assert.equal(r.sourceMtime, 200);
    const origin = redactOrigin(r);
    assert.equal(origin.sourceFileBase, 'Session_2');
    assert.ok(!JSON.stringify(origin).includes('/p/Sessions'));
    assert.match(honestyNote(origin), /不是此刻页签条|旧/);
  });

  it('everything locked → not a successful empty list at preview', () => {
    const io = memoryIO({
      [PROF + '/Sessions/Session_9']: { buf: sampleTwoWindows(), mtime: 900, locked: true },
    });
    const prev = previewProfile({
      browserId: 'chrome', browserName: 'Google Chrome', profile: 'Default',
      profileDir: PROF, io,
    });
    assert.equal(prev.ok, false);
    assert.equal(prev.tabCount, 0);
    assert.match(prev.error, /占用|未能读到/);
    assert.ok(!/成功/.test(prev.error) || /不会把空列表当作成功/.test(prev.error));
  });

  it('copyLocked does not retry an unchanged locked file after the first failure', () => {
    const io = memoryIO({
      '/x/Session_9': { buf: sampleTwoWindows(), locked: true, mtime: 1 },
    });
    assert.equal(copyLocked('/x/Session_9', 's', io), null);
    const n = io._reads.length;
    assert.equal(copyLocked('/x/Session_9', 's', io), null);
    assert.equal(io._reads.length, n);
  });

  it('preview keeps window order and pinned http tabs, drops chrome:// and closed, never uses History', () => {
    const io = memoryIO({
      [PROF + '/Sessions/Session_1']: { buf: sampleTwoWindows(), mtime: Date.parse('2026-11-20T12:00:00+08:00') },
      [PROF + '/History']: { buf: Buffer.from('SQLite format 3'), mtime: Date.now() },
    });
    const prev = previewProfile({
      browserId: 'chrome', browserName: 'Google Chrome', profile: 'Default',
      profileDir: PROF, io,
    });
    assert.equal(prev.ok, true);
    assert.equal(prev.windowCount, 2);
    assert.equal(prev.payload.source, 'session-file');
    assert.deepEqual(prev.windows[0].tabs.map((t) => t.url), [
      'https://github.com/electron/electron',
      'https://example.com/new',
    ]);
    assert.equal(prev.windows[0].tabs[0].pinned, true);
    assert.equal(prev.windows[0].tabs[0].tabId, null);
    assert.equal(prev.windows[1].tabs[0].url, 'https://www.bilibili.com/');
    assert.ok(prev.origin.sourceFileBase);
    assert.ok(!JSON.stringify(prev.payload).includes(PROF));
    assert.ok(!io._reads.some((p) => p.endsWith('/History')));
    assert.match(prev.honesty, /会话文件/);
  });

  it('parsed file with only internal pages is a failed empty read, not success', () => {
    const onlyChrome = snss([
      tabWindow(1, 1), nav(1, 0, 'chrome://newtab/', 'New Tab'), selectedNav(1, 0), selectedTab(1, 0),
    ]);
    const io = memoryIO({ [PROF + '/Sessions/Session_1']: onlyChrome });
    const prev = previewProfile({ browserId: 'chrome', profile: 'Default', profileDir: PROF, io });
    assert.equal(prev.ok, false);
    assert.match(prev.error, /没有可保存的 http\(s\) 页签/);
  });

  it('lists only Chrome/Edge profiles that have session files, and strips private paths', () => {
    const io = memoryIO({
      '/c/Default/Sessions/Session_1': sampleTwoWindows(),
      '/c/Profile 1/Sessions/Session_1': sampleTwoWindows(),
      '/c/System Profile/Sessions/Session_1': sampleTwoWindows(),
      '/e/Default/Current Session': sampleTwoWindows(),
    });
    const list = listChromiumProfiles({
      roots: [
        { id: 'chrome', name: 'Google Chrome', base: '/c' },
        { id: 'edge', name: 'Microsoft Edge', base: '/e' },
        { id: 'firefox', name: 'Firefox', base: '/fx' },
      ],
      io,
    });
    const pub = publicProfileList(list);
    assert.deepEqual(pub.map((p) => p.key), ['chrome::Default', 'chrome::Profile 1', 'edge::Default']);
    assert.ok(pub.every((p) => !('_profileDir' in p)));
    assert.ok(!JSON.stringify(pub).includes('/c/Default'));
  });

  it('Firefox browserId is rejected', () => {
    const r = previewProfile({ browserId: 'firefox', profile: 'default', profileDir: '/fx' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Firefox/);
  });
});
