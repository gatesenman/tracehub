'use strict';

const crypto = require('crypto');
const { queryAll } = require('./sqlengine');
const core = require('../shared/snapshot-core');
const { honestyNote } = require('../shared/session-files');

function migrateSnapshotTables(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      title TEXT,
      source TEXT,
      browser_id TEXT,
      browser_name TEXT,
      profile TEXT,
      persisted INTEGER DEFAULT 0,
      close_status TEXT DEFAULT 'none',
      close_error TEXT,
      close_confirmed_at INTEGER,
      ai_status TEXT DEFAULT 'none',
      ai_error TEXT,
      tab_count INTEGER DEFAULT 0,
      raw_json TEXT,
      extension_id TEXT,
      audience_browser TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshot_windows (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      window_id INTEGER,
      window_index INTEGER,
      focused INTEGER DEFAULT 0,
      incognito INTEGER DEFAULT 0,
      type TEXT,
      state TEXT,
      left INTEGER,
      top INTEGER,
      width INTEGER,
      height INTEGER
    );
    CREATE TABLE IF NOT EXISTS snapshot_tabs (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      window_row_id TEXT,
      tab_id INTEGER,
      tab_index INTEGER,
      url TEXT NOT NULL,
      title TEXT,
      pinned INTEGER DEFAULT 0,
      active INTEGER DEFAULT 0,
      discarded INTEGER DEFAULT 0,
      incognito INTEGER DEFAULT 0,
      favicon TEXT,
      group_id INTEGER,
      group_title TEXT,
      group_color TEXT,
      domain TEXT,
      restorable INTEGER DEFAULT 1,
      category TEXT,
      tags TEXT,
      purpose TEXT,
      summary TEXT,
      user_group TEXT,
      hidden_dup INTEGER DEFAULT 0,
      restore_status TEXT DEFAULT 'none',
      restore_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snap_tabs_sid ON snapshot_tabs(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_snap_win_sid ON snapshot_windows(snapshot_id);
  `);
  for (const sql of [
    'ALTER TABLE snapshots ADD COLUMN extension_id TEXT',
    'ALTER TABLE snapshots ADD COLUMN audience_browser TEXT',
    'ALTER TABLE snapshots ADD COLUMN origin_locked INTEGER DEFAULT 0',
    'ALTER TABLE snapshots ADD COLUMN origin_stale INTEGER DEFAULT 0',
    'ALTER TABLE snapshots ADD COLUMN origin_mtime INTEGER',
    'ALTER TABLE snapshots ADD COLUMN origin_file TEXT',
    'ALTER TABLE snapshots ADD COLUMN origin_note TEXT',
  ]) {
    try { db.run(sql); } catch (e) { /* exists */ }
  }

}

function applyLocalClassify(normalized) {
  const windows = normalized.windows.map((w) => {
    const classified = core.localPreCategorize(w.tabs);
    const { tabs } = core.dedupPreview(classified);
    return { ...w, tabs };
  });
  return { ...normalized, windows, tabCount: core.countTabs(windows) };
}

/**
 * Persist a snapshot in one transaction. `persisted=1` is written in the
 * same transaction, so a crash/rollback cannot yield a closeable row.
 * Throws (and does not flip persisted) on validation or write errors.
 */
function saveSnapshot(store, raw, extras = {}) {
  const normalized = applyLocalClassify(core.normalizeSnapshot(raw, extras));
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const db = store.db;
  db.run('BEGIN');
  try {
    const origin = core.sanitizeOrigin(normalized.origin) || null;
    const originNote = origin ? honestyNote(origin) : '';
    const rawJson = {
      schemaVersion: normalized.schemaVersion,
      capturedAt: normalized.capturedAt,
      origin,
    };
    db.run(
      `INSERT INTO snapshots(id, created_at, title, source, browser_id, browser_name, profile,
        persisted, close_status, tab_count, raw_json, extension_id, audience_browser,
        origin_locked, origin_stale, origin_mtime, origin_file, origin_note)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, createdAt, normalized.title, normalized.source,
        normalized.browserId, normalized.browserName, normalized.profile,
        normalized.tabCount, JSON.stringify(rawJson),
        normalized.source === 'extension' ? (extras.extensionId || normalized.extensionId || '') : '',
        extras.audienceBrowser || normalized.browserId || '',
        origin && origin.locked ? 1 : 0,
        origin && origin.stale ? 1 : 0,
        origin && origin.sourceMtime != null ? origin.sourceMtime : null,
        origin ? (origin.sourceFileBase || '') : '',
        originNote,
      ]
    );
    for (const w of normalized.windows) {
      const wid = crypto.randomUUID();
      db.run(
        `INSERT INTO snapshot_windows(id, snapshot_id, window_id, window_index, focused, incognito, type, state, left, top, width, height)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [wid, id, w.windowId, w.windowIndex, w.focused ? 1 : 0, w.incognito ? 1 : 0, w.type, w.state, w.left, w.top, w.width, w.height]
      );
      for (const t of w.tabs) {
        db.run(
          `INSERT INTO snapshot_tabs(id, snapshot_id, window_row_id, tab_id, tab_index, url, title, pinned, active, discarded, incognito,
            favicon, group_id, group_title, group_color, domain, restorable, category, tags, purpose, summary, user_group, hidden_dup, restore_status)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none')`,
          [
            crypto.randomUUID(), id, wid, t.tabId, t.tabIndex, t.url, t.title,
            t.pinned ? 1 : 0, t.active ? 1 : 0, t.discarded ? 1 : 0, t.incognito ? 1 : 0,
            t.favicon || '', t.groupId, t.groupTitle || '', t.groupColor || '',
            t.domain || '', t.restorable ? 1 : 0, t.category || '',
            JSON.stringify(t.tags || []), t.purpose || '', t.summary || '',
            t.userGroup || t.category || '', t.hiddenDup ? 1 : 0,
          ]
        );
      }
    }
    db.run('UPDATE snapshots SET persisted = 1 WHERE id = ?', [id]);
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  }
  if (store._scheduleSave) store._scheduleSave();
  const saved = getSnapshot(store, id);
  if (!saved || !saved.persisted || saved.tabCount !== normalized.tabCount) {
    throw new Error('快照写入后校验失败，未标记为可关闭');
  }
  return saved;
}

