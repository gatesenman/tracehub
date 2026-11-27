'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabaseFromFile, queryAll } = require('./sqlengine');
const { snapshotHistory, cleanupSnapshot } = require('./history-snapshot');

// ---------------------------------------------------------------------------
// Time conversions
//   Chromium: microseconds since 1601-01-01 UTC (Windows FILETIME epoch)
//   Firefox : microseconds since 1970-01-01 UTC (Unix epoch)
// Both are normalised to JS epoch milliseconds.
// ---------------------------------------------------------------------------
const CHROME_EPOCH_OFFSET_MS = 11644473600000; // ms between 1601 and 1970

function chromeTimeToMs(microseconds) {
  if (!microseconds) return 0;
  return Math.floor(Number(microseconds) / 1000) - CHROME_EPOCH_OFFSET_MS;
}

function firefoxTimeToMs(microseconds) {
  if (!microseconds) return 0;
  return Math.floor(Number(microseconds) / 1000);
}

// ---------------------------------------------------------------------------
// Browser location definitions (Windows / macOS / Linux)
// ---------------------------------------------------------------------------
function chromiumRoots() {
  const home = os.homedir();
  const platform = process.platform;
  const roots = [];
  const add = (id, name, engine, base) => roots.push({ id, name, engine, base });

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    add('chrome', 'Google Chrome', 'chromium', path.join(local, 'Google', 'Chrome', 'User Data'));
    add('edge', 'Microsoft Edge', 'chromium', path.join(local, 'Microsoft', 'Edge', 'User Data'));
    add('brave', 'Brave', 'chromium', path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'));
    add('vivaldi', 'Vivaldi', 'chromium', path.join(local, 'Vivaldi', 'User Data'));
    add('opera', 'Opera', 'chromium', path.join(roaming, 'Opera Software', 'Opera Stable'));
    add('firefox', 'Mozilla Firefox', 'firefox', path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'));
  } else if (platform === 'darwin') {
    const app = path.join(home, 'Library', 'Application Support');
    add('chrome', 'Google Chrome', 'chromium', path.join(app, 'Google', 'Chrome'));
    add('edge', 'Microsoft Edge', 'chromium', path.join(app, 'Microsoft Edge'));
    add('brave', 'Brave', 'chromium', path.join(app, 'BraveSoftware', 'Brave-Browser'));
    add('vivaldi', 'Vivaldi', 'chromium', path.join(app, 'Vivaldi'));
    add('firefox', 'Mozilla Firefox', 'firefox', path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'));
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    add('chrome', 'Google Chrome', 'chromium', path.join(config, 'google-chrome'));
    add('chromium', 'Chromium', 'chromium', path.join(config, 'chromium'));
    add('edge', 'Microsoft Edge', 'chromium', path.join(config, 'microsoft-edge'));
    add('brave', 'Brave', 'chromium', path.join(config, 'BraveSoftware', 'Brave-Browser'));
    add('vivaldi', 'Vivaldi', 'chromium', path.join(config, 'vivaldi'));
    add('firefox', 'Mozilla Firefox', 'firefox', path.join(home, '.mozilla', 'firefox'));
  }

  // Extra chromium user-data dirs (portable installs, custom --user-data-dir),
  // semicolon-separated in the BHH_EXTRA_CHROMIUM_DIRS env var.
  const extra = process.env.BHH_EXTRA_CHROMIUM_DIRS || '';
  extra
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((dir, idx) => add(`custom${idx}`, `Chromium (${path.basename(dir)})`, 'chromium', dir));

  return roots;
}

// A real Chromium/Firefox history file is a SQLite database. Zero-byte stubs
// (common leftover Opera / old Firefox profiles) exist() but have no tables;
// opening them and querying visits / moz_historyvisits surfaces a scary
// "no such table" error and, for Opera, can collide with the real
// Default/History under the same profile name.
const SQLITE_HEADER = Buffer.from('SQLite format 3');

function isPlausibleHistorySqlite(filePath) {
  let fd;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 100) return false;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.equals(SQLITE_HEADER);
  } catch (e) {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
    }
  }
}

