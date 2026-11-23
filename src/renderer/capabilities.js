'use strict';

/**
 * Capability copy and bridge-status helpers for the renderer and Node tests.
 * Live tab capture / layout restore / batch close need the MV3 extension.
 * Reopening history URLs does not.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TraceHubCapabilities = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RECENT_MS = 5 * 60 * 1000;

  function describeBridge(status, now) {
    const t = now == null ? Date.now() : now;
    const listening = !!(status && status.listening);
    const lastSeenAt = status && status.lastSeenAt ? Number(status.lastSeenAt) : 0;
    const recentlySeen = !!(lastSeenAt && (t - lastSeenAt) <= RECENT_MS);
    return {
      listening,
      recentlySeen,
      lastSeenAt: lastSeenAt || null,
      lastExtensionId: (status && status.lastExtensionId) ? String(status.lastExtensionId) : null,
      canCaptureLiveTabs: recentlySeen,
      canRestoreLayout: recentlySeen,
      canCloseLiveTabs: recentlySeen,
      canReopenHistoryUrls: true,
      canImportSnapshotJson: true,
      canOpenSnapshotUrlsInDefaultBrowser: true,
    };
  }

  function bridgeChipText(d) {
    if (d && d.recentlySeen) return '页签桥：扩展已连接';
    if (d && d.listening) return '页签桥：等待扩展配对';
    return '页签桥：未监听';
  }

  function historySessionDisclaimer() {
    return '这是根据浏览历史打开网址，不是恢复浏览器里当前已打开的页签，也不会恢复窗口、分组、固定或登录状态。将使用系统默认浏览器打开（最多 30 个）。若要保存或按原布局恢复活动页签，需要安装并配对 Chrome / Edge 扩展。';
  }

  function extensionSetupSteps() {
    return quickInstallSteps();
  }

  function quickInstallSteps() {
    return [
      '点击「打开扩展目录」，确认文件夹里有 manifest.json。',
      '点击「打开 Chrome 扩展页」或「打开 Edge 扩展页」，打开开发者模式，选择「加载已解压的扩展程序」，选中上一步的目录。这是官方的本地加载方式，应用不会替你静默安装扩展。',
      '点击「复制配对令牌」，在扩展选项页粘贴并保存（不要发到聊天或截图）。配对成功后，本页会自动提示「扩展已连接」。然后到要整理的窗口，用扩展弹出页保存已打开的页签。',
    ];
  }

  function pairingSucceeded(prev, next) {
    if (!prev || typeof prev !== 'object') return false;
    return !!(next && next.recentlySeen && !prev.recentlySeen);
  }

  function pairingSuccessMessage() {
    return '已检测到扩展已连接。现在可以用扩展弹出页保存真实已打开的页签，并在 TraceHub 里按窗口和分组恢复。';
  }

  function webStoreFutureNote() {
    return '以后若上架 Chrome 网上应用店或 Microsoft Edge 扩展商店，安装步骤会更短。本版还没有商店发布账号和审核条件，因此不提供商店一键安装，请按上面三步加载已解压的扩展。卸载只需在浏览器扩展页移除该扩展。';
  }

  function withoutExtensionCapabilities() {
    return {
      available: [
        '查看和搜索已同步的浏览历史',
        '按今日或时段，把历史里的网址用系统默认浏览器重新打开',
        '导入以前导出的 JSON 快照，并用默认浏览器打开其中的网址（不恢复窗口和分组）',
        '收藏、稍后读、备份和导出',
      ],
      unavailable: [
        '读取当前真实已打开的页签（不会从历史猜测）',
        '按窗口、分组、固定状态恢复活动会话',
        '由扩展批量关闭已打开的页签',
      ],
    };
  }

  return {
    RECENT_MS,
    describeBridge,
    bridgeChipText,
    historySessionDisclaimer,
    extensionSetupSteps,
    quickInstallSteps,
    pairingSucceeded,
    pairingSuccessMessage,
    webStoreFutureNote,
    withoutExtensionCapabilities,
  };
});
