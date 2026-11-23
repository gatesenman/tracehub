'use strict';

/**
 * Launch the official Chrome / Edge extensions page so the user can
 * "Load unpacked" themselves. This is not a silent install:
 * no --load-extension, no CDP/remote debugging, no enterprise policy,
 * no registry writes, no profile tampering.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXTENSIONS_PAGES = Object.freeze({
  chrome: 'chrome://extensions',
  edge: 'edge://extensions',
});

const FORBIDDEN_FLAGS = Object.freeze([
  '--load-extension',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--disable-web-security',
]);

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function candidateExecutables(browserId, platform, env) {
  const e = env || process.env;
  const p = pathApi(platform);
  const home = e.HOME || e.USERPROFILE || os.homedir();
  const local = e.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  const pf = e.ProgramFiles || e['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const list = [];
  if (browserId === 'chrome') {
    if (platform === 'win32') {
      list.push(
        p.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        p.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        p.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (platform === 'darwin') {
      list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      list.push('google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium');
    }
  } else if (browserId === 'edge') {
    if (platform === 'win32') {
      list.push(
        p.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        p.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    } else if (platform === 'darwin') {
      list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    } else {
      list.push('microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-dev');
    }
  }
  return list;
}

function resolveExecutable(browserId, { platform = process.platform, env = process.env, existsFn = fs.existsSync, whichFn } = {}) {
  const p = pathApi(platform);
  const candidates = candidateExecutables(browserId, platform, env);
  for (const c of candidates) {
    if (p.isAbsolute(c) && existsFn(c)) return c;
  }
  if (typeof whichFn === 'function') {
    for (const c of candidates) {
      if (!p.isAbsolute(c)) {
        const found = whichFn(c);
        if (found) return found;
      }
    }
  }
  return null;
}

function buildExtensionsPageLaunch(browserId, exePath) {
  const page = EXTENSIONS_PAGES[browserId];
  if (!page) {
    return { ok: false, error: '只支持为 Chrome 或 Edge 打开官方扩展管理页' };
  }
  if (!exePath) {
    return {
      ok: false,
      error: `未找到 ${browserId === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} 程序。请自己在浏览器地址栏打开 ${page}（该地址不能做成网页链接）。`,
      page,
    };
  }
  return {
    ok: true,
    browserId,
    exe: exePath,
    args: [page],
    page,
  };
}

function assertSafeLaunchArgs(args) {
  const list = Array.isArray(args) ? args : [];
  for (const a of list) {
    const s = String(a);
    for (const flag of FORBIDDEN_FLAGS) {
      if (s === flag || s.startsWith(`${flag}=`) || s.startsWith(`${flag} `)) {
        const err = new Error('拒绝带有调试或不安全扩展加载参数的启动');
        err.code = 'FORBIDDEN_FLAG';
        throw err;
      }
    }
  }
  return list;
}

function whichOnPath(cmd, env = process.env) {
  const pathVal = env.PATH || env.Path || '';
  const parts = pathVal.split(path.delimiter);
  const names = process.platform === 'win32' ? [cmd, `${cmd}.exe`, `${cmd}.cmd`] : [cmd];
  for (const dir of parts) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

async function openExtensionsManagementPage(browserId, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const existsFn = opts.existsFn || fs.existsSync;
  const whichFn = opts.whichFn || ((cmd) => whichOnPath(cmd, env));
  const spawnFn = opts.spawnFn || spawn;
  const exe = resolveExecutable(browserId, { platform, env, existsFn, whichFn });
  const plan = buildExtensionsPageLaunch(browserId, exe);
  if (!plan.ok) return plan;
  const args = assertSafeLaunchArgs(plan.args);
  const child = spawnFn(plan.exe, args, { detached: true, stdio: 'ignore' });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    ok: true,
    browserId,
    page: plan.page,
    launched: true,
    note: '已请浏览器打开官方扩展管理页。请在该页打开开发者模式，选择「加载已解压的扩展程序」，并选中 TraceHub 刚才打开的扩展目录。应用不会替你静默安装扩展。',
  };
}

module.exports = {
  EXTENSIONS_PAGES,
  FORBIDDEN_FLAGS,
  candidateExecutables,
  resolveExecutable,
  buildExtensionsPageLaunch,
  assertSafeLaunchArgs,
  openExtensionsManagementPage,
};