function tabRow(r) {
  return {
    id: r.id,
    tabId: r.tab_id,
    tabIndex: Number(r.tab_index),
    url: r.url,
    title: r.title,
    pinned: !!r.pinned,
    active: !!r.active,
    discarded: !!r.discarded,
    incognito: !!r.incognito,
    favicon: r.favicon || '',
    groupId: r.group_id,
    groupTitle: r.group_title || '',
    groupColor: r.group_color || '',
    domain: r.domain || '',
    restorable: !!r.restorable,
    category: r.category || '',
    tags: r.tags ? JSON.parse(r.tags) : [],
    purpose: r.purpose || '',
    summary: r.summary || '',
    userGroup: r.user_group || '',
    hiddenDup: !!r.hidden_dup,
    restoreStatus: r.restore_status || 'none',
    restoreError: r.restore_error || '',
    windowRowId: r.window_row_id,
  };
}

function getSnapshot(store, id) {
  const rows = queryAll(store.db, 'SELECT * FROM snapshots WHERE id = ?', [id]);
  if (!rows.length) return null;
  return hydrate(store, rows[0]);
}

function hydrate(store, s) {
  const windows = queryAll(
    store.db,
    'SELECT * FROM snapshot_windows WHERE snapshot_id = ? ORDER BY window_index ASC',
    [s.id]
  );
  const tabs = queryAll(
    store.db,
    'SELECT * FROM snapshot_tabs WHERE snapshot_id = ? ORDER BY tab_index ASC',
    [s.id]
  );
  const byWin = new Map();
  for (const w of windows) {
    byWin.set(w.id, {
      id: w.id,
      windowId: w.window_id,
      windowIndex: Number(w.window_index),
      focused: !!w.focused,
      incognito: !!w.incognito,
      type: w.type,
      state: w.state,
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
      tabs: [],
    });
  }
  const orphans = [];
  for (const t of tabs) {
    const row = tabRow(t);
    const w = byWin.get(t.window_row_id);
    if (w) w.tabs.push(row);
    else orphans.push(row);
  }
  const windowList = Array.from(byWin.values());
  if (orphans.length) {
    windowList.push({
      id: 'orphans', windowId: null, windowIndex: windowList.length,
      focused: false, incognito: false, type: 'normal', state: 'normal',
      left: null, top: null, width: null, height: null, tabs: orphans,
    });
  }
  return {
    id: s.id,
    createdAt: Number(s.created_at),
    title: s.title,
    source: s.source,
    browserId: s.browser_id,
    browserName: s.browser_name,
    profile: s.profile || '',
    persisted: !!s.persisted,
    closeStatus: s.close_status || 'none',
    closeError: s.close_error || '',
    closeConfirmedAt: s.close_confirmed_at ? Number(s.close_confirmed_at) : null,
    aiStatus: s.ai_status || 'none',
    aiError: s.ai_error || '',
    tabCount: Number(s.tab_count) || core.countTabs(windowList),
    extensionId: s.extension_id || '',
    audienceBrowser: s.audience_browser || s.browser_id || '',
    origin: originFromRow(s),
    windows: windowList,
  };
}

function originFromRow(s) {
  let fromJson = null;
  try {
    const raw = s.raw_json ? JSON.parse(s.raw_json) : null;
    if (raw && raw.origin) fromJson = core.sanitizeOrigin(raw.origin);
  } catch (e) { /* ignore */ }
  if (s.source !== 'session-file' && !fromJson) return null;
  const origin = fromJson || core.sanitizeOrigin({
    locked: s.origin_locked,
    stale: s.origin_stale,
    sourceMtime: s.origin_mtime,
    sourceFileBase: s.origin_file,
  });
  if (origin && s.origin_note) origin.note = s.origin_note;
  return origin;
}


