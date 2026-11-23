'use strict';

/**
 * Shared wording for queued restore/close commands.
 * Enqueueing is not the same as the extension having already run the command,
 * and a listening bridge is not the same as a recently paired extension.
 */
const RECENT_MS = 5 * 60 * 1000;

function isRecentlySeen(lastSeenAt, now, windowMs) {
  const t = now == null ? Date.now() : now;
  const window = windowMs == null ? RECENT_MS : windowMs;
  const seen = lastSeenAt ? Number(lastSeenAt) : 0;
  return !!(seen && (t - seen) <= window);
}

function describeQueuedCommand({
  kind,
  recentlySeen,
  lastExtensionId,
  expectedExtensionId,
  batchCount,
  total,
  remaining,
} = {}) {
  const isClose = kind === 'close';
  const verb = isClose ? '关闭' : '恢复';
  const counts = isClose
    ? `（${Number(batchCount || 0)} 个页签）`
    : `（本批 ${Number(batchCount || 0)} 个，共 ${Number(total || 0)}，还剩 ${Number(remaining || 0)}）`;
  const mismatch = lastExtensionId && expectedExtensionId && String(lastExtensionId) !== String(expectedExtensionId);
  const audienceNote = mismatch
    ? '指令只会交给当初保存这份快照的扩展；若你后来换过浏览器配置或重新加载过扩展，请重新保存一份快照。'
    : '';

  if (!recentlySeen) {
    return {
      recentlySeen: false,
      extensionMismatch: !!mismatch,
      message:
        `已向本机桥排队${verb}请求${counts}，但最近没有检测到配对扩展的活动。请打开扩展弹出页（或到选项页保存令牌并确认配对成功）以便立即执行。指令约 3 分钟内有效；在扩展回执前，不会标记为已${verb}。`
        + (audienceNote ? ' ' + audienceNote : '')
        + (isClose ? ' 不会强杀浏览器，也不能保护未保存表单。' : ' 不能恢复登录态、表单或滚动位置。'),
    };
  }

  return {
    recentlySeen: true,
    extensionMismatch: !!mismatch,
    message:
      `已向配对扩展发出${verb}请求${counts}。若扩展弹出页是关闭的，Chrome / Edge 的后台闹钟可能要几十秒才会执行，请稍候或打开弹出页立即触发。在扩展回执前不会标记为已${verb}。`
      + (audienceNote ? ' ' + audienceNote : '')
      + (isClose ? ' 扩展会先核对当前网址再关闭；地址已变或页签已不存在的会跳过。不会强杀浏览器，也不能保护未保存表单。' : ' 不能恢复登录态、表单或滚动位置。'),
  };
}

module.exports = {
  RECENT_MS,
  isRecentlySeen,
  describeQueuedCommand,
};
