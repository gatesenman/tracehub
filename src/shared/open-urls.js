'use strict';

/**
 * Open a list of http(s) URLs via a provided opener (e.g. shell.openExternal).
 * This is a degraded path: system default browser, no layout/groups/pins.
 * It must never be reported as an extension restore.
 */
async function openHttpUrlList(urls, openFn, { limit = 30, delayMs = 0 } = {}) {
  const list = (urls || []).filter((u) => /^https?:\/\//i.test(String(u))).slice(0, limit);
  const opened = [];
  const failed = [];
  for (const url of list) {
    try {
      const r = await openFn(url);
      if (r && r.ok === false) failed.push({ url, error: r.error || '打开失败' });
      else opened.push(url);
    } catch (e) {
      failed.push({ url, error: e.message || String(e) });
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const failedN = failed.length;
  const openedN = opened.length;
  return {
    ok: failedN === 0,
    opened: openedN,
    failed: failedN,
    failedUrls: failed,
    via: 'system-default-browser',
    message: failedN
      ? `已请系统默认浏览器打开 ${openedN} 个网址，${failedN} 个未能打开。这不是扩展按布局恢复，也不会恢复分组或登录状态。`
      : `已请系统默认浏览器打开 ${openedN} 个网址。这不是扩展按布局恢复，也不会恢复分组或登录状态。`,
  };
}

module.exports = { openHttpUrlList };
