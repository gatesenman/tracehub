'use strict';

/**
 * Consistent, cheap snapshots of a live browser history SQLite file.
 *
 * Chromium and Firefox keep their History / places.sqlite open (and on
 * Windows, often locked). We never open those live files with SQLite —
 * a recovery of a hot journal would write into the browser's own database.
 * Instead we maintain a per-profile cache under TRACEHUB_HISTORY_CACHE
 * (or userData/history-cache):
 *
 *   - If the source fingerprint is unchanged (SQLite change counter, size,
 *     WAL salts/size, journal size), reuse the cache and copy 0 bytes.
 *   - Otherwise copy only the 1 MiB blocks that actually differ, then
 *     copy the small -wal / -journal side files.
 *
 * The -shm file is not copied. SQLite reconstructs the WAL index; a stale
 * copied -shm can carry the live process's locks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CHUNK_SIZE = 1024 * 1024;
const HEADER_LEN = 100;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');

function cacheRoot() {
  if (process.env.TRACEHUB_HISTORY_CACHE) return process.env.TRACEHUB_HISTORY_CACHE;
  if (process.env.TRACEHUB_USER_DATA) {
    return path.join(process.env.TRACEHUB_USER_DATA, 'history-cache');
  }
  return path.join(os.tmpdir(), 'tracehub-history-cache');
}

function cacheKey(historyPath) {
  const abs = path.resolve(historyPath);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
  const base = path.basename(abs).replace(/[^\w.-]+/g, '_') || 'db';
  return `${base}-${hash}`;
}

function cachePaths(historyPath) {
  const dir = path.join(cacheRoot(), cacheKey(historyPath));
  return {
    dir,
    filePath: path.join(dir, 'History'),
    metaPath: path.join(dir, 'meta.json'),
  };
}

function safeStat(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
  } catch (e) {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

function readPrefix(filePath, n) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return Buffer.from(buf.subarray(0, got));
  } catch (e) {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
    }
  }
}

function sourceFingerprint(historyPath) {
  const main = safeStat(historyPath);
  const header = main.exists ? readPrefix(historyPath, HEADER_LEN) : null;
  let changeCounter = null;
  let dbPages = null;
  if (header && header.length >= 32 && header.subarray(0, 16).equals(SQLITE_MAGIC)) {
    changeCounter = header.readUInt32BE(24);
    dbPages = header.readUInt32BE(28);
  }
  const wal = safeStat(historyPath + '-wal');
  let walSalt1 = null;
  let walSalt2 = null;
  if (wal.exists && wal.size >= 24) {
    const walHeader = readPrefix(historyPath + '-wal', 24);
    if (walHeader && walHeader.length >= 24) {
      walSalt1 = walHeader.readUInt32BE(16);
      walSalt2 = walHeader.readUInt32BE(20);
    }
  }
  const journal = safeStat(historyPath + '-journal');
  return {
    size: main.size,
    mtimeMs: main.mtimeMs,
    changeCounter,
    dbPages,
    walExists: wal.exists,
    walSize: wal.size,
    walSalt1,
    walSalt2,
    journalExists: journal.exists,
    journalSize: journal.size,
    journalMtimeMs: journal.mtimeMs,
  };
}

function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  if (a.changeCounter != null && b.changeCounter != null) {
    if (a.changeCounter !== b.changeCounter || a.dbPages !== b.dbPages) return false;
  } else if (a.mtimeMs !== b.mtimeMs) {
    return false;
  }
  if (Boolean(a.walExists) !== Boolean(b.walExists) || a.walSize !== b.walSize) return false;
  if (a.walSalt1 !== b.walSalt1 || a.walSalt2 !== b.walSalt2) return false;
  if (Boolean(a.journalExists) !== Boolean(b.journalExists) || a.journalSize !== b.journalSize) return false;
  if (a.journalExists && a.journalMtimeMs !== b.journalMtimeMs) return false;
  return true;
}

function isLockError(err) {
  const code = err && err.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN';
}

/**
 * Update dest so its bytes match src, writing only 1 MiB chunks that differ.
 * Falls back to a full copyFileSync if a chunked read hits a sharing lock.
 */
