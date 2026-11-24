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

describe('session file selection must not treat Tabs_* or older many-tab files as current', () => {
  function oneTab(url) {
    return snss([
      tabWindow(1, 1), nav(1, 0, url, 't'), selectedNav(1, 0), selectedTab(1, 0),
    ]);
  }
  function manyTabs(n, prefix) {
    const cmds = [];
    for (let i = 0; i < n; i += 1) {
      const id = i + 1;
      cmds.push(tabWindow(1, id), nav(id, 0, `${prefix}${id}`, 't' + id), selectedNav(id, 0));
    }
    cmds.push(selectedTab(1, 0));
    return snss(cmds);
  }

  it('does not prefer an older Tabs_* file that contains more pages than a newer Session_* file', () => {
    const newer = oneTab('https://current.example/');
    const olderMany = manyTabs(8, 'https://old-tabs.example/');
    const files = [
      { path: '/p/Sessions/Session_9', kind: 'session', mtime: 900 },
      { path: '/p/Sessions/Tabs_1', kind: 'tabs', mtime: 100 },
    ];
    const r = pickChromiumSession(files, (f) => (f.kind === 'session' ? newer : olderMany));
    assert.equal(r.sourceFile, '/p/Sessions/Session_9');
    assert.equal(r.stale, false);
    assert.equal(r.windows.length, 1);
    assert.equal(r.windows[0].tabs.length, 1);
    assert.equal(r.windows[0].tabs[0].url, 'https://current.example/');
  });

  it('does not parse Tab Restore (Tabs_*) command id 1 as a live Session Service navigation', () => {
    // Official Tab Restore Service uses UpdateTabNavigation = 1 (not 6).
    const { cmd, pickle, i32, snss: build } = require('./helpers/snss-build');
    const tabsRestore = build([
      cmd(1, pickle(1, 0, 'https://recently-closed.example/', { s16: 'closed' })),
    ]);
    const live = oneTab('https://live.example/');
    const files = [
      { path: '/p/Sessions/Session_2', kind: 'session', mtime: 200 },
      { path: '/p/Sessions/Tabs_9', kind: 'tabs', mtime: 900 },
    ];
    const r = pickChromiumSession(files, (f) => (f.kind === 'tabs' ? tabsRestore : live));
    assert.equal(r.sourceFile, '/p/Sessions/Session_2');
    assert.deepEqual(r.windows[0].tabs.map((t) => t.url), ['https://live.example/']);
    assert.ok(!(r.windows || []).some((w) => (w.tabs || []).some((t) => /recently-closed/.test(t.url))));
  });

  it('prefers a slightly older Session_* that has the official initial-state marker over a newer file without one', () => {
    const { cmd } = require('./helpers/snss-build');
    const complete = snss([
      cmd(255, Buffer.alloc(0)),
      tabWindow(1, 1), nav(1, 0, 'https://complete.example/', 'c'), selectedNav(1, 0), selectedTab(1, 0),
    ]);
    const incomplete = oneTab('https://incomplete.example/');
    const files = [
      { path: '/p/Sessions/Session_new', kind: 'session', mtime: 500 },
      { path: '/p/Sessions/Session_old', kind: 'session', mtime: 400 },
    ];
    const r = pickChromiumSession(files, (f) => (f.path.endsWith('Session_new') ? incomplete : complete));
    assert.equal(r.sourceFile, '/p/Sessions/Session_old');
    assert.equal(r.stale, true);
    assert.equal(r.incompleteNewest, true);
    assert.equal(r.windows[0].tabs[0].url, 'https://complete.example/');
  });

  it('marks Last Session as previous-session even when it is the only readable file', () => {
    const last = oneTab('https://last-session.example/');
    const files = [
      { path: '/p/Last Session', kind: 'session', mtime: 50 },
    ];
    const r = pickChromiumSession(files, () => last);
    assert.equal(r.sourceFile, '/p/Last Session');
    assert.equal(r.lastSession, true);
    const origin = redactOrigin(r);
    assert.equal(origin.sourceFileBase, 'Last Session');
    assert.match(honestyNote(origin), /上次会话/);
  });
});

