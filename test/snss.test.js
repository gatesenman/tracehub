'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readCommands, parseSession, PickleReader, SESSION_CMD, MAX_FILE_BYTES, SnssError } = require('../src/shared/snss');
const b = require('./helpers/snss-build');

describe('SNSS parser', () => {
  it('reconstructs windows, tab order, selected navigation, pin, and drops closed tabs', () => {
    const parsed = parseSession(b.sampleTwoWindows());
    assert.equal(parsed.windows.length, 2);
    const w1 = parsed.windows[0];
    const w2 = parsed.windows[1];
    assert.equal(w1.id, 1);
    assert.deepEqual(w1.tabs.map((t) => t.url), [
      'https://github.com/electron/electron',
      'https://example.com/new',
      'chrome://settings/',
    ]);
    assert.equal(w1.tabs[0].pinned, true);
    assert.equal(w1.tabs[0].title, 'Electron');
    assert.equal(w1.tabs[1].title, 'Example');
    assert.equal(w1.tabs[1].pinned, false);
    assert.deepEqual(w1.tabs.map((t) => t.index), [0, 1, 2]);
    assert.equal(w2.tabs.length, 1);
    assert.equal(w2.tabs[0].url, 'https://www.bilibili.com/');
    assert.ok(!w1.tabs.some((t) => t.url.includes('gone.example')));
    assert.equal(parsed.ignoredTabGroupCommands, 2);
  });

  it('uses selected navigation, not an older history entry', () => {
    const buf = b.snss([
      b.tabWindow(1, 1), b.tabIndex(1, 0),
      b.nav(1, 0, 'https://a.example/old', 'old'),
      b.nav(1, 1, 'https://a.example/new', 'new'),
      b.selectedNav(1, 1),
      b.selectedTab(1, 0),
    ]);
    const [w] = parseSession(buf).windows;
    assert.equal(w.tabs[0].url, 'https://a.example/new');
    assert.equal(w.tabs[0].navigations.length, 2);
  });

  it('honors TabClosed and WindowClosed', () => {
    const buf = b.snss([
      b.tabWindow(1, 1), b.nav(1, 0, 'https://keep.example/', 'k'), b.selectedNav(1, 0),
      b.tabWindow(1, 2), b.nav(2, 0, 'https://drop-tab.example/', 'd'), b.tabClosed(2),
      b.tabWindow(2, 3), b.nav(3, 0, 'https://drop-win.example/', 'w'), b.windowClosed(2),
      b.selectedTab(1, 0),
    ]);
    const parsed = parseSession(buf);
    assert.equal(parsed.windows.length, 1);
    assert.deepEqual(parsed.windows[0].tabs.map((t) => t.url), ['https://keep.example/']);
  });

  it('rejects an invalid header and unsupported version', () => {
    assert.throws(() => readCommands(Buffer.from('nope')), /文件头无效|SNSS/);
    assert.throws(() => readCommands(Buffer.from('XXXX\x03\x00\x00\x00')), /文件头无效/);
    const badVer = Buffer.concat([Buffer.from('SNSS'), Buffer.from([99, 0, 0, 0])]);
    assert.throws(() => readCommands(badVer), /不支持的 SNSS 版本/);
  });

  it('tolerates a truncated trailing command', () => {
    const good = b.snss([b.tabWindow(1, 1)]);
    const truncated = Buffer.concat([good, Buffer.from([10, 0])]);
    const r = readCommands(truncated);
    assert.equal(r.commands.length, 1);
    assert.equal(r.truncated, true);
  });

  it('rejects oversized files and pickle string lengths', () => {
    assert.throws(() => readCommands(Buffer.alloc(MAX_FILE_BYTES + 1, 0)), /过大/);
    const huge = Buffer.alloc(12);
    huge.writeUInt32LE(0xffffffff, 0);
    assert.throws(() => new PickleReader(huge).string(), /过大|不合法/);
  });

  it('PickleReader aligns utf-8 and utf-16 strings', () => {
    const r = new PickleReader(b.pickle(7, 'hi', { s16: '中' }));
    assert.equal(r.int(), 7);
    assert.equal(r.string(), 'hi');
    assert.equal(r.string16(), '中');
  });
});

