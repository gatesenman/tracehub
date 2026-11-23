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
    return [
      '在 TraceHub 中打开扩展目录',
      'Chrome 或 Edge：扩展程序 → 打开开发者模式 → 加载已解压的扩展程序，选中该目录',
      '在扩展选项页粘贴配对令牌（在设置中复制；不要发到聊天或截图）',
      '回到要整理的浏览器窗口，用扩展弹出页保存当前已打开的页签',
      '保存成功后，再在 TraceHub 里按组恢复，或在确认快照已保存后关闭页签',
    ];
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
    withoutExtensionCapabilities,
  };
});
