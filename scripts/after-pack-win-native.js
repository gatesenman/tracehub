'use strict';

/**
 * electron-builder on Linux rebuilds better-sqlite3 for the host ABI.
 * After a Windows pack, swap in the official win32-x64 Electron 31 (ABI 125)
 * prebuild so the artifact is not shipping a Linux .node file.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const src = path.join(context.packager.projectDir, 'native-prebuilds', 'better_sqlite3-electron-v125-win32-x64.node');
  const dest = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
  );
  if (!fs.existsSync(src)) {
    throw new Error('缺少 Windows 版 better-sqlite3 预编译文件：' + src);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const magic = Buffer.alloc(2);
  const fd = fs.openSync(dest, 'r');
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);
  if (magic.toString('latin1') !== 'MZ') {
    throw new Error('Windows 预编译文件不是 PE（MZ）格式：' + dest);
  }
  console.log('afterPack: installed official better-sqlite3 win32-x64 prebuild');
};
