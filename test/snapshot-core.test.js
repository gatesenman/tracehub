'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const core = require('../src/shared/snapshot-core');

function sample(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'extension',
    capturedAt: 1700000000000,
    browser: { id: 'chrome', name: 'Google Chrome', profile: 'Default' },
    windows: [
      {
        windowId: 1,
        focused: true,
        type: 'normal',
        state: 'normal',
        tabs: [
          { tabId: 11, index: 0, url: 'https://github.com/foo', title: 'Foo', pinned: true, active: true },
          { tabId: 12, index: 1, url: 'https://github.com/foo#readme', title: 'Foo hash' },
          { tabId: 13, index: 2, url: 'https://www.youtube.com/watch?v=1', title: 'Video' },
          { tabId: 14, index: 3, url: 'chrome://settings/', title: 'Settings' },
        ],
      },
    ],
    ...overrides,
  };
}

describe('validateSnapshotPayload', () => {
  it('rejects empty / null', () => {
    assert.equal(core.validateSnapshotPayload(null).ok, false);
    assert.equal(core.validateSnapshotPayload(undefined).ok, false);
    assert.equal(core.validateSnapshotPayload('').ok, false);
  });

  it('rejects malformed JSON and non-objects', () => {
    assert.match(core.validateSnapshotPayload('{').error, /畸形/);
    assert.match(core.validateSnapshotPayload([1]).error, /对象/);
    assert.match(core.validateSnapshotPayload({}).error, /windows/);
  });

  it('rejects a snapshot with zero tabs', () => {
    const r = core.validateSnapshotPayload({ windows: [{ tabs: [] }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /空快照/);
  });

  it('rejects tabs without url and history-disguised payloads', () => {
    assert.equal(core.validateSnapshotPayload({ windows: [{ tabs: [{ title: 'x' }] }] }).ok, false);
    assert.equal(core.validateSnapshotPayload({ fromHistory: true, windows: [{ tabs: [{ url: 'https://a.com' }] }] }).ok, false);
    assert.equal(core.validateSnapshotPayload({ source: 'history', windows: [{ tabs: [{ url: 'https://a.com' }] }] }).ok, false);
  });

  it('accepts a well-formed live-tab payload', () => {
    const r = core.validateSnapshotPayload(sample());
    assert.equal(r.ok, true);
  });
});

describe('normalizeSnapshot + categorize + dedup', () => {
  it('keeps browser / profile / window / order / pinned', () => {
    const n = core.normalizeSnapshot(sample());
    assert.equal(n.browserId, 'chrome');
    assert.equal(n.profile, 'Default');
    assert.equal(n.windows[0].tabs[0].pinned, true);
    assert.equal(n.windows[0].tabs[0].tabIndex, 0);
    assert.equal(n.windows[0].tabs[3].restorable, false);
    assert.equal(n.tabCount, 4);
  });

  it('local pre-categorize assigns domain rules and keeps every tab', () => {
    const n = core.normalizeSnapshot(sample());
    const tabs = core.localPreCategorize(core.flattenTabs(n));
    assert.equal(tabs.length, 4);
    assert.equal(tabs[0].category, '开发/文档');
    assert.equal(tabs[2].category, '视频娱乐');
  });

  it('dedup preview marks later copies, does not drop rows', () => {
    const n = core.normalizeSnapshot(sample());
    const { tabs, uniqueCount, duplicateCount } = core.dedupPreview(core.flattenTabs(n));
    assert.equal(tabs.length, 4);
    assert.equal(duplicateCount, 1);
    assert.equal(uniqueCount, 3);
    assert.equal(tabs[1].hiddenDup, true);
  });
});

describe('close gate', () => {
  it('does not allow close when persist failed or not confirmed', () => {
    const base = { persisted: false, tabCount: 3, closeStatus: 'none' };
    assert.equal(core.assertCloseable(base, { userConfirmed: true, ackUnsavedRisk: true }).ok, false);
    assert.equal(core.assertCloseable({ ...base, persisted: true }, { userConfirmed: false, ackUnsavedRisk: true }).ok, false);
    assert.equal(core.assertCloseable({ ...base, persisted: true }, { userConfirmed: true, ackUnsavedRisk: false }).ok, false);
    const cancelled = core.markCloseCancelled({ ...base, persisted: true });
    assert.equal(core.assertCloseable(cancelled, { userConfirmed: true, ackUnsavedRisk: true }).ok, false);
  });

  it('allows close only after persist + user confirm + unsaved-risk ack', () => {
    const r = core.assertCloseable(
      { persisted: 1, tabCount: 2, closeStatus: 'none' },
      { userConfirmed: true, ackUnsavedRisk: true }
    );
    assert.equal(r.ok, true);
  });
});

describe('restore batching and AI merge fallback', () => {
  it('splits restore into small batches and skips non-http tabs', () => {
    const tabs = [];
    for (let i = 0; i < 25; i++) tabs.push({ url: `https://example.com/${i}`, restorable: true });
    tabs.push({ url: 'chrome://extensions/', restorable: false });
    const plan = core.batchRestorePlan(tabs, { batchSize: 8, offset: 0 });
    assert.equal(plan.total, 25);
    assert.equal(plan.batch.length, 8);
    assert.equal(plan.remaining, 17);
    assert.equal(plan.done, false);
    const last = core.batchRestorePlan(tabs, { batchSize: 8, offset: 24 });
    assert.equal(last.batch.length, 1);
    assert.equal(last.done, true);
    assert.match(plan.limitation, /不能恢复原页面的登录状态/);
  });

  it('caps batch size and can skip duplicates', () => {
    const tabs = [
      { url: 'https://a.com', hiddenDup: false, restorable: true },
      { url: 'https://a.com#x', hiddenDup: true, restorable: true },
    ];
    const plan = core.batchRestorePlan(tabs, { batchSize: 99, skipDuplicates: true });
    assert.equal(plan.batchSize, core.MAX_RESTORE_BATCH);
    assert.equal(plan.total, 1);
  });

  it('keeps every local tab when AI fails or returns a partial set', () => {
    const local = [
      { url: 'https://a.com', title: 'A', category: '其他', purpose: '其他', summary: '' },
      { url: 'https://b.com', title: 'B', category: '新闻资讯', purpose: '新闻资讯', summary: '' },
    ];
    const failed = core.mergeAiResults(local, null, { failed: true, error: 'network' });
    assert.equal(failed.failed, true);
    assert.equal(failed.tabs.length, 2);
    assert.equal(failed.tabs[1].category, '新闻资讯');

    const partial = core.mergeAiResults(local, [{ url: 'https://a.com', category: '工作工具', summary: '一份摘要', tags: ['A'] }]);
    assert.equal(partial.tabs[0].summary, '一份摘要');
    assert.equal(partial.tabs[1].category, '新闻资讯');
  });

  it('default AI payload is URL + title only', () => {
    const payload = core.minimizeAiPayload([
      { url: 'https://a.com', title: 'Hello', content: 'SECRET BODY', domain: 'a.com' },
    ]);
    assert.equal(payload[0].url, 'https://a.com');
    assert.equal(payload[0].title, 'Hello');
    assert.equal(payload[0].content, undefined);
  });
});

describe('save policy (收藏 / 稍后读 解耦)', () => {
  it('star does not also enqueue read-later', () => {
    assert.deepEqual(core.SAVE_POLICY.star, { addBookmark: true, addReadLater: false });
    assert.deepEqual(core.SAVE_POLICY.readLater, { addBookmark: false, addReadLater: true });
  });

  it('renderer addSaved must not call addReadLater (regression)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const m = src.match(/async function addSaved\([\s\S]*?\n\}/);
    assert.ok(m, 'addSaved should exist');
    assert.equal(/addReadLater/.test(m[0]), false, 'addSaved should not write the read-later queue');
    const rm = src.match(/async function removeSaved\([\s\S]*?\n\}/);
    assert.ok(rm);
    assert.equal(/removeReadLater/.test(rm[0]), false, 'removing a bookmark should not remove read-later');
  });
});
