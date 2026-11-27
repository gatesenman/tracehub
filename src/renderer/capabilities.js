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
    const port = status && status.port ? Number(status.port) : 0;
    return {
      listening,
      recentlySeen,
      port: port || null,
      lastSeenAt: lastSeenAt || null,
      lastExtensionId: (status && status.lastExtensionId) ? String(status.lastExtensionId) : null,
      canCaptureLiveTabs: recentlySeen,
      canRestoreLayout: recentlySeen,
      canCloseLiveTabs: recentlySeen,
      canReadSessionFiles: true,
      canReopenSessionFileByWindow: true,
      canReopenHistoryUrls: true,
      canImportSnapshotJson: true,
      canOpenSnapshotUrlsInDefaultBrowser: true,
    };
  }

  function bridgeChipText(d) {
    const port = d && d.port ? ` · ${d.port}` : '';
    if (d && d.recentlySeen) return '页签桥：扩展已连接' + port;
    if (d && d.listening) return '页签桥：等待扩展配对' + port;
    return '页签桥：未监听';
  }

  function describeCommandResult(body) {
    if (!body || !body.type) return null;
    if (body.type === 'restore') {
      const opened = Number(body.openedCount != null ? body.openedCount : ((body.opened || []).length));
      const failed = (body.failed || []).length;
      if (body.timedOut) {
        return { kind: 'restore', level: 'err', text: body.message || '扩展未在有效期内打开页签（可能离线或未轮询）。未完成的项不会标记为已恢复。' };
      }
      if (failed && opened) {
        return { kind: 'restore', level: 'warn', text: `扩展已执行恢复：打开了 ${opened} 个页签，${failed} 个失败。失败项可在快照里重试。不能恢复登录态、表单或滚动位置。` };
      }
      if (failed && !opened) {
        return { kind: 'restore', level: 'err', text: body.message || `恢复失败（${failed} 个）。` };
      }
      return { kind: 'restore', level: 'ok', text: body.message || `扩展已打开 ${opened} 个页签。不能恢复登录态、表单或滚动位置。` };
    }
    if (body.type === 'close') {
      const closed = Number(body.closedCount || 0);
      const failed = (body.failed || []).length;
      const skipped = (body.skipped || []).length;
      if (body.timedOut) {
        return { kind: 'close', level: 'err', text: body.message || '关闭指令已过期，扩展未在有效期内执行。不会标记为已关闭。' };
      }
      const extra = (skipped ? `，跳过 ${skipped} 个地址已变或不存在的页签` : '') + (failed ? `，${failed} 个关闭失败可重试` : '');
      if (failed && !closed) return { kind: 'close', level: 'err', text: (body.message || '关闭失败') + extra };
      if (failed || skipped) return { kind: 'close', level: 'warn', text: (body.message || `已关闭 ${closed} 个页签`) + extra };
      return { kind: 'close', level: 'ok', text: (body.message || `已关闭 ${closed} 个页签`) + extra + ' 不能保护未保存表单。' };
    }
    return null;
  }

  function shouldOfferNextRestoreBatch(plan, commandResult) {
    if (!plan || plan.done || !(plan.remaining > 0) || plan.nextOffset == null) return false;
    if (!commandResult || commandResult.type !== 'restore') return false;
    if (commandResult.timedOut) return false;
    return true;
  }

  function historySessionDisclaimer() {
    return '这是根据浏览历史打开网址，不是恢复浏览器里当前已打开的页签，也不会恢复窗口、分组、固定或登录状态。将使用系统默认浏览器打开（最多 30 个）。若要尽量读取当时已打开的页签，可用「从会话文件读取」（无需扩展，可能是旧档）。要更接近实时的页签、按分组恢复和按页签关闭，需要安装并配对 Chrome / Edge 扩展。';
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


  function shouldShowLiveTabPermissionPrompt(opts) {
    const o = opts || {};
    if (o.prompted) return false;
    if (o.recentlySeen) return false;
    return true;
  }

  function liveTabPermissionPromptCopy() {
    return {
      title: '开启实时页签权限',
      body: '浏览历史同步和「从会话文件读取页签」不需要扩展，现在就可以用。若要获取浏览器里此刻打开的页签、按分组恢复或按页签关闭，需要在 Chrome 或 Edge 中加载配套扩展并完成配对。只有完成授权后才能实时获取这些数据。应用不会替你静默安装或改动扩展。',
      enableLabel: '开启权限',
      skipLabel: '稍后',
      skipNote: '已跳过。历史同步和从会话文件读取页签不受影响。需要时再到「页签快照」或设置里开启。',
    };
  }

  function withoutExtensionCapabilities() {
    return {
      available: [
        '查看和搜索已同步的浏览历史',
        '按今日或时段，把历史里的网址用系统默认浏览器重新打开',
        '手动从 Chrome / Edge 会话文件读取页签并预览后保存（无需扩展；可能不是此刻页签条，锁定时可能读到旧档或失败）',
        '将会话文件快照按窗口重新打开网址（不能恢复分组、固定或登录态）',
        '导入以前导出的 JSON 快照，并用默认浏览器打开其中的网址（不恢复窗口和分组）',
        '收藏、稍后读、备份和导出',
      ],
      unavailable: [
        '与扩展同等的实时页签条、标签分组和窗口形态',
        '按 tabId 核对后安全关闭已打开的单个页签（需要扩展）',
        'Firefox 活动页签（本轮不在范围内）',
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
    shouldShowLiveTabPermissionPrompt,
    liveTabPermissionPromptCopy,
    describeCommandResult,
    shouldOfferNextRestoreBatch,
  };
});
