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
      if (origin.stale || origin.locked) {
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

  function restoreHonesty(snapshot) {
    if (snapshot && snapshot.source === 'session-file') {
      return '将按窗口在目标浏览器中重新打开网址，不能恢复标签分组、固定状态、窗口位置、登录状态、未提交表单或滚动位置。这不是扩展按布局恢复。';
    }
    return '将请配对扩展按窗口和分组打开网址。不能恢复登录状态、未提交表单或滚动位置。';
  }

  function emptyWorkspaceHint() {
    return '还没有页签快照。可先用「从会话文件读取页签（无需扩展）」选择 Chrome / Edge 配置、预览再保存；或安装并配对扩展以读取更接近实时的页签。不会从浏览历史猜测活动标签。';
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
    emptyWorkspaceHint,
  };
});