function listSnapshots(store, limit = 100) {
  const rows = queryAll(
    store.db,
    'SELECT * FROM snapshots WHERE persisted = 1 ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: Number(r.created_at),
    title: r.title,
    source: r.source,
    browserId: r.browser_id,
    browserName: r.browser_name,
    profile: r.profile || '',
    persisted: true,
    closeStatus: r.close_status || 'none',
    closeError: r.close_error || '',
    aiStatus: r.ai_status || 'none',
    aiError: r.ai_error || '',
    tabCount: Number(r.tab_count) || 0,
    extensionId: r.extension_id || '',
    origin: r.source === 'session-file' ? originFromRow(r) : null,
  }));
}

function updateTabMeta(store, tabRowId, patch) {
  const current = queryAll(store.db, 'SELECT * FROM snapshot_tabs WHERE id = ?', [tabRowId]);
  if (!current.length) return false;
  const c = current[0];
  const tags = patch.tags !== undefined ? JSON.stringify(patch.tags) : c.tags;
  store.db.run(
    `UPDATE snapshot_tabs SET category = ?, tags = ?, purpose = ?, summary = ?, user_group = ?, hidden_dup = ?,
      restore_status = ?, restore_error = ?
     WHERE id = ?`,
    [
      patch.category !== undefined ? patch.category : c.category,
      tags,
      patch.purpose !== undefined ? patch.purpose : c.purpose,
      patch.summary !== undefined ? patch.summary : c.summary,
      patch.userGroup !== undefined ? patch.userGroup : c.user_group,
      patch.hiddenDup !== undefined ? (patch.hiddenDup ? 1 : 0) : c.hidden_dup,
      patch.restoreStatus !== undefined ? patch.restoreStatus : c.restore_status,
      patch.restoreError !== undefined ? patch.restoreError : c.restore_error,
      tabRowId,
    ]
  );
  if (store._scheduleSave) store._scheduleSave();
  return true;
}

function renameGroup(store, snapshotId, fromName, toName) {
  const name = String(toName || '').trim();
  if (!name) return 0;
  store.db.run(
    'UPDATE snapshot_tabs SET user_group = ? WHERE snapshot_id = ? AND user_group = ?',
    [name, snapshotId, fromName]
  );
  if (store._scheduleSave) store._scheduleSave();
  return store.db.getRowsModified();
}

function setCloseStatus(store, snapshotId, status, error = '') {
  store.db.run(
    `UPDATE snapshots SET close_status = ?, close_error = ?, close_confirmed_at = CASE WHEN ? = 'pending' THEN ? ELSE close_confirmed_at END
     WHERE id = ? AND persisted = 1`,
    [status, error || '', status, Date.now(), snapshotId]
  );
  if (store._scheduleSave) store._scheduleSave();
  return getSnapshot(store, snapshotId);
}

function setAiStatus(store, snapshotId, status, error = '') {
  store.db.run('UPDATE snapshots SET ai_status = ?, ai_error = ? WHERE id = ?', [status, error || '', snapshotId]);
  if (store._scheduleSave) store._scheduleSave();
}

function applyTabPatches(store, snapshotId, tabs) {
  for (const t of tabs || []) {
    if (!t.id) continue;
    updateTabMeta(store, t.id, t);
  }
  return getSnapshot(store, snapshotId);
}

const STALE_IN_FLIGHT_REASON = '应用重启或页签桥重新启动后，尚未执行完的扩展指令已经失效（当时只存在于内存队列）。请重新发起恢复或关闭。';

function clearStaleInFlight(store, reason) {
  const msg = reason || STALE_IN_FLIGHT_REASON;
  const pendingCloses = queryAll(store.db, "SELECT id FROM snapshots WHERE persisted = 1 AND close_status = 'pending'");
  for (const r of pendingCloses) setCloseStatus(store, r.id, 'failed', msg);
  const queued = queryAll(store.db, "SELECT id FROM snapshot_tabs WHERE restore_status = 'queued'");
  for (const r of queued) updateTabMeta(store, r.id, { restoreStatus: 'failed', restoreError: msg });
  return { closeMarkedFailed: pendingCloses.length, restoreMarkedFailed: queued.length, reason: msg };
}

function deleteSnapshot(store, snapshotId) {
  store.db.run('DELETE FROM snapshot_tabs WHERE snapshot_id = ?', [snapshotId]);
  store.db.run('DELETE FROM snapshot_windows WHERE snapshot_id = ?', [snapshotId]);
  store.db.run('DELETE FROM snapshots WHERE id = ?', [snapshotId]);
  if (store._scheduleSave) store._scheduleSave();
  return true;
}

function countByDomain(store, domain) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!d) return 0;
  const rows = queryAll(
    store.db,
    "SELECT COUNT(*) AS c FROM visits WHERE lower(domain) = ? OR lower(domain) LIKE ?",
    [d, '%.' + d]
  );
  return Number(rows[0] && rows[0].c) || 0;
}

module.exports = {
  migrateSnapshotTables,
  saveSnapshot,
  getSnapshot,
  listSnapshots,
  updateTabMeta,
  renameGroup,
  setCloseStatus,
  setAiStatus,
  applyTabPatches,
  deleteSnapshot,
  clearStaleInFlight,
  STALE_IN_FLIGHT_REASON,
  countByDomain,
  applyLocalClassify,
};