describe('SNSS parser vs official Chromium versions and layouts', () => {
  it('accepts current plaintext version 3 and ignores the initial-state marker (id 255)', () => {
    const marker = b.cmd(255, Buffer.alloc(0));
    const buf = b.snss([
      marker,
      b.tabWindow(1, 1),
      b.nav(1, 0, 'https://marker.example/', 'ok'),
      b.selectedNav(1, 0),
      b.selectedTab(1, 0),
    ], 3);
    const parsed = parseSession(buf);
    assert.equal(parsed.version, 3);
    assert.equal(parsed.hasMarker, true);
    assert.equal(parsed.windows.length, 1);
    assert.equal(parsed.windows[0].tabs[0].url, 'https://marker.example/');
  });

  it('rejects encrypted SNSS versions 2, 4 and 5 without inventing tabs', () => {
    for (const ver of [2, 4, 5]) {
      const raw = b.snss([
        b.tabWindow(1, 1),
        b.nav(1, 0, 'https://secret.example/', 'no'),
        b.selectedNav(1, 0),
      ], ver);
      assert.throws(() => readCommands(raw), /加密|无法解密|不支持/);
      assert.throws(() => parseSession(raw), /加密|无法解密|不支持/);
    }
  });

  it('parses legacy plaintext version 1 as a best-effort and marks it legacy', () => {
    const buf = b.snss([
      b.tabWindow(1, 1),
      b.nav(1, 0, 'https://legacy.example/', 'oldfmt'),
      b.selectedNav(1, 0),
      b.selectedTab(1, 0),
    ], 1);
    const parsed = parseSession(buf);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.legacyVersion, true);
    assert.equal(parsed.windows[0].tabs[0].url, 'https://legacy.example/');
  });

  it('ignores invalid SessionID values (0 and negative) and does not invent tab 0', () => {
    const buf = b.snss([
      b.tabWindow(0, 0),
      b.nav(0, 0, 'https://zero.example/', 'zero'),
      b.tabWindow(-1, -2),
      b.nav(-2, 0, 'https://neg.example/', 'neg'),
      b.tabWindow(1, 5),
      b.nav(5, 0, 'https://ok.example/', 'ok'),
      b.selectedNav(5, 0),
      b.selectedTab(1, 0),
    ]);
    const parsed = parseSession(buf);
    assert.equal(parsed.windows.length, 1);
    assert.equal(parsed.windows[0].id, 1);
    assert.deepEqual(parsed.windows[0].tabs.map((t) => t.url), ['https://ok.example/']);
  });

  it('reads LastActiveTime using the official aligned 16-byte payload (int32 + pad + int64)', () => {
    const payload = Buffer.alloc(16);
    payload.writeInt32LE(7, 0);
    payload.writeBigInt64LE(123456789n, 8);
    const buf = b.snss([
      b.tabWindow(1, 7),
      b.nav(7, 0, 'https://active.example/', 'a'),
      b.selectedNav(7, 0),
      b.cmd(SESSION_CMD.LastActiveTime, payload),
      b.selectedTab(1, 0),
    ]);
    const parsed = parseSession(buf);
    assert.equal(parsed.windows[0].tabs[0].lastActive, 123456789);
  });
});


describe('navigation boundaries and prune ordering', () => {
  it('rejects pickle declarations beyond actual command payload', () => {
    const raw = b.pickle(1, 0, 'https://bad.example/', {s16:'bad'});
    raw.writeUInt32LE(raw.length + 100, 0);
    assert.throws(() => new PickleReader(raw), /pickle/);
  });
  it('flags a one-byte trailing command header as truncated', () => {
    assert.equal(readCommands(Buffer.concat([b.snss([]), Buffer.from([1])])).truncated, true);
  });
  it('adjusts selected navigation when earlier entries are pruned', () => {
    const raw = b.snss([
      b.tabWindow(1,1), b.nav(1,0,'https://a.example/','a'),
      b.nav(1,1,'https://b.example/','b'), b.nav(1,2,'https://c.example/','c'),
      b.selectedNav(1,1), b.pruned(1,0,1),
    ]);
    assert.equal(parseSession(raw).windows[0].tabs[0].url,'https://b.example/');
  });
  it('does not resurrect a closed window from a later selected-tab command', () => {
    const raw=b.snss([b.tabWindow(1,1),b.nav(1,0,'https://closed.example/','c'),b.windowClosed(1),b.selectedTab(1,0)]);
    assert.equal(parseSession(raw).windows.length,0);
  });
});