describe('profile path escape and fake directories', () => {
  const { isProfileDirName } = require('../src/shared/session-capture');

  it('does not follow a session filename that tries to escape the profile directory', () => {
    const pathMod = require('path');
    const evilName = 'Session_../../../../secret/outside.snss';
    const naive = pathMod.join(PROF, 'Sessions', evilName);
    const io = memoryIO({
      [PROF + '/Sessions/Session_ok']: sampleTwoWindows(),
      [naive]: sampleTwoWindows(),
    });
    const probed = [];
    for (const method of ['exists', 'stat', 'readFile']) {
      const orig = io[method].bind(io);
      io[method] = (p, ...rest) => {
        probed.push(p);
        return orig(p, ...rest);
      };
    }
    const origRead = io.readdir.bind(io);
    io.readdir = (p) => {
      const names = origRead(p);
      if (String(p).endsWith('/Sessions') || String(p).endsWith('/Sessions/')) {
        return [evilName, ...names];
      }
      return names;
    };
    const inside = (p) => {
      const rel = pathMod.relative(PROF, pathMod.resolve(String(p)));
      return rel === '' || (rel && !rel.startsWith('..') && !pathMod.isAbsolute(rel));
    };
    const files = listSessionFiles(PROF, io);
    assert.ok(files.every((f) => inside(f.path)), files.map((f) => f.path).join(','));
    assert.ok(!files.some((f) => f.path === naive || /outside/.test(f.path)));
    assert.ok(files.some((f) => f.path.endsWith('/Sessions/Session_ok')));
    // copyLocked may read a temp copy outside the profile; that is expected.
    // The escaped session path must never be probed.
    assert.ok(!probed.some((p) => p === naive || String(p).includes('outside.snss')), 'probed escaped path: ' + probed.join(','));
    const prev = previewProfile({
      browserId: 'chrome', profile: 'Default', profileDir: PROF, io,
    });
    assert.equal(prev.ok, true);
    assert.ok(!io._reads.some((p) => p === naive || String(p).includes('outside.snss')));
    assert.ok(!probed.some((p) => p === naive));
  });

  it('does not treat a plain file named Default as a Chrome profile directory', () => {
    const io = memoryIO({
      '/c/Default': { buf: Buffer.from('I am a file, not a profile'), mtime: 1 },
      '/c/Profile 1/Sessions/Session_1': sampleTwoWindows(),
    });
    const list = listChromiumProfiles({
      roots: [{ id: 'chrome', name: 'Google Chrome', base: '/c' }],
      io,
    });
    assert.deepEqual(list.map((p) => p.profile), ['Profile 1']);
  });

  it('rejects a profileDir whose last component is not an allow-listed name or that escapes its root', () => {
    const io = memoryIO({
      '/c/Default/Sessions/Session_1': sampleTwoWindows(),
      '/secret/Default/Sessions/Session_1': sampleTwoWindows(),
    });
    const escaped = previewProfile({
      browserId: 'chrome',
      profile: 'Default',
      profileDir: '/c/Default/../../secret/Default',
      io,
      roots: [{ id: 'chrome', name: 'Google Chrome', base: '/c' }],
    });
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /配置目录|不安全|逃逸/);
    assert.ok(!io._reads.some((p) => String(p).startsWith('/secret/')));

    const fakeName = previewProfile({
      browserId: 'chrome',
      profile: 'System Profile',
      profileDir: '/c/System Profile',
      io,
      roots: [{ id: 'chrome', name: 'Google Chrome', base: '/c' }],
    });
    assert.equal(fakeName.ok, false);
    assert.equal(isProfileDirName('System Profile'), false);
    assert.equal(isProfileDirName('Default/../Default'), false);
  });
});


describe('lock, truncation and mid-read race', () => {
  it('retries when the session file grows after a successful mid-write read', () => {
    const { parseSession } = require('../src/shared/snss');
    const partial = Buffer.concat([
      snss([tabWindow(1, 1), nav(1, 0, 'https://partial.example/', 'p'), selectedNav(1, 0)]),
      Buffer.from([20, 0]),
    ]);
    const complete = snss([
      tabWindow(1, 1), nav(1, 0, 'https://final.example/', 'f'), selectedNav(1, 0), selectedTab(1, 0),
    ]);
    const io = memoryIO({ '/x/Session_racy': { buf: partial, mtime: 10 } });
    let reads = 0;
    const origRead = io.readFile.bind(io);
    io.readFile = (p) => {
      const buf = origRead(p);
      reads += 1;
      if (p === '/x/Session_racy' && reads === 1) {
        const rec = io._store.get('/x/Session_racy');
        rec.buf = complete;
        rec.size = complete.length;
        rec.mtime = 11;
      }
      return buf;
    };
    const written = [];
    const origWrite = io.writeFile.bind(io);
    io.writeFile = (p, b) => {
      written.push(Buffer.from(b));
      return origWrite(p, b);
    };
    const dest = copyLocked('/x/Session_racy', 's', io);
    assert.ok(dest);
    assert.ok(reads >= 2, 'should retry after size/mtime change, reads=' + reads);
    const last = written[written.length - 1];
    const parsed = parseSession(last);
    assert.equal(parsed.windows[0].tabs[0].url, 'https://final.example/');
    assert.equal(parsed.truncated, false);
  });

  it('preview reports a still-changing file after retries and keeps last successful bytes', () => {
    const complete = snss([
      tabWindow(1, 1), nav(1, 0, 'https://racy-final.example/', 'f'), selectedNav(1, 0), selectedTab(1, 0),
    ]);
    const io = memoryIO({
      [PROF + '/Sessions/Session_1']: { buf: complete, mtime: 10 },
    });
    const origRead = io.readFile.bind(io);
    const origSig = io.sig.bind(io);
    let n = 0;
    io.readFile = (p) => {
      const buf = origRead(p);
      if (String(p).includes('Session_1')) {
        n += 1;
        const rec = io._store.get(PROF + '/Sessions/Session_1');
        rec.mtime = 10 + n;
        rec.size = rec.buf.length + n; // signature changes; content stays a valid complete file
      }
      return buf;
    };
    const prev = previewProfile({ browserId: 'chrome', profile: 'Default', profileDir: PROF, io });
    assert.equal(prev.ok, true);
    assert.equal(prev.windows[0].tabs[0].url, 'https://racy-final.example/');
    assert.equal(prev.origin.racy, true);
    assert.match(prev.honesty, /正在写入|竞态|读盘过程中/);
  });
});
