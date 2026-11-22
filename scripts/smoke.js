'use strict';

/**
 * Headless Electron smoke: isolated userData, no sync of real browser
 * profiles, no GUI driving of Chrome/Edge. Looks for TRACEHUB_SMOKE_OK.
 * This is not a real-browser or Windows-runtime verification.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-smoke-'));
const timeoutMs = 25000;

function electronPath() {
  try {
    return require('electron');
  } catch (e) {
    throw new Error('electron 未安装，无法做冒烟启动。请在开发依赖就绪后运行 npm run smoke');
  }
}

function wrapDisplay(command, args, opts) {
  const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' });
  if (process.env.DISPLAY || process.platform === 'win32') {
    return spawn(command, args, opts);
  }
  if (xvfb.status === 0) {
    return spawn('xvfb-run', ['-a', command, ...args], opts);
  }
  const err = new Error('没有 DISPLAY，也没有 xvfb-run，无法启动 Electron 窗口。已跳过冒烟。');
  err.code = 'NO_DISPLAY';
  throw err;
}

async function main() {
  const bin = electronPath();
  if (typeof bin !== 'string') throw new Error('require("electron") 没有返回可执行路径');
  const env = {
    ...process.env,
    TRACEHUB_USER_DATA: userData,
    TRACEHUB_SMOKE: '1',
    TRACEHUB_DISABLE_SYNC: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const child = wrapDisplay(bin, [root], { env, cwd: root });
  let out = '';
  const collect = (buf) => { out += buf.toString(); process.stdout.write(buf); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }, timeoutMs);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  fs.rmSync(userData, { recursive: true, force: true });
  if (!out.includes('TRACEHUB_SMOKE_OK')) {
    console.error('smoke failed, exit', code);
    process.exit(code || 1);
  }
  console.log('smoke ok (isolated userData, not a real browser test)');
}

main().catch((e) => {
  fs.rmSync(userData, { recursive: true, force: true });
  if (e.code === 'NO_DISPLAY') {
    console.warn(e.message);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
