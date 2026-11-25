'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const Database = require('better-sqlite3');

let SQL = null;

// sql.js keeps the whole database in WASM memory and can only persist by
// exporting the entire image, which blocks the main thread for seconds once
// the history grows — the app's own store therefore uses better-sqlite3
// (native, incremental WAL writes). sql.js remains only for READING browser
// history copies, since those need buffer-level WAL merging of locked files.
// This wrapper exposes the small sql.js surface store.js relies on.
function cleanParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class NativeDb {
  constructor(filePath) {
    this.raw = new Database(filePath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this._changes = 0;
  }

  run(sql, params) {
    if (params === undefined) {
      this.raw.exec(sql);
      this._changes = 0;
      return;
    }
    const info = this.raw.prepare(sql).run(params.map(cleanParam));
    this._changes = info.changes;
  }

  prepare(sql) {
    const stmt = this.raw.prepare(sql);
    const self = this;
    return {
      run(params = []) {
        const info = stmt.run(params.map(cleanParam));
        self._changes = info.changes;
      },
      free() {},
    };
  }

  getRowsModified() {
    return this._changes;
  }

  all(sql, params = []) {
    return this.raw.prepare(sql).all(params.map(cleanParam));
  }

  checkpoint() {
    try { this.raw.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
  }

  close() {
    try { this.raw.close(); } catch (e) { /* ignore */ }
  }
}

// Locate the sql.js wasm file that ships with the package so it works both in
// dev (node_modules) and when bundled.
function wasmDir() {
  return path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
}

async function getSQL() {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir(), file),
  });
  return SQL;
}

// Merge committed frames of a SQLite WAL file into the main database image.
// sql.js opens databases from a plain byte buffer and knows nothing about the
// -wal file, so without this the most recent (not yet checkpointed) visits —
// e.g. everything Firefox wrote since its last idle checkpoint — would be
// invisible. WAL layout: 32-byte header, then frames of 24-byte header +
// one page. Frames belong to the current generation iff their salts match
// the WAL header; a frame with dbSize != 0 marks a commit.
function applyWal(dbBuf, walBuf) {
  if (!walBuf || walBuf.length < 32 + 24) return dbBuf;
  const wal = new DataView(walBuf.buffer, walBuf.byteOffset, walBuf.byteLength);
  const magic = wal.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbBuf;
  const pageSize = wal.getUint32(8);
  if (!pageSize || (pageSize & (pageSize - 1)) !== 0) return dbBuf;
  const salt1 = wal.getUint32(16);
  const salt2 = wal.getUint32(20);

  const frameSize = 24 + pageSize;
  const frames = [];
  let lastCommit = -1;
  for (let off = 32; off + frameSize <= walBuf.length; off += frameSize) {
    if (wal.getUint32(off + 8) !== salt1 || wal.getUint32(off + 12) !== salt2) break;
    const pageNo = wal.getUint32(off);
    const dbSize = wal.getUint32(off + 4);
    if (!pageNo) break;
    frames.push({ pageNo, dbSize, dataOff: off + 24 });
    if (dbSize !== 0) lastCommit = frames.length - 1;
  }
  if (lastCommit < 0) return dbBuf;

  const finalPages = frames[lastCommit].dbSize;
  const out = new Uint8Array(Math.max(dbBuf.length, finalPages * pageSize));
  out.set(dbBuf);
  for (let i = 0; i <= lastCommit; i++) {
    const f = frames[i];
    out.set(walBuf.subarray(f.dataOff, f.dataOff + pageSize), (f.pageNo - 1) * pageSize);
  }
  const merged = out.subarray(0, finalPages * pageSize);
  // Keep the page-1 header consistent with the truncated image: db size in
  // pages (offset 28) and version-valid-for = change counter (offsets 92/24).
  const hdr = new DataView(merged.buffer, merged.byteOffset, 100);
  hdr.setUint32(28, finalPages);
  hdr.setUint32(92, hdr.getUint32(24));
  return merged;
}

// Roll back a hot SQLite rollback journal (Chromium's History-journal) into
// a copied main-file image. A non-empty journal with a valid header means a
// write transaction was in flight when we copied: the main file may hold
// half-written pages, and the journal holds the ORIGINAL pages. Restoring
// them is exactly what SQLite itself does when it opens a hot journal, and
// yields the last committed state. Records with a bad checksum (torn tail)
// stop the replay, as in SQLite. Returns dbBuf unchanged if not hot.
const JOURNAL_MAGIC = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];

