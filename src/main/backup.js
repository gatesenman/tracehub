'use strict';

const fs = require('fs');
const path = require('path');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

function isSqliteFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, 0);
      return n >= 16 && buf.equals(SQLITE_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

function sidecarPaths(dbPath) {
  return [dbPath + '-wal', dbPath + '-shm'];
}

function removeSidecars(dbPath) {
  for (const p of sidecarPaths(dbPath)) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

/**
 * Atomically-enough restore: validate the backup, copy the current db aside,
 * remove WAL/SHM (so an old journal cannot mix with the new file), then
 * replace hub.sqlite. Throws without touching the live file if validation fails.
 */
function restoreDatabase(livePath, backupPath, { safetyDir } = {}) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    const err = new Error('找不到备份文件');
    err.code = 'ENOENT';
    throw err;
  }
  if (!isSqliteFile(backupPath)) {
    const err = new Error('备份文件不是有效的 SQLite 数据库，已拒绝恢复，当前数据未改动');
    err.code = 'EINVAL';
    throw err;
  }
  const dir = safetyDir || path.dirname(livePath);
  fs.mkdirSync(dir, { recursive: true });
  const safety = path.join(dir, `hub-prerestore-${Date.now()}.sqlite`);
  if (fs.existsSync(livePath)) {
    fs.copyFileSync(livePath, safety);
  }
  removeSidecars(livePath);
  const tmp = livePath + '.restoring';
  fs.copyFileSync(backupPath, tmp);
  fs.renameSync(tmp, livePath);
  removeSidecars(livePath);
  return { ok: true, safety };
}

module.exports = { isSqliteFile, restoreDatabase, removeSidecars, SQLITE_MAGIC };
