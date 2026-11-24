'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../src/renderer/session-file-ui');
const cap = require('../src/renderer/capabilities');

describe('session-file UI entry and honest capability copy', () => {
  it('exposes a prominent no-extension entry and preview-then-save wording', () => {
    assert.equal(ui.entryTitle(), '从会话文件读取页签（无需扩展）');
    assert.match(ui.entryIntro(), /无需扩展/);
    assert.match(ui.entryIntro(), /预览再保存/);
    assert.match(ui.entryIntro(), /不会结束浏览器进程/);
    assert.match(ui.entryIntro(), /Firefox 本轮不在范围内/);
    assert.match(ui.entryIntro(), /扩展仍是可选增强/);
    assert.match(ui.previewFirstHint(), /预览/);
    assert.match(ui.emptyWorkspaceHint(), /从会话文件读取页签（无需扩展）/);
  });

  it('labels restore and close honestly for session-file snapshots', () => {
    const s = { source: 'session-file', persisted: true, origin: { stale: true, locked: true, sourceMtime: Date.now() }, extensionId: '', tabCount: 3 };
    assert.equal(ui.restoreButtonLabel(s), '按窗口重新打开网址…');
    assert.match(ui.sourceBadgeText(s), /会话文件/);
    assert.match(ui.sourceBadgeText(s), /不是此刻页签条/);
    assert.match(ui.closeDisabledReason(s), /不能按 tabId 关闭/);
    assert.equal(ui.canOfferPreciseClose(s), false);
    assert.match(ui.restoreHonesty(s), /不能恢复标签分组/);
    // Forged extension id must not enable close on a session-file snapshot
    assert.equal(ui.canOfferPreciseClose({ ...s, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), false);
  });

  it('keeps precise close only for real extension snapshots', () => {
    const ext = { source: 'extension', extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', persisted: true, closeStatus: 'none' };
    assert.equal(ui.canOfferPreciseClose(ext), true);
    assert.equal(ui.restoreButtonLabel(ext), '按组恢复…');
  });

  it('updates capability lists so session-file read is available without the extension', () => {
    const lists = cap.withoutExtensionCapabilities();
    assert.ok(lists.available.some((s) => /会话文件/.test(s)));
    assert.ok(lists.unavailable.some((s) => /tabId|分组|实时/.test(s)));
    assert.ok(!lists.unavailable.some((s) => s === '读取当前真实已打开的页签（不会从历史猜测）'));
  });
});

describe('renderer wires the session-file entry', () => {
  it('mounts the session-file UI module and calls the capture flow from the snapshot workspace', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    assert.match(html, /session-file-ui\.js/);
    assert.match(js, /startSessionFileCapture/);
    assert.match(js, /sessionFileListProfiles/);
    assert.match(js, /sessionFileSave/);
    assert.match(js, /session-file-window-reopen/);
  });
});