function isHotJournal(journalBuf) {
  if (!journalBuf || journalBuf.length < 28) return false;
  for (let i = 0; i < 8; i++) if (journalBuf[i] !== JOURNAL_MAGIC[i]) return false;
  return true;
}

function applyRollbackJournal(dbBuf, journalBuf) {
  if (!isHotJournal(journalBuf)) return dbBuf;
  const j = new DataView(journalBuf.buffer, journalBuf.byteOffset, journalBuf.byteLength);
  const origPages = j.getUint32(16);
  const sectorSize = j.getUint32(20) || 512;
  const pageSize = j.getUint32(24);
  if (!pageSize || (pageSize & (pageSize - 1)) !== 0 || pageSize > 65536) return dbBuf;
  if (!sectorSize || (sectorSize & (sectorSize - 1)) !== 0 || sectorSize > 65536) return dbBuf;
  const recSize = 4 + pageSize + 4;
  const out = new Uint8Array(Math.max(dbBuf.length, origPages * pageSize));
  out.set(dbBuf);
  const restored = new Set();
  // A journal is one or more segments, each a sector-sized header followed
  // by nRec page records; every sync of the journal starts a new segment.
  let hdr = 0;
  segments: while (hdr + 28 <= journalBuf.length && isHotJournal(journalBuf.subarray(hdr))) {
    let nRec = j.getUint32(hdr + 8);
    const cksumInit = j.getUint32(hdr + 12);
    const first = hdr + sectorSize;
    const maxRec = Math.max(0, Math.floor((journalBuf.length - first) / recSize));
    if (nRec === 0xffffffff || nRec > maxRec) nRec = maxRec;
    if (nRec === 0 && first + recSize <= journalBuf.length) nRec = maxRec; // unsynced tail
    for (let r = 0; r < nRec; r++) {
      const off = first + r * recSize;
      const pgno = j.getUint32(off);
      const data = journalBuf.subarray(off + 4, off + 4 + pageSize);
      let cksum = cksumInit;
      for (let i = pageSize - 200; i > 0; i -= 200) cksum = (cksum + data[i]) >>> 0;
      if (cksum !== j.getUint32(off + 4 + pageSize)) break segments; // torn record
      if (!pgno || pgno > origPages || restored.has(pgno)) continue;
      restored.add(pgno);
      out.set(data, (pgno - 1) * pageSize);
    }
    if (!nRec) break;
    const endOfRecords = first + nRec * recSize;
    hdr = Math.ceil(endOfRecords / sectorSize) * sectorSize;
  }
  return origPages ? out.subarray(0, origPages * pageSize) : out;
}

// Open a SQLite database from a file buffer (read-only usage). If a matching
// -wal file exists next to it, committed WAL frames are merged in first.
async function openDatabaseFromFile(filePath) {
  const sql = await getSQL();
  let buffer = new Uint8Array(fs.readFileSync(filePath));
  const journalPath = filePath + '-journal';
  if (fs.existsSync(journalPath)) {
    try {
      buffer = applyRollbackJournal(buffer, new Uint8Array(fs.readFileSync(journalPath)));
    } catch (e) {
      /* fall back to the main file image */
    }
  }
  const walPath = filePath + '-wal';
  if (fs.existsSync(walPath)) {
    try {
      buffer = applyWal(buffer, new Uint8Array(fs.readFileSync(walPath)));
    } catch (e) {
      /* fall back to the main file image */
    }
  }
  return new sql.Database(buffer);
}

// Open (or create) the app's persistent database (native better-sqlite3).
async function openPersistentDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new NativeDb(filePath);
}

// With WAL the data is already on disk; just fold the -wal file back into
// the main file so plain file copies (backups) see everything.
function persist(db) {
  if (db instanceof NativeDb) db.checkpoint();
}

// Run a query and return an array of row objects (works for both engines).
function queryAll(db, sql, params = []) {
  if (db instanceof NativeDb) return db.all(sql, params);
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

module.exports = {
  getSQL,
  openDatabaseFromFile,
  openPersistentDatabase,
  persist,
  queryAll,
  applyWal,
  applyRollbackJournal,
  isHotJournal,
};