function hasSqliteTable(db, name) {
  const rows = queryAll(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [name]
  );
  return rows.length > 0;
}

function visitTableForEngine(engine) {
  return engine === 'firefox' ? 'moz_historyvisits' : 'visits';
}

// Given a chromium "User Data" dir, find every profile that has a History db.
function chromiumProfiles(root) {
  const profiles = [];
  if (!fs.existsSync(root.base)) return profiles;

  let entries = [];
  try {
    entries = fs.readdirSync(root.base, { withFileTypes: true });
  } catch (e) {
    return profiles;
  }
  const found = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name !== 'Default' && !name.startsWith('Profile ') && name !== 'Guest Profile') continue;
    const historyPath = path.join(root.base, name, 'History');
    if (isPlausibleHistorySqlite(historyPath)) {
      profiles.push({ profile: name, historyPath });
      found.add(name);
    }
  }

  // Classic Opera keeps History at the user-data root. Only use it when there
  // is no Default/History, so a zero-byte stub at the root cannot hide or
  // share a cursor with Opera Stable/Default/History.
  const direct = path.join(root.base, 'History');
  if (!found.has('Default') && isPlausibleHistorySqlite(direct)) {
    profiles.unshift({ profile: 'Default', historyPath: direct });
  }
  return profiles;
}

// Find every Firefox profile that has a usable places.sqlite.
function firefoxProfiles(root) {
  const profiles = [];
  if (!fs.existsSync(root.base)) return profiles;
  let entries = [];
  try {
    entries = fs.readdirSync(root.base, { withFileTypes: true });
  } catch (e) {
    return profiles;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const placesPath = path.join(root.base, entry.name, 'places.sqlite');
    if (isPlausibleHistorySqlite(placesPath)) {
      profiles.push({ profile: entry.name, historyPath: placesPath });
    }
  }
  return profiles;
}

// Return the list of installed browsers with the profiles we can read.
function detectBrowsers() {
  const result = [];
  for (const root of chromiumRoots()) {
    const profiles = root.engine === 'firefox' ? firefoxProfiles(root) : chromiumProfiles(root);
    if (profiles.length > 0) {
      result.push({ id: root.id, name: root.name, engine: root.engine, profiles });
    }
  }
  return result;
}

// Snapshot a (possibly locked) live history db into the on-disk cache and
// open that copy. The live file is never opened with SQLite. Unchanged
// sources reuse the cache; otherwise only dirty 1 MiB blocks are rewritten.
async function withHistorySnapshot(historyPath, tag, fn) {
  const snap = snapshotHistory(historyPath, tag);
  try {
    const db = await openDatabaseFromFile(snap.filePath);
    try {
      return await fn(db, snap);
    } finally {
      db.close();
    }
  } finally {
    cleanupSnapshot(snap);
  }
}

