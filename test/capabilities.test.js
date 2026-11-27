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
    assert.ok(lists.unavailable.some((s) => /tabId|分组|实时/.test(s)));
    assert.ok(lists.available.some((s) => /会话文件/.test(s)));
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

describe('quick install guidance and pairing feedback', () => {
  it('uses three official unpacked-load steps and does not claim silent install or a store listing', () => {
    const steps = cap.quickInstallSteps();
    assert.equal(steps.length, 3);
    assert.deepEqual(steps, cap.extensionSetupSteps());
    assert.ok(steps.some((s) => /加载已解压的扩展程序/.test(s)));
    assert.ok(steps.some((s) => /不会替你静默安装/.test(s)));
    assert.ok(steps.some((s) => /复制配对令牌/.test(s)));
    const store = cap.webStoreFutureNote();
    assert.match(store, /网上应用店|扩展商店/);
    assert.match(store, /没有商店发布账号/);
    assert.doesNotMatch(store, /已经上架/);
  });

  it('only reports pairing success when lastSeen flips from unseen to seen after a baseline sample', () => {
    assert.equal(cap.pairingSucceeded(null, { recentlySeen: true }), false);
    assert.equal(cap.pairingSucceeded({ recentlySeen: false }, { recentlySeen: true }), true);
    assert.equal(cap.pairingSucceeded({ recentlySeen: true }, { recentlySeen: true }), false);
    assert.equal(cap.pairingSucceeded({ recentlySeen: true }, { recentlySeen: false }), false);
    assert.match(cap.pairingSuccessMessage(), /扩展已连接/);
  });

  it('exposes one-click official extensions page actions in the snapshot and settings UI', () => {
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    const pre = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
    const svc = fs.readFileSync(path.join(__dirname, '../src/main/snapshot-service.js'), 'utf8');
    assert.match(js, /打开 Chrome 扩展页/);
    assert.match(js, /打开 Edge 扩展页/);
    assert.match(js, /openOfficialExtensionsPage\('chrome'\)/);
    assert.match(js, /pairingSucceeded\(/);
    assert.match(html, /id="cfgOpenChromeExt"/);
    assert.match(html, /id="cfgOpenEdgeExt"/);
    assert.match(pre, /extension:open-management-page/);
    assert.match(svc, /extension:open-management-page/);
    assert.doesNotMatch(js, /--load-extension/);
    assert.doesNotMatch(js, /ExtensionInstallForcelist/);
  });
});

describe('today session reopen is visible and honest', () => {
  it('does not call history session reopen a live work-site restore', () => {
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
    assert.match(js, /重开本时段访问过的网址/);
    assert.match(js, /hour-reopen/);
    assert.match(js, /按浏览历史用系统默认浏览器打开网址，不是恢复当时已打开的页签/);
    assert.match(js, /不是恢复当时的窗口、分组或登录状态/);
    assert.doesNotMatch(js, /恢复整段工作现场/);
    assert.doesNotMatch(js, /保存已打开的页签需要已配对/);
    assert.doesNotMatch(js, /未配对时不能读取当前页签/);
    assert.match(js, /startSessionFileAfterSnapshots/);
    assert.match(js, /maybeStartPendingSessionFileCapture/);
    assert.match(js, /todaySaveOpenTabsTitle/);
    assert.match(js, /todaySaveOpenTabsUnpairedHint/);
    assert.match(css, /hour-label \.restore-btn \{[^}]*opacity:\s*1/s);
    assert.doesNotMatch(css, /hour-label:hover \.restore-btn/);
  });
});

describe('restore/close completion copy and next-batch offer', () => {
  it('describes extension ack results without claiming unfinished work is done', () => {
    const timeout = cap.describeCommandResult({ type: 'restore', timedOut: true, openedCount: 0, failed: [] });
    assert.equal(timeout.level, 'err');
    assert.match(timeout.text, /未在有效期内/);
    assert.doesNotMatch(timeout.text, /已全部恢复/);

    const partial = cap.describeCommandResult({ type: 'restore', openedCount: 5, failed: [{ url: 'https://x' }] });
    assert.equal(partial.level, 'warn');
    assert.match(partial.text, /打开了 5 个/);
    assert.match(partial.text, /1 个失败/);

    const closed = cap.describeCommandResult({ type: 'close', ok: true, closedCount: 3, failed: [], skipped: [] });
    assert.equal(closed.level, 'ok');
    assert.match(closed.text, /不能保护未保存表单/);
  });

  it('only offers the next restore batch after a non-timeout ack when leftovers remain', () => {
    const plan = { remaining: 12, nextOffset: 8, done: false };
    assert.equal(cap.shouldOfferNextRestoreBatch(plan, { type: 'restore', ok: true, openedCount: 8 }), true);
    assert.equal(cap.shouldOfferNextRestoreBatch(plan, { type: 'restore', timedOut: true }), false);
    assert.equal(cap.shouldOfferNextRestoreBatch({ remaining: 0, nextOffset: 8, done: true }, { type: 'restore', ok: true }), false);
    assert.equal(cap.shouldOfferNextRestoreBatch(plan, { type: 'close', ok: true }), false);
  });

  it('wires next-batch-after-ack and the actual listening port into the snapshot UI', () => {
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    assert.match(js, /maybeContinueRestoreAfterAck/);
    assert.match(js, /shouldOfferNextRestoreBatch/);
    assert.match(js, /handleSnapshotUpdated/);
    assert.match(js, /上一批已经有了扩展回执/);
    assert.match(js, /扩展选项里的端口必须与此一致|把扩展选项中的端口设为/);
    assert.doesNotMatch(js, /r\.ok && !r\.pending && r\.plan/);
  });

  it('includes the listening port in the bridge chip when known', () => {
    const now = 1000;
    const d = cap.describeBridge({ listening: true, lastSeenAt: now, port: 17863 }, now);
    assert.equal(d.port, 17863);
    assert.equal(cap.bridgeChipText(d), '页签桥：扩展已连接 · 17863');
  });
});

describe('live-tab permission prompt (install / first launch)', () => {
  it('shows only when not yet prompted and the extension is not already paired', () => {
    assert.equal(cap.shouldShowLiveTabPermissionPrompt({ prompted: false, recentlySeen: false }), true);
    assert.equal(cap.shouldShowLiveTabPermissionPrompt({ prompted: true, recentlySeen: false }), false);
    assert.equal(cap.shouldShowLiveTabPermissionPrompt({ prompted: false, recentlySeen: true }), false);
    assert.equal(cap.shouldShowLiveTabPermissionPrompt({ prompted: true, recentlySeen: true }), false);
    assert.ok(cap.LIVE_TAB_PERM_WAIT_MS >= 1000);
  });

  it('tells the user that only authorized pairing enables live tabs, and that skip does not block history or session files', () => {
    const copy = cap.liveTabPermissionPromptCopy();
    assert.match(copy.title, /实时页签权限/);
    assert.match(copy.body, /浏览历史同步/);
    assert.match(copy.body, /从会话文件读取页签/);
    assert.match(copy.body, /只有完成授权后才能实时获取/);
    assert.match(copy.body, /不会替你静默安装或改动扩展/);
    assert.match(copy.enableLabel, /开启权限/);
    assert.equal(copy.skipLabel, '稍后');
    assert.match(copy.skipNote, /历史同步/);
    assert.match(copy.skipNote, /从会话文件读取页签不受影响/);
    assert.equal(cap.describeBridge({}, 0).canReadSessionFiles, true);
    assert.equal(cap.describeBridge({}, 0).canReopenHistoryUrls, true);
  });

  it('wires a first-launch or install prompt that can be skipped without touching onboarding or silently installing extensions', () => {
    const js = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    const cfg = fs.readFileSync(path.join(__dirname, '../src/main/config.js'), 'utf8');
    const nsh = fs.readFileSync(path.join(__dirname, '../build/installer.nsh'), 'utf8');
    assert.match(cfg, /liveTabPermissionPrompted/);
    assert.match(html, /id="liveTabPermModal"/);
    assert.match(html, /id="liveTabPermSkip"/);
    assert.match(html, /从会话文件读取页签/);
    assert.match(js, /maybePromptLiveTabPermission/);
    assert.match(js, /LIVE_TAB_PERM_WAIT_MS/);
    assert.match(js, /Already-paired extensions usually heart-beat/);

    assert.match(js, /skipLiveTabPermissionPrompt/);
    assert.match(js, /liveTabPermissionPrompted: true/);
    assert.doesNotMatch(js, /skipLiveTabPermissionPrompt[\s\S]{0,400}completeOnboarding/);
    assert.doesNotMatch(js, /--load-extension/);
    assert.doesNotMatch(nsh, /--load-extension/);
    assert.match(nsh, /IfSilent/);
    assert.match(nsh, /首次启动 TraceHub 时，会提示你开启实时页签权限/);
    assert.match(nsh, /从会话文件读取页签/);
    assert.match(nsh, /不会替你安装或改动浏览器扩展/);
  });
});
