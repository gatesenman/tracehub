'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const reopen = require('../src/shared/session-reopen');

function snap() {
  return {
    source: 'session-file',
    browserId: 'chrome',
    profile: 'Default',
    windows: [
      { windowIndex: 0, tabs: [
        { id: 't1', url: 'https://github.com/electron/electron', pinned: true },
        { id: 't2', url: 'https://example.com/new' },
      ] },
      { windowIndex: 1, tabs: [
        { id: 't3', url: 'https://www.bilibili.com/' },
        { id: 't4', url: 'chrome://settings/' },
      ] },
    ],
  };
}

describe('session-file window reopen and argument safety', () => {
  it('plans one launch group per window and skips non-http URLs', () => {
    const plan = reopen.planWindowReopen(snap());
    assert.equal(plan.via, 'session-file-window-reopen');
    assert.equal(plan.windowCount, 2);
    assert.deepEqual(plan.windows[0].urls, [
      'https://github.com/electron/electron',
      'https://example.com/new',
    ]);
    assert.deepEqual(plan.windows[1].urls, ['https://www.bilibili.com/']);
    assert.equal(plan.skippedNonHttp, 1);
    assert.equal(plan.pinnedRecorded, 1);
    assert.match(plan.limitation, /不能恢复标签分组/);
  });

  it('allow-lists profile, --new-window and http(s) URLs', () => {
    const built = reopen.buildWindowLaunch({
      browserId: 'chrome',
      exe: '/usr/bin/google-chrome',
      profile: 'Default',
      urls: ['https://example.com/a'],
    });
    assert.equal(built.ok, true);
    assert.deepEqual(built.args, ['--profile-directory=Default', '--new-window', 'https://example.com/a']);
  });

  it('rejects profile path injection and reserved names', () => {
    for (const bad of ['../Edge', 'Default/../../x', 'C:\\evil', 'Default;calc', '--user-data-dir=/tmp', 'Profile 1/foo', '']) {
      if (!bad) {
        const ok = reopen.buildWindowLaunch({
          browserId: 'chrome', exe: '/usr/bin/google-chrome', profile: '', urls: ['https://a.com/'],
        });
        assert.equal(ok.ok, true);
        assert.ok(!ok.args.some((a) => a.startsWith('--profile-directory')));
        continue;
      }
      assert.throws(
        () => reopen.buildWindowLaunch({
          browserId: 'chrome', exe: '/usr/bin/google-chrome', profile: bad, urls: ['https://a.com/'],
        }),
        /不安全|配置目录/
      );
    }
  });

  it('rejects javascript, file, data URLs and credentialed URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'about:blank',
      'https://user:secret@example.com/',
      '--remote-debugging-port=9222',
    ]) {
      assert.throws(() => reopen.assertSafeHttpUrl(url), /拒绝|只允许/);
    }
  });

  it('rejects debug flags, user-data-dir, and unknown flags even if mixed with good URLs', () => {
    assert.throws(
      () => reopen.assertSafeLaunchArgs(['--new-window', '--remote-debugging-port=9222', 'https://a.com/']),
      /拒绝/
    );
    assert.throws(
      () => reopen.assertSafeLaunchArgs(['--user-data-dir=/tmp/evil', 'https://a.com/']),
      /拒绝/
    );
    assert.throws(
      () => reopen.assertSafeLaunchArgs(['--load-extension=/tmp/x', 'https://a.com/']),
      /拒绝/
    );
    assert.throws(
      () => reopen.assertSafeLaunchArgs(['--foo-bar', 'https://a.com/']),
      /未允许/
    );
  });

  it('runs launches through a stub and never claims via=extension', async () => {
    const plan = reopen.planWindowReopen(snap());
    const built = reopen.buildSessionReopenLaunches({
      browserId: 'chrome',
      exe: '/usr/bin/google-chrome',
      profile: 'Profile 1',
      plan,
    });
    assert.equal(built.ok, true);
    assert.equal(built.launches.length, 2);
    const calls = [];
    const result = await reopen.runSessionReopenLaunches(built, async (exe, args) => {
      calls.push({ exe, args });
      return { ok: true };
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'session-file-window-reopen');
    assert.equal(result.pending, false);
    assert.equal(result.windows, 2);
    assert.equal(result.opened, 3);
    assert.equal(calls[0].args[0], '--profile-directory=Profile 1');
    assert.equal(calls[0].args[1], '--new-window');
    assert.ok(!JSON.stringify(result).includes('via":"extension'));
    assert.match(result.message, /不是扩展按布局恢复/);
  });
});