// Read history visits from a single browser profile.
// sinceMs: only return visits with visitTime > sinceMs (incremental sync).
async function readProfileHistory(browser, profile, sinceMs = 0) {
  const tag = `${browser.id}-${profile.profile}`.replace(/[^\w]+/g, '_');
  const items = [];
  await withHistorySnapshot(profile.historyPath, tag, async (db) => {
      if (!hasSqliteTable(db, visitTableForEngine(browser.engine))) return;
      if (browser.engine === 'firefox') {
        const sinceMicros = sinceMs > 0 ? sinceMs * 1000 : 0;
        const rows = queryAll(
          db,
          `SELECT p.url AS url, p.title AS title, v.visit_date AS visit_date,
                  fp.url AS from_url
             FROM moz_historyvisits v
             JOIN moz_places p ON p.id = v.place_id
             LEFT JOIN moz_historyvisits fv ON fv.id = v.from_visit
             LEFT JOIN moz_places fp ON fp.id = fv.place_id
            WHERE v.visit_date > ?
            ORDER BY v.visit_date DESC
            LIMIT 20000`,
          [sinceMicros]
        );
        for (const r of rows) {
          items.push({
            url: r.url,
            title: r.title || r.url,
            visitTime: firefoxTimeToMs(r.visit_date),
            browser: browser.id,
            browserName: browser.name,
            profile: profile.profile,
            fromUrl: r.from_url && r.from_url !== r.url ? r.from_url : null,
          });
        }
      } else {
        const sinceMicros = sinceMs > 0 ? (sinceMs + CHROME_EPOCH_OFFSET_MS) * 1000 : 0;
        const rows = queryAll(
          db,
          `SELECT u.url AS url, u.title AS title, v.visit_time AS visit_time,
                  fu.url AS from_url
             FROM visits v
             JOIN urls u ON u.id = v.url
             LEFT JOIN visits fv ON fv.id = v.from_visit
             LEFT JOIN urls fu ON fu.id = fv.url
            WHERE v.visit_time > ?
            ORDER BY v.visit_time DESC
            LIMIT 20000`,
          [sinceMicros]
        );
        for (const r of rows) {
          items.push({
            url: r.url,
            title: r.title || r.url,
            visitTime: chromeTimeToMs(r.visit_time),
            browser: browser.id,
            browserName: browser.name,
            profile: profile.profile,
            fromUrl: r.from_url && r.from_url !== r.url ? r.from_url : null,
          });
        }
      }
  });
  return items;
}

// ---------------------------------------------------------------------------
// Cursor-based (gap-filling) reads used by the sync engine.
//
// A cursor is { visitId, visitTime } taken from the browser's own visits
// table (Chromium `visits.id`, Firefox `moz_historyvisits.id`; visitTime in
// JS ms). A visit is new when its id is above the cursor id OR its time is
// above the cursor time: the id catches visits written while TraceHub was
// closed even if they carry older timestamps (e.g. Chrome Sync from another
// device), the time catches ids reused after the browser deleted its newest
// rows. Rows are returned oldest-id first, at most `limit` per call, with
// `hasMore` so the caller can keep paging without skipping anything. With
// visitId == null only the time bound applies (first run / upgrade).
// ---------------------------------------------------------------------------
const VISIT_PAGE_LIMIT = 20000;

function visitsQuery(engine, hasId, limit) {
  const idCond = hasId ? 'v.id > ? OR ' : '';
  if (engine === 'firefox') {
    return `SELECT v.id AS vid, p.url AS url, p.title AS title, v.visit_date AS t,
                   fp.url AS from_url
              FROM moz_historyvisits v
              JOIN moz_places p ON p.id = v.place_id
              LEFT JOIN moz_historyvisits fv ON fv.id = v.from_visit
              LEFT JOIN moz_places fp ON fp.id = fv.place_id
             WHERE ${idCond}v.visit_date > ?
             ORDER BY v.id ASC
             LIMIT ${limit + 1}`;
  }
  return `SELECT v.id AS vid, u.url AS url, u.title AS title, v.visit_time AS t,
                 fu.url AS from_url
            FROM visits v
            JOIN urls u ON u.id = v.url
            LEFT JOIN visits fv ON fv.id = v.from_visit
            LEFT JOIN urls fu ON fu.id = fv.url
           WHERE ${idCond}v.visit_time > ?
           ORDER BY v.id ASC
           LIMIT ${limit + 1}`;
}