function copyChangedBlocks(src, dest, opts = {}) {
  const chunkSize = opts.chunkSize || CHUNK_SIZE;
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(src, dest);
    const size = fs.statSync(dest).size;
    return {
      mode: 'full',
      bytesWritten: size,
      bytesReadFromSource: size,
      bytesReadFromDest: 0,
      chunksCompared: 0,
      chunksWritten: 0,
    };
  }

  let srcFd;
  let destFd;
  try {
    srcFd = fs.openSync(src, 'r');
    destFd = fs.openSync(dest, 'r+');
    const srcSize = fs.fstatSync(srcFd).size;
    const destSize = fs.fstatSync(destFd).size;
    const srcBuf = Buffer.allocUnsafe(chunkSize);
    const destBuf = Buffer.allocUnsafe(chunkSize);
    let pos = 0;
    let bytesWritten = 0;
    let bytesReadFromSource = 0;
    let bytesReadFromDest = 0;
    let chunksCompared = 0;
    let chunksWritten = 0;
    const common = Math.min(srcSize, destSize);

    while (pos < common) {
      const n = Math.min(chunkSize, common - pos);
      const r1 = fs.readSync(srcFd, srcBuf, 0, n, pos);
      const r2 = fs.readSync(destFd, destBuf, 0, n, pos);
      bytesReadFromSource += r1;
      bytesReadFromDest += r2;
      chunksCompared += 1;
      if (r1 !== r2 || Buffer.compare(srcBuf.subarray(0, r1), destBuf.subarray(0, r2)) !== 0) {
        fs.writeSync(destFd, srcBuf, 0, r1, pos);
        bytesWritten += r1;
        chunksWritten += 1;
      }
      pos += r1;
      if (r1 === 0) break;
    }

    while (pos < srcSize) {
      const n = Math.min(chunkSize, srcSize - pos);
      const r1 = fs.readSync(srcFd, srcBuf, 0, n, pos);
      bytesReadFromSource += r1;
      fs.writeSync(destFd, srcBuf, 0, r1, pos);
      bytesWritten += r1;
      chunksWritten += 1;
      pos += r1;
      if (r1 === 0) break;
    }

    if (srcSize < destSize) fs.ftruncateSync(destFd, srcSize);

    return {
      mode: 'incremental',
      bytesWritten,
      bytesReadFromSource,
      bytesReadFromDest,
      chunksCompared,
      chunksWritten,
    };
  } catch (err) {
    if (isLockError(err)) {
      if (srcFd != null) {
        try { fs.closeSync(srcFd); } catch (e2) { /* ignore */ }
        srcFd = null;
      }
      if (destFd != null) {
        try { fs.closeSync(destFd); } catch (e2) { /* ignore */ }
        destFd = null;
      }
      fs.copyFileSync(src, dest);
      const size = fs.statSync(dest).size;
      return {
        mode: 'full-fallback',
        bytesWritten: size,
        bytesReadFromSource: size,
        bytesReadFromDest: 0,
        chunksCompared: 0,
        chunksWritten: 0,
        fallbackError: err.code,
      };
    }
    throw err;
  } finally {
    if (srcFd != null) {
      try { fs.closeSync(srcFd); } catch (e2) { /* ignore */ }
    }
    if (destFd != null) {
      try { fs.closeSync(destFd); } catch (e2) { /* ignore */ }
    }
  }
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeMeta(metaPath, meta) {
  fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
}

function syncSideFiles(historyPath, destPath, stats) {
  // Never copy -shm: it is a live lock/index and can confuse a native open
  // of the snapshot. SQLite rebuilds the WAL index on demand.
  try { fs.unlinkSync(destPath + '-shm'); } catch (e) { /* ignore */ }

  let sideBytes = 0;
  for (const suffix of ['-wal', '-journal']) {
    const src = historyPath + suffix;
    const dest = destPath + suffix;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      try { sideBytes += fs.statSync(dest).size; } catch (e) { /* ignore */ }
    } else {
      try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
    }
  }
  stats.sideBytesWritten = sideBytes;
}

/**
 * Ensure a consistent snapshot of historyPath exists in the cache and
 * return its path. The snapshot is for read-only use (or SQLite recovery
 * of a hot journal on the copy — never on the live file).
 */
function snapshotHistory(historyPath, _tag) {
  const fp = sourceFingerprint(historyPath);
  const paths = cachePaths(historyPath);
  const existing = readMeta(paths.metaPath);
  const cacheReady = fs.existsSync(paths.filePath);

  if (cacheReady && existing && fingerprintsEqual(existing.fingerprint, fp)) {
    const result = {
      filePath: paths.filePath,
      mode: 'reuse',
      bytesWritten: 0,
      bytesReadFromSource: HEADER_LEN,
      bytesReadFromDest: 0,
      chunksCompared: 0,
      chunksWritten: 0,
      sideBytesWritten: 0,
      fingerprint: fp,
      ephemeral: false,
    };
    lastSnapshotResult = result;
    return result;
  }

  fs.mkdirSync(paths.dir, { recursive: true });
  let copyStats;
  try {
    copyStats = copyChangedBlocks(historyPath, paths.filePath);
  } catch (err) {
    // Last resort: a unique temp copy, same as the pre-1.2.10 behaviour.
    const tmp = path.join(
      os.tmpdir(),
      `bhh-hist-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
    );
    fs.copyFileSync(historyPath, tmp);
    const fallback = {
      filePath: tmp,
      mode: 'ephemeral',
      bytesWritten: fp.size,
      bytesReadFromSource: fp.size,
      bytesReadFromDest: 0,
      chunksCompared: 0,
      chunksWritten: 0,
      sideBytesWritten: 0,
      fingerprint: fp,
      ephemeral: true,
      fallbackError: err.code || String(err.message || err),
    };
    syncSideFiles(historyPath, tmp, fallback);
    lastSnapshotResult = fallback;
    return fallback;
  }

  const result = {
    filePath: paths.filePath,
    mode: copyStats.mode,
    bytesWritten: copyStats.bytesWritten,
    bytesReadFromSource: copyStats.bytesReadFromSource,
    bytesReadFromDest: copyStats.bytesReadFromDest,
    chunksCompared: copyStats.chunksCompared,
    chunksWritten: copyStats.chunksWritten,
    sideBytesWritten: 0,
    fingerprint: fp,
    ephemeral: false,
  };
  syncSideFiles(historyPath, paths.filePath, result);
  writeMeta(paths.metaPath, { fingerprint: fp, updatedAt: Date.now(), mode: result.mode });
  lastSnapshotResult = result;
  return result;
}

function cleanupSnapshot(snap) {
  if (!snap || !snap.ephemeral || !snap.filePath) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(snap.filePath + suffix); } catch (e) { /* ignore */ }
  }
}

let lastSnapshotResult = null;

function getLastSnapshotResult() {
  return lastSnapshotResult;
}

function resetSnapshotStats() {
  lastSnapshotResult = null;
}

module.exports = {
  CHUNK_SIZE,
  cacheRoot,
  cacheKey,
  cachePaths,
  sourceFingerprint,
  fingerprintsEqual,
  copyChangedBlocks,
  snapshotHistory,
  cleanupSnapshot,
  getLastSnapshotResult,
  resetSnapshotStats,
};
