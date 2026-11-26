'use strict';

/**
 * Pure copy/helpers for the extension-free session-file snapshot entry.
 * No DOM. Node tests and the renderer share this module (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TraceHubSessionFileUi = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function entryTitle() {
    return '从会话文件读取页签（无需扩展）';
  }

  function entryIntro() {
    return '可以先不装扩展（无需扩展）：在你确认后，只读 Chrome 或 Edge 配置里的会话文件，预览再保存为本地快照。这不是此刻页签条的实时同步；若文件被占用，可能只能读到较旧的存档，或读取失败。应用不会结束浏览器进程，也不会从浏览历史猜测活动页签。Firefox 本轮不在范围内。扩展仍是可选增强：用于更接近实时的页签、按分组/固定恢复，以及按 tabId 核对后关闭。';
  }

  function saveConfirmLabel() {
    return '确认保存这份会话快照';
  }

  function previewFirstHint() {
    return '请先选择 Chrome 或 Edge 的配置并预览，确认内容后再保存。不会自动采集。';
  }

  function sourceLabel(snapshot) {
    const s = snapshot && snapshot.source;
    if (s === 'session-file') return '会话文件（无需扩展）';
    if (s === 'file-import') return 'JSON 导入';
    if (s === 'extension') return '扩展';
    return s || '未知来源';
  }

  function sourceBadgeText(snapshot) {
    const origin = snapshot && snapshot.origin;
    const base = sourceLabel(snapshot);
    if (snapshot && snapshot.source === 'session-file' && origin) {
      if (origin.lastSession && !origin.stale && !origin.locked) {
        return `${base} · 上次会话`;
      }
      if (origin.racy) {
        return `${base} · 读盘时文件仍在变化`;
      }
      if (origin.stale || origin.locked || origin.incompleteNewest) {
        return origin.sourceMtime
          ? `${base} · 旧档，不是此刻页签条`
          : `${base} · 可能不是此刻页签条`;
      }
    }
    return base;
  }

  function restoreButtonLabel(snapshot) {
    if (snapshot && snapshot.source === 'session-file') return '按窗口重新打开网址…';
    return '按组恢复…';
  }

  function closeDisabledReason(snapshot) {
    if (!snapshot) return '没有指定快照';
    if (snapshot.source === 'session-file') {
      return '会话文件快照不能按 tabId 关闭浏览器里的页签（即使文件里写了 id 也不会发出关闭指令）。请在浏览器中手动关闭，或使用配对扩展采集后再关闭。';
    }
    if (snapshot.source === 'file-import' || !snapshot.extensionId) {
      return '导入的快照没有对应的扩展会话，不能远程关闭页签。请在浏览器里手动关闭。';
    }
    if (snapshot.closeStatus === 'done') return '这些页签已经关闭过，无需重复关闭';
    return '';
  }

  function canOfferPreciseClose(snapshot) {
    return !!(snapshot && snapshot.source === 'extension' && snapshot.extensionId && snapshot.persisted && snapshot.closeStatus !== 'done');
  }

  function needsLargeReopenConfirm(plan) {
    if (!plan) return false;
    if (plan.needsSecondConfirm) return true;
    const n = plan.urlCount != null ? plan.urlCount : plan.total;
    return Number(n) >= 30;
  }

  function largeReopenConfirmText(plan) {
    const n = (plan && (plan.urlCount || plan.total)) || 0;
    const w = (plan && plan.windowCount) || 0;
    return plan && plan.secondConfirmText
      ? plan.secondConfirmText
      : `即将一次性按窗口打开 ${n} 个网址（${w} 个窗口）。数量较多，需要再次确认后才会启动浏览器。无法恢复分组、固定、登录或表单。`;
  }

  function restoreHonesty(snapshot) {
    if (snapshot && snapshot.source === 'session-file') {
      return '将按窗口在目标浏览器中重新打开网址，不能恢复标签分组、固定状态、窗口位置、登录状态、未提交表单或滚动位置。这不是扩展按布局恢复。';
    }
    return '将请配对扩展按窗口和分组打开网址。不能恢复登录状态、未提交表单或滚动位置。';
  }

  function emptyWorkspaceHint() {
    return '还没有页签快照。可先用「从会话文件读取页签（无需扩展）」选择 Chrome / Edge 配置、预览再保存；或安装并配对扩展以读取更接近实时的页签。不会从浏览历史猜测活动标签。';
  }

  function todaySaveOpenTabsTitle() {
    return '已配对扩展时，保存此刻真实已打开的页签。未配对时改为从 Chrome / Edge 会话文件读取已写盘的页签，先预览再确认保存。这不是浏览历史，也可能不是此刻页签条。';
  }

  function todaySaveOpenTabsUnpairedHint() {
    return '未配对扩展。改为从会话文件读取已写盘的页签，请先预览再确认保存。这不是此刻页签条的实时同步。';
  }

  function previewHonestyTone(origin, preview) {
    const o = origin || (preview && preview.origin) || {};
    const p = preview || {};
    if (p.stale || p.locked || o.stale || o.locked || o.lastSession || o.racy || o.incompleteNewest || o.truncated) {
      return 'warn';
    }
    return 'muted';
  }

  function profileListStatus(profiles, scope) {
    const list = Array.isArray(profiles) ? profiles : [];
    const usable = list.filter((p) => p && p.hasSessionFiles);
    if (!list.length) {
      return {
        tone: 'muted',
        canPreview: false,
        text: '没有发现 Chrome / Edge 配置目录。Firefox 本轮不在范围内。也可以稍后安装扩展。',
      };
    }
    if (!usable.length) {
      return {
        tone: 'warn',
        canPreview: false,
        text: '找到了配置目录，但其中没有可读取的会话文件。不会把空列表当作成功。Firefox 本轮不在范围内。',
      };
    }
    return {
      tone: 'muted',
      canPreview: true,
      text: scope || '请选择配置，先预览再决定是否保存。',
    };
  }

  return {
    entryTitle,
    entryIntro,
    saveConfirmLabel,
    previewFirstHint,
    sourceLabel,
    sourceBadgeText,
    restoreButtonLabel,
    closeDisabledReason,
    canOfferPreciseClose,
    restoreHonesty,
    needsLargeReopenConfirm,
    largeReopenConfirmText,
    emptyWorkspaceHint,
    todaySaveOpenTabsTitle,
    todaySaveOpenTabsUnpairedHint,
    previewHonestyTone,
    profileListStatus,
  };
});