async function readProfileVisits(browser, profile, cursor = {}, { limit = VISIT_PAGE_LIMIT } = {}) {
  const firefox = browser.engine === 'firefox';
  const hasId = cursor && cursor.visitId != null && Number.isFinite(Number(cursor.visitId));
  const sinceMs = Math.max(0, Number((cursor && cursor.visitTime) || 0));
  const toSource = (ms) => (firefox ? ms * 1000 : (ms + CHROME_EPOCH_OFFSET_MS) * 1000);
  const sinceSource = sinceMs > 0 ? toSource(sinceMs) : 0;
  const params = hasId ? [Number(cursor.visitId), sinceSource] : [sinceSource];

  const tag = `${browser.id}-${profile.profile}`.replace(/[^\w]+/g, '_');
  const items = [];
  let next = { visitId: hasId ? Number(cursor.visitId) : 0, visitTime: sinceMs };
  let hasMore = false;
  await withHistorySnapshot(profile.historyPath, tag, async (db) => {
      if (!hasSqliteTable(db, visitTableForEngine(browser.engine))) return;
      const rows = queryAll(db, visitsQuery(browser.engine, hasId, limit), params);
      hasMore = rows.length > limit;
      for (const r of rows.slice(0, limit)) {
        const visitTime = firefox ? firefoxTimeToMs(r.t) : chromeTimeToMs(r.t);
        const vid = Number(r.vid);
        if (vid > next.visitId) next.visitId = vid;
        if (visitTime > next.visitTime) next.visitTime = visitTime;
        items.push({
          url: r.url,
          title: r.title || r.url,
          visitTime,
          browser: browser.id,
          browserName: browser.name,
          profile: profile.profile,
          fromUrl: r.from_url && r.from_url !== r.url ? r.from_url : null,
        });
      }
  });
  return { items, cursor: next, hasMore };
}

// Visits whose time falls in [fromMs, toMs). Used to repair one calendar day
// from the browser's own history without depending on the sync cursor.
function visitsRangeQuery(engine, limit) {
  if (engine === 'firefox') {
    return `SELECT v.id AS vid, p.url AS url, p.title AS title, v.visit_date AS t,
                   fp.url AS from_url
              FROM moz_historyvisits v
              JOIN moz_places p ON p.id = v.place_id
              LEFT JOIN moz_historyvisits fv ON fv.id = v.from_visit
              LEFT JOIN moz_places fp ON fp.id = fv.place_id
             WHERE v.visit_date >= ? AND v.visit_date < ? AND v.id > ?
             ORDER BY v.id ASC
             LIMIT ${limit + 1}`;
  }
  return `SELECT v.id AS vid, u.url AS url, u.title AS title, v.visit_time AS t,
                 fu.url AS from_url
            FROM visits v
            JOIN urls u ON u.id = v.url
            LEFT JOIN visits fv ON fv.id = v.from_visit
            LEFT JOIN urls fu ON fu.id = fv.url
           WHERE v.visit_time >= ? AND v.visit_time < ? AND v.id > ?
           ORDER BY v.id ASC
           LIMIT ${limit + 1}`;
}

async function readProfileVisitsInRange(browser, profile, fromMs, toMs, { limit = VISIT_PAGE_LIMIT, afterVisitId = 0 } = {}) {
  const firefox = browser.engine === 'firefox';
  const toSource = (ms) => (firefox ? ms * 1000 : (ms + CHROME_EPOCH_OFFSET_MS) * 1000);
  const lo = Math.max(0, Number(fromMs) || 0);
  const hi = Math.max(lo, Number(toMs) || 0);
  const items = [];
  let lastId = Number(afterVisitId) || 0;
  if (hi <= lo) return { items, hasMore: false, lastId };
  const tag = `${browser.id}-${profile.profile}-range`.replace(/[^\w]+/g, '_');
  let hasMore = false;
  await withHistorySnapshot(profile.historyPath, tag, async (db) => {
    if (!hasSqliteTable(db, visitTableForEngine(browser.engine))) return;
    const rows = queryAll(db, visitsRangeQuery(browser.engine, limit), [toSource(lo), toSource(hi), lastId]);
    hasMore = rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      const visitTime = firefox ? firefoxTimeToMs(r.t) : chromeTimeToMs(r.t);
      const vid = Number(r.vid) || 0;
      if (vid > lastId) lastId = vid;
      items.push({
        url: r.url,
        title: r.title || r.url,
        visitTime,
        browser: browser.id,
        browserName: browser.name,
        profile: profile.profile,
        fromUrl: r.from_url && r.from_url !== r.url ? r.from_url : null,
      });
    }
  });
  return { items, hasMore, lastId };
}

