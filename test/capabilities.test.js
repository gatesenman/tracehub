'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cap = require('../src/renderer/capabilities');

describe('live-tab capabilities (no extension vs paired)', () => {
  it('history URL reopen and JSON import do not require the extension', () => {
    const d = cap.describeBridge({ listening: false }, 1000);
    assert.equal(d.canReopenHistoryUrls, true);
    assert.equal(d.canImportSnapshotJson, true);
    assert.equal(d.canOpenSnapshotUrlsInDefaultBrowser, true);
    assert.equal(d.canCaptureLiveTabs, false);
    assert.equal(d.canRestoreLayout, false);
    assert.equal(d.canCloseLiveTabs, false);
    const lists = cap.withoutExtensionCapabilities();
    assert.ok(lists.available.some((s) => /历史/.test(s)));
    assert.ok(lists.unavailable.some((s) => /已打开的页签/.test(s)));
  });

  it('recent extension activity is required to claim live capture/restore/close', () => {
    const now = 1_000_000;
    const stale = cap.describeBridge({ listening: true, lastSeenAt: now - cap.RECENT_MS - 1 }, now);
    assert.equal(stale.listening, true);
    assert.equal(stale.recentlySeen, false);
    assert.equal(stale.canCaptureLiveTabs, false);
    assert.equal(cap.bridgeChipText(stale), '页签桥：等待扩展配对');

    const fresh = cap.describeBridge({ listening: true, lastSeenAt: now - 1000, lastExtensionId: 'ext-a' }, now);
    assert.equal(fresh.recentlySeen, true);
    assert.equal(fresh.canRestoreLayout, true);
    assert.equal(fresh.canCloseLiveTabs, true);
    assert.equal(cap.bridgeChipText(fresh), '页签桥：扩展已连接');
    assert.equal(fresh.lastExtensionId, 'ext-a');
  });

  it('history session copy does not claim live-tab or form protection', () => {
    const t = cap.historySessionDisclaimer();
    assert.match(t, /浏览历史/);
    assert.match(t, /不是恢复浏览器里当前已打开/);
    assert.doesNotMatch(t, /保护未保存/);
    assert.match(t, /扩展/);
  });
});

describe('today layout and session restore placement in source', () => {
  it('pins today session actions in the content header and makes the hour list flex-fill', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    assert.match(css, /#panel-today\s*\{[^}]*display:\s*flex/s);
    assert.match(css, /#panel-today\s+\.hour-list\s*\{[^}]*flex:\s*1/s);
    assert.match(css, /#panel-today\s+\.hour-row\s*\{[^}]*flex:\s*1/s);
    assert.match(html, /id="tdHours"/);
    assert.match(html, /id="bridgeChip"/);
    assert.match(js, /header-actions/);
    assert.match(js, /renderTodayHeaderActions|headerActions/);
    // The primary history-reopen CTA is built in the header, not only at the bottom of the day dashboard.
    assert.match(js, /重开今日访问过的页面/);
  });
});
