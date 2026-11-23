'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ext = require('../src/shared/extension-session');

describe('queued restore/close copy tells the truth about pairing freshness', () => {
  it('treats a missing or stale lastSeen as not recently seen', () => {
    const now = 1_000_000;
    assert.equal(ext.isRecentlySeen(null, now), false);
    assert.equal(ext.isRecentlySeen(0, now), false);
    assert.equal(ext.isRecentlySeen(now - ext.RECENT_MS - 1, now), false);
    assert.equal(ext.isRecentlySeen(now - 1000, now), true);
  });

  it('does not claim the extension will run immediately when it has not been seen', () => {
    const r = ext.describeQueuedCommand({
      kind: 'restore',
      recentlySeen: false,
      batchCount: 8,
      total: 12,
      remaining: 4,
    });
    assert.equal(r.recentlySeen, false);
    assert.match(r.message, /最近没有检测到配对扩展/);
    assert.match(r.message, /打开扩展弹出页/);
    assert.match(r.message, /不会标记为已恢复/);
    assert.doesNotMatch(r.message, /已向配对扩展发出恢复请求/);
  });

  it('warns that a closed popup may wait on the browser alarm, and flags a different extension id', () => {
    const r = ext.describeQueuedCommand({
      kind: 'close',
      recentlySeen: true,
      lastExtensionId: 'ext-a',
      expectedExtensionId: 'ext-b',
      batchCount: 3,
    });
    assert.equal(r.recentlySeen, true);
    assert.equal(r.extensionMismatch, true);
    assert.match(r.message, /后台闹钟/);
    assert.match(r.message, /当初保存这份快照的扩展/);
    assert.match(r.message, /不能保护未保存表单/);
    assert.doesNotMatch(r.message, /最近没有检测到/);
  });
});