// Read history from all detected browsers/profiles since a timestamp.
async function readAllHistory(sinceMs = 0, browsers = null) {
  const detected = browsers || detectBrowsers();
  const all = [];
  const errors = [];
  for (const browser of detected) {
    for (const profile of browser.profiles) {
      try {
        const items = await readProfileHistory(browser, profile, sinceMs);
        all.push(...items);
      } catch (e) {
        errors.push({ browser: browser.id, profile: profile.profile, error: String(e.message || e) });
      }
    }
  }
  return { items: all, errors };
}

// ------------------------- native bookmarks --------------------------------

// Walk a chromium Bookmarks JSON node collecting {url,title,folder}.
function walkChromiumBookmarks(node, folderPath, out) {
  if (!node) return;
  if (node.type === 'url' && node.url) {
    out.push({ url: node.url, title: node.name || node.url, folder: folderPath || null });
  } else if (Array.isArray(node.children)) {
    const next = node.type === 'folder' && node.name ? (folderPath ? `${folderPath}/${node.name}` : node.name) : folderPath;
    for (const c of node.children) walkChromiumBookmarks(c, next, out);
  }
}

function readChromiumBookmarks(profile) {
  const file = path.join(path.dirname(profile.historyPath), 'Bookmarks');
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const roots = (data && data.roots) || {};
  for (const key of Object.keys(roots)) walkChromiumBookmarks(roots[key], '', out);
  return out;
}

async function readFirefoxBookmarks(browser, profile) {
  const tag = `${browser.id}-${profile.profile}-bm`.replace(/[^\w]+/g, '_');
  const out = [];
  await withHistorySnapshot(profile.historyPath, tag, async (db) => {
      const folders = new Map(); // id -> {title, parent}
      for (const r of queryAll(db, 'SELECT id, parent, title FROM moz_bookmarks WHERE type = 2')) {
        folders.set(Number(r.id), { title: r.title || '', parent: Number(r.parent) });
      }
      const folderPath = (id) => {
        const parts = [];
        let cur = folders.get(id);
        let guard = 0;
        while (cur && guard++ < 20) {
          // Skip firefox root containers (menu/toolbar/unfiled names kept, root skipped).
          if (cur.title) parts.unshift(cur.title);
          cur = folders.get(cur.parent);
        }
        return parts.join('/') || null;
      };
      const rows = queryAll(
        db,
        `SELECT b.title AS title, b.parent AS parent, p.url AS url
           FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
          WHERE b.type = 1 AND p.url LIKE 'http%'`
      );
      for (const r of rows) {
        out.push({ url: r.url, title: r.title || r.url, folder: folderPath(Number(r.parent)) });
      }
  });
  return out;
}

// Read native bookmarks from every detected browser/profile.
async function readAllBookmarks(browsers = null) {
  const detected = browsers || detectBrowsers();
  const all = [];
  const errors = [];
  for (const browser of detected) {
    for (const profile of browser.profiles) {
      try {
        const items = browser.engine === 'firefox'
          ? await readFirefoxBookmarks(browser, profile)
          : readChromiumBookmarks(profile);
        for (const it of items) all.push({ ...it, browserName: browser.name });
      } catch (e) {
        errors.push({ browser: browser.id, profile: profile.profile, error: String(e.message || e) });
      }
    }
  }
  return { items: all, errors };
}

module.exports = {
  detectBrowsers,
  chromiumProfiles,
  firefoxProfiles,
  isPlausibleHistorySqlite,
  readProfileHistory,
  readProfileVisits,
  readProfileVisitsInRange,
  readAllHistory,
  readAllBookmarks,
  chromeTimeToMs,
  firefoxTimeToMs,
};
