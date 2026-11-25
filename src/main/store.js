'use strict';

const path = require('path');
const { openPersistentDatabase, persist, queryAll } = require('./sqlengine');
const { migrateSnapshotTables } = require('./snapshot-store');

// Unified store persisted as a single SQLite file in the app's user data dir.
class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this._dirty = false;
    this._saveTimer = null;
  }

  async init() {
    this.db = await openPersistentDatabase(this.dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT,
        visit_time INTEGER NOT NULL,
        browser TEXT,
        browser_name TEXT,
        profile TEXT,
        domain TEXT,
        UNIQUE(url, visit_time, browser, profile)
      );
      CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(visit_time);
      CREATE INDEX IF NOT EXISTS idx_visits_domain ON visits(domain);

      CREATE TABLE IF NOT EXISTS bookmarks (
        url TEXT PRIMARY KEY,
        title TEXT,
        note TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS categories (
        url TEXT PRIMARY KEY,
        category TEXT,
        tags TEXT,
        summary TEXT,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS site_meta (
        url TEXT PRIMARY KEY,
        favicon TEXT,
        description TEXT,
        summary TEXT,
        keywords TEXT,
        fetched_at INTEGER,
        enriched_at INTEGER,
        fetch_failed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS read_later (
        url TEXT PRIMARY KEY,
        title TEXT,
        added_at INTEGER,
        done_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS page_text (
        url TEXT PRIMARY KEY,
        content TEXT,
        indexed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS thumbs (
        url TEXT PRIMARY KEY,
        file TEXT,
        captured_at INTEGER,
        failed INTEGER DEFAULT 0
      );
    `);
    // Additive columns for older databases (safe no-op when they exist).
    for (const sql of [
      'ALTER TABLE visits ADD COLUMN from_url TEXT',
      'ALTER TABLE visits ADD COLUMN hidden INTEGER DEFAULT 0',
      'ALTER TABLE bookmarks ADD COLUMN folder TEXT',
      `CREATE TABLE IF NOT EXISTS bookmark_folders (
        name TEXT PRIMARY KEY,
        created_at INTEGER
      )`,
      'ALTER TABLE bookmark_folders ADD COLUMN position INTEGER DEFAULT 0',
      `CREATE TABLE IF NOT EXISTS bookmark_content (
        url TEXT PRIMARY KEY,
        content TEXT,
        archived_at INTEGER
      )`,
    ]) {
      try { this.db.run(sql); } catch (e) { /* column already exists */ }
    }
    migrateSnapshotTables(this.db);
    try { this.migrateDecoupleReadLater(); } catch (e) { /* ignore */ }
    this._scheduleSave();
    return this;
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, 5000);
    // Do not keep a process (or a test) alive just for a deferred flush.
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  save() {
    if (!this.db) return;
    persist(this.db, this.dbPath);
    this._dirty = false;
  }

  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty && this.db) {
      try { this.save(); } catch (e) { /* ignore */ }
    }
    if (this.db) {
      try { this.db.close(); } catch (e) { /* ignore */ }
      this.db = null;
    }
  }

  getMeta(key, fallback = null) {
    const rows = queryAll(this.db, 'SELECT value FROM meta WHERE key = ?', [key]);
    return rows.length ? rows[0].value : fallback;
  }

  setMeta(key, value) {
    this.db.run(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
    this._scheduleSave();
  }

  // Per browser+profile sync cursor ({ visitId, visitTime }) into the
  // browser's own history DB; see SyncEngine._syncProfile.
  getSyncCursor(browser, profile) {
    const raw = this.getMeta(syncCursorKey(browser, profile));
    if (!raw) return null;
    try {
      const c = JSON.parse(raw);
      if (!c || typeof c !== 'object') return null;
      return {
        visitId: c.visitId == null ? null : Number(c.visitId),
        visitTime: Number(c.visitTime) || 0,
      };
    } catch (e) {
      return null;
    }
  }

  setSyncCursor(browser, profile, cursor) {
    this.setMeta(syncCursorKey(browser, profile), JSON.stringify({
      visitId: cursor && cursor.visitId != null ? Number(cursor.visitId) : null,
      visitTime: Number(cursor && cursor.visitTime) || 0,
    }));
  }

  // Insert a batch of visits, ignoring duplicates. Returns number inserted.
  upsertVisits(items) {
    if (!items || items.length === 0) return 0;
    let inserted = 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO visits(url, title, visit_time, browser, browser_name, profile, domain, from_url)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      this.db.run('BEGIN');
      for (const it of items) {
        if (!it.url || !it.visitTime) continue;
        stmt.run([
          it.url,
          it.title || it.url,
          it.visitTime,
          it.browser || '',
          it.browserName || '',
          it.profile || '',
          domainOf(it.url),
          it.fromUrl || null,
        ]);
        inserted += this.db.getRowsModified();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      stmt.free();
    }
    if (inserted > 0) this._scheduleSave();
    return inserted;
  }

  // Purge every trace of a domain and its subdomains (privacy blacklist).
  deleteByDomain(domain) {
    const d = String(domain || '').toLowerCase().replace(/^www\./, '');
    if (!d) return 0;
    const urlMatch = (col) =>
      ` (lower(${col}) LIKE '%://' || ? || '/%' OR lower(${col}) LIKE '%://' || ? || '' OR lower(${col}) LIKE '%://www.' || ? || '/%' OR lower(${col}) LIKE '%://www.' || ? || '') `;
    // visits first (the number we report), then related caches. Bookmarks are kept.
    this.db.run("DELETE FROM visits WHERE lower(domain) = ? OR lower(domain) LIKE ?", [d, '%.' + d]);
    const removed = this.db.getRowsModified();
    for (const table of ['site_meta', 'page_text', 'thumbs']) {
      try {
        this.db.run(
          `DELETE FROM ${table} WHERE lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ? OR lower(url) LIKE ?`,
          [`%://${d}/%`, `%://${d}`, `%://www.${d}/%`, `%://www.${d}`]
        );
      } catch (e) { /* table may not exist in very old tests */ }
    }
    this._scheduleSave();
    return removed;
  }

  migrateDecoupleReadLater() {
    if (this.getMeta('readLaterDecoupledAt')) return 0;
    this.db.run(
      `UPDATE read_later SET done_at = ? WHERE done_at IS NULL AND url IN (SELECT url FROM bookmarks)`,
      [Date.now()]
    );
    const n = this.db.getRowsModified();
    this.setMeta('readLaterDecoupledAt', String(Date.now()));
    return n;
  }

  // The most recent visit time we have stored (per browser+profile key).
  latestVisitTime(browser, profile) {
    const rows = queryAll(
      this.db,
      'SELECT MAX(visit_time) AS t FROM visits WHERE browser = ? AND profile = ?',
      [browser, profile]
    );
    return rows.length && rows[0].t ? Number(rows[0].t) : 0;
  }

  // Return distinct day buckets (local time) that have visits, newest first.
  // Aggregated in SQL so huge histories never materialize in JS memory.
  listDays() {
    const tzOff = -new Date().getTimezoneOffset() * 60000;
    const rows = queryAll(
      this.db,
      `SELECT CAST((visit_time + ?) / 86400000 AS INTEGER) AS d, COUNT(*) AS c
         FROM visits WHERE hidden IS NULL OR hidden = 0
        GROUP BY d ORDER BY d DESC`,
      [tzOff]
    );
    return rows.map((r) => ({
      day: dayKey(Number(r.d) * 86400000 - tzOff + 43200000),
      count: Number(r.c),
    }));
  }

  // Return the timeline for a given day (YYYY-MM-DD), grouped by hour+domain.
  timelineForDay(day, browser = null) {
    const dayStart = new Date(`${day}T00:00:00`).getTime();
    const params = [dayStart, dayStart + 86400000];
    let where = `v.visit_time >= ? AND v.visit_time < ? AND ${NOT_HIDDEN}`;
    if (browser) {
      where += ' AND v.browser = ?';
      params.push(browser);
    }
    const rows = queryAll(
      this.db,
      `${SELECT_ITEMS}
        WHERE ${where}
        ORDER BY v.visit_time DESC`,
      params
    );
    const items = rows.map(rowToItem);
    attachDwell(items);
    return items;
  }

  search(query, limit = 500, browser = null, fromMs = null, toMs = null, domain = null) {
    const q = `%${String(query || '').toLowerCase()}%`;
    const params = [q, q, q, q, q];
    let where = `(lower(v.url) LIKE ? OR lower(v.title) LIKE ? OR lower(coalesce(m.description,'')) LIKE ? OR lower(coalesce(m.keywords,'')) LIKE ?
      OR v.url IN (SELECT url FROM page_text WHERE lower(content) LIKE ?))
      AND ${NOT_HIDDEN}`;
    if (browser) {
      where += ' AND v.browser = ?';
      params.push(browser);
    }
    if (domain) {
      const d = String(domain).toLowerCase().replace(/^www\./, '');
      where += ' AND (lower(v.domain) = ? OR lower(v.domain) LIKE ?)';
      params.push(d, '%.' + d);
    }
    if (fromMs != null) {
      where += ' AND v.visit_time >= ?';
      params.push(fromMs);
    }
    if (toMs != null) {
      where += ' AND v.visit_time < ?';
      params.push(toMs);
    }
    params.push(limit);
    const rows = queryAll(
      this.db,
      `${SELECT_ITEMS}
        WHERE ${where}
        ORDER BY v.visit_time DESC
        LIMIT ?`,
      params
    );
    return rows.map(rowToItem);
  }

  // -------- site metadata (logo / description / AI summary / keywords) -----
  upsertSiteMeta(url, patch) {
    const existing = queryAll(this.db, 'SELECT * FROM site_meta WHERE url = ?', [url])[0] || {};
    const merged = {
      favicon: patch.favicon !== undefined ? patch.favicon : existing.favicon || null,
      description: patch.description !== undefined ? patch.description : existing.description || null,
      summary: patch.summary !== undefined ? patch.summary : existing.summary || null,
      keywords: patch.keywords !== undefined ? JSON.stringify(patch.keywords) : existing.keywords || null,
      fetched_at: patch.fetchedAt !== undefined ? patch.fetchedAt : existing.fetched_at || null,
      enriched_at: patch.enrichedAt !== undefined ? patch.enrichedAt : existing.enriched_at || null,
      fetch_failed: patch.fetchFailed !== undefined ? (patch.fetchFailed ? 1 : 0) : existing.fetch_failed || 0,
    };
    this.db.run(
      `INSERT INTO site_meta(url, favicon, description, summary, keywords, fetched_at, enriched_at, fetch_failed)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET favicon=excluded.favicon, description=excluded.description,
         summary=excluded.summary, keywords=excluded.keywords, fetched_at=excluded.fetched_at,
         enriched_at=excluded.enriched_at, fetch_failed=excluded.fetch_failed`,
      [url, merged.favicon, merged.description, merged.summary, merged.keywords,
       merged.fetched_at, merged.enriched_at, merged.fetch_failed]
    );
    this._scheduleSave();
  }

  // Recent distinct URLs that have never had their page metadata fetched.
  urlsNeedingFetch(limit = 8) {
    return queryAll(
      this.db,
      `SELECT v.url, v.title, MAX(v.visit_time) AS visit_time
         FROM visits v
         LEFT JOIN site_meta m ON m.url = v.url
        WHERE v.url LIKE 'http%'
          AND (m.url IS NULL OR (m.fetched_at IS NULL AND m.fetch_failed = 0))
        GROUP BY v.url
        ORDER BY visit_time DESC
        LIMIT ?`,
      [limit]
    ).map((r) => ({ url: r.url, title: r.title }));
  }

  // URLs with fetched metadata but no AI summary yet.
  urlsNeedingAI(limit = 10) {
    return queryAll(
      this.db,
      `SELECT m.url, m.description, v.title
         FROM site_meta m
         JOIN (SELECT url, title, MAX(visit_time) AS t FROM visits GROUP BY url) v ON v.url = m.url
        WHERE m.fetched_at IS NOT NULL AND m.enriched_at IS NULL
        ORDER BY v.t DESC
        LIMIT ?`,
      [limit]
    ).map((r) => ({ url: r.url, title: r.title, description: r.description }));
  }

  // Per-day stats for the dashboard.
  statsForDay(day, browser = null) {
    const items = this.timelineForDay(day, browser);
    const domains = new Map();
    for (const it of items) {
      const d = it.domain || '(其他)';
      domains.set(d, (domains.get(d) || 0) + 1);
    }
    const top = Array.from(domains.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([domain, count]) => ({ domain, count }));
    return {
      visits: items.length,
      distinctUrls: new Set(items.map((i) => i.url)).size,
      distinctDomains: domains.size,
      topDomains: top,
    };
  }

  // Full profile of one site: totals, first/last visit, 30-day trend,
  // most-visited pages. Powers the “站点档案” view.
  domainProfile(domain, trendDays = 30) {
    const d = String(domain || '').toLowerCase().replace(/^www\./, '');
    if (!d) return null;
    const cond = '(lower(domain) = ? OR lower(domain) LIKE ?) AND (hidden IS NULL OR hidden = 0)';
    const params = [d, '%.' + d];
    const totals = queryAll(
      this.db,
      `SELECT COUNT(*) AS visits, COUNT(DISTINCT url) AS pages,
              MIN(visit_time) AS first_t, MAX(visit_time) AS last_t
         FROM visits WHERE ${cond}`,
      params
    )[0];
    if (!totals || !Number(totals.visits)) return null;

    // Per-day counts over the trend window (local days).
    const tzOff = -new Date().getTimezoneOffset() * 60000;
    const since = Date.now() - trendDays * 86400000;
    const trendRows = queryAll(
      this.db,
      `SELECT CAST((visit_time + ?) / 86400000 AS INTEGER) AS d, COUNT(*) AS c
         FROM visits WHERE ${cond} AND visit_time >= ?
        GROUP BY d ORDER BY d ASC`,
      [tzOff, ...params, since]
    );
    const trend = trendRows.map((r) => ({
      day: dayKey(Number(r.d) * 86400000 - tzOff + 43200000),
      count: Number(r.c),
    }));

    const topPages = queryAll(
      this.db,
      `SELECT v.url, v.title, COUNT(*) AS n, MAX(v.visit_time) AS t,
              m.favicon, m.summary,
              (SELECT 1 FROM bookmarks b WHERE b.url = v.url) AS bookmarked
         FROM visits v
         LEFT JOIN site_meta m ON m.url = v.url
        WHERE (lower(v.domain) = ? OR lower(v.domain) LIKE ?) AND ${NOT_HIDDEN}
        GROUP BY v.url
        ORDER BY n DESC, t DESC
        LIMIT 10`,
      params
    ).map((r) => ({
      url: r.url,
      title: r.title,
      visits: Number(r.n),
      lastVisit: Number(r.t),
      favicon: r.favicon || null,
      summary: r.summary || null,
      bookmarked: !!r.bookmarked,
      domain: d,
    }));

    return {
      domain: d,
      visits: Number(totals.visits),
      pages: Number(totals.pages),
      firstVisit: Number(totals.first_t),
      lastVisit: Number(totals.last_t),
      trendDays,
      trend,
      topPages,
    };
  }

  // Flat export of all visits with metadata.
  exportAll() {
    const rows = queryAll(
      this.db,
      `${SELECT_ITEMS}
        ORDER BY v.visit_time DESC`
    );
    return rows.map(rowToItem);
  }

  // Return recent distinct URLs (deduped) for AI operations.
  recentDistinct(limit = 200) {
    const rows = queryAll(
      this.db,
      `SELECT url, title, MAX(visit_time) AS visit_time, domain
         FROM visits
        WHERE hidden IS NULL OR hidden = 0
        GROUP BY url
        ORDER BY visit_time DESC
        LIMIT ?`,
      [limit]
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      visitTime: Number(r.visit_time),
      domain: r.domain,
    }));
  }

  // -------- read later queue --------
  addReadLater(url, title) {
    this.db.run(
      `INSERT INTO read_later(url, title, added_at, done_at) VALUES(?, ?, ?, NULL)
       ON CONFLICT(url) DO UPDATE SET done_at = NULL`,
      [url, title || url, Date.now()]
    );
    this._scheduleSave();
  }

  markReadLaterDone(url, done = true) {
    this.db.run('UPDATE read_later SET done_at = ? WHERE url = ?', [done ? Date.now() : null, url]);
    this._scheduleSave();
  }

  removeReadLater(url) {
    this.db.run('DELETE FROM read_later WHERE url = ?', [url]);
    this._scheduleSave();
  }

  listReadLater(includeDone = true) {
    const rows = queryAll(
      this.db,
      `SELECT r.url, r.title, r.added_at, r.done_at, m.favicon, m.description, m.summary, m.keywords, c.category
         FROM read_later r
         LEFT JOIN site_meta m ON m.url = r.url
         LEFT JOIN categories c ON c.url = r.url
        ${includeDone ? '' : 'WHERE r.done_at IS NULL'}
        ORDER BY (r.done_at IS NOT NULL), r.added_at DESC`
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      addedAt: Number(r.added_at),
      doneAt: r.done_at ? Number(r.done_at) : null,
      favicon: r.favicon || null,
      description: r.description || null,
      summary: r.summary || null,
      keywords: r.keywords ? JSON.parse(r.keywords) : [],
      category: r.category || null,
      domain: domainOf(r.url),
    }));
  }

  readLaterStatus(urls) {
    const set = new Set(
      queryAll(this.db, 'SELECT url FROM read_later WHERE done_at IS NULL').map((r) => r.url)
    );
    return urls.map((u) => set.has(u));
  }

  // -------- full text index --------
  setPageText(url, content) {
    this.db.run(
      `INSERT INTO page_text(url, content, indexed_at) VALUES(?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET content = excluded.content, indexed_at = excluded.indexed_at`,
      [url, String(content || '').slice(0, 20000), Date.now()]
    );
    this._scheduleSave();
  }

  getPageText(url) {
    const rows = queryAll(this.db, 'SELECT content, indexed_at FROM page_text WHERE url = ?', [url]);
    if (!rows.length || !rows[0].content) return null;
    return { content: rows[0].content, indexedAt: Number(rows[0].indexed_at) };
  }

  urlsNeedingText(limit = 4) {
    return queryAll(
      this.db,
      `SELECT v.url, v.title, MAX(v.visit_time) AS t
         FROM visits v
         LEFT JOIN page_text p ON p.url = v.url
        WHERE p.url IS NULL AND v.url LIKE 'http%'
        GROUP BY v.url
        ORDER BY t DESC
        LIMIT ?`,
      [limit]
    ).map((r) => ({ url: r.url, title: r.title }));
  }

  // -------- website thumbnails --------
  setThumb(url, file, failed = false) {
    this.db.run(
      `INSERT INTO thumbs(url, file, captured_at, failed) VALUES(?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET file = excluded.file, captured_at = excluded.captured_at, failed = excluded.failed`,
      [url, file || null, Date.now(), failed ? 1 : 0]
    );
    this._scheduleSave();
  }

  urlsNeedingThumb(limit = 2) {
    return queryAll(
      this.db,
      `SELECT v.url, MAX(v.visit_time) AS t
         FROM visits v
         LEFT JOIN thumbs th ON th.url = v.url
        WHERE th.url IS NULL AND v.url LIKE 'http%'
        GROUP BY v.url
        ORDER BY t DESC
        LIMIT ?`,
      [limit]
    ).map((r) => r.url);
  }

  textIndexCount() {
    return Number(queryAll(this.db, 'SELECT COUNT(*) AS c FROM page_text')[0].c);
  }

  // URLs visited in [fromMs, toMs) — for session restore.
  sessionUrls(fromMs, toMs, browser = null) {
    const params = [fromMs, toMs];
    let where = 'visit_time >= ? AND visit_time < ? AND (hidden IS NULL OR hidden = 0)';
    if (browser) {
      where += ' AND browser = ?';
      params.push(browser);
    }
    const rows = queryAll(
      this.db,
      `SELECT url, title, MAX(visit_time) AS t FROM visits
        WHERE ${where}
        GROUP BY url
        ORDER BY t ASC`,
      params
    );
    return rows.map((r) => ({ url: r.url, title: r.title }));
  }

  // Aggregated stats over [fromMs, toMs) for weekly/period reports.
  rangeStats(fromMs, toMs, browser = null) {
    const params = [fromMs, toMs];
    let where = `visit_time >= ? AND visit_time < ? AND url LIKE 'http%' AND (hidden IS NULL OR hidden = 0)`;
    if (browser) {
      where += ' AND browser = ?';
      params.push(browser);
    }
    const rows = queryAll(
      this.db,
      `SELECT url, title, visit_time, domain FROM visits
        WHERE ${where}
        ORDER BY visit_time ASC`,
      params
    );
    const byDay = new Map();
    const byDomain = new Map();
    const byUrl = new Map();
    for (const r of rows) {
      const day = dayKey(Number(r.visit_time));
      byDay.set(day, (byDay.get(day) || 0) + 1);
      const d = r.domain || '(其他)';
      byDomain.set(d, (byDomain.get(d) || 0) + 1);
      const u = byUrl.get(r.url) || { url: r.url, title: r.title, count: 0 };
      u.count += 1;
      byUrl.set(r.url, u);
    }
    return {
      totalVisits: rows.length,
      distinctUrls: byUrl.size,
      distinctDomains: byDomain.size,
      days: Array.from(byDay.entries()).map(([day, count]) => ({ day, count })),
      topDomains: Array.from(byDomain.entries())
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([domain, count]) => ({ domain, count })),
      topPages: Array.from(byUrl.values())
        .sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  // Frequently revisited (last N days), not yet bookmarked / read-later.
  revisitInsights(days = 7, minVisits = 3, limit = 8) {
    const since = Date.now() - days * 86400000;
    const rows = queryAll(
      this.db,
      `SELECT v.url, v.title, COUNT(*) AS n, MAX(v.visit_time) AS t, m.favicon, m.summary
         FROM visits v
         LEFT JOIN site_meta m ON m.url = v.url
        WHERE v.visit_time >= ? AND v.url LIKE 'http%' AND (v.hidden IS NULL OR v.hidden = 0)
          AND v.url NOT IN (SELECT url FROM bookmarks)
          AND v.url NOT IN (SELECT url FROM read_later)
        GROUP BY v.url
       HAVING n >= ?
        ORDER BY n DESC
        LIMIT ?`,
      [since, minVisits, limit]
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      visits: Number(r.n),
      lastVisit: Number(r.t),
      favicon: r.favicon || null,
      summary: r.summary || null,
      domain: domainOf(r.url),
    }));
  }

  addBookmark(url, title, note = '') {
    this.db.run(
      `INSERT INTO bookmarks(url, title, note, created_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET title = excluded.title, note = excluded.note`,
      [url, title || url, note, Date.now()]
    );
    this._scheduleSave();
  }

  removeBookmark(url) {
    this.db.run('DELETE FROM bookmarks WHERE url = ?', [url]);
    this._scheduleSave();
  }

  listBookmarks() {
    const rows = queryAll(
      this.db,
      `SELECT b.url, b.title, b.note, b.created_at, b.folder, c.category, c.tags,
              m.favicon, m.summary, m.description, th.file AS thumb
         FROM bookmarks b
         LEFT JOIN categories c ON c.url = b.url
         LEFT JOIN site_meta m ON m.url = b.url
         LEFT JOIN thumbs th ON th.url = b.url AND th.failed = 0
        ORDER BY b.created_at DESC`
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      note: r.note,
      createdAt: Number(r.created_at),
      folder: r.folder || null,
      category: r.category || null,
      tags: r.tags ? JSON.parse(r.tags) : [],
      favicon: r.favicon || null,
      summary: r.summary || null,
      description: r.description || null,
      thumb: r.thumb || null,
      domain: domainOf(r.url),
    }));
  }

  // ---- bookmark folders ----------------------------------------------------
  // Folder names are '/'-separated paths (书签栏/前端), which form the tree.
  listBookmarkFolders() {
    const folders = queryAll(
      this.db,
      'SELECT name FROM bookmark_folders ORDER BY position, created_at'
    ).map((r) => r.name);
    const counts = new Map(
      queryAll(this.db, `SELECT COALESCE(folder, '') AS f, COUNT(*) AS n FROM bookmarks GROUP BY f`)
        .map((r) => [r.f, Number(r.n)])
    );
    // Folders that only exist on bookmark rows (e.g. imported) are included too.
    for (const f of counts.keys()) if (f && !folders.includes(f)) folders.push(f);
    // Every ancestor path must exist so the tree renders completely.
    const set = new Set(folders);
    for (const f of [...set]) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    const ordered = folders.concat([...set].filter((f) => !folders.includes(f)));
    return {
      folders: ordered.map((name) => ({ name, count: counts.get(name) || 0 })),
      uncategorized: counts.get('') || 0,
    };
  }

  createBookmarkFolder(name) {
    const n = String(name || '').trim().replace(/^\/+|\/+$/g, '');
    if (!n) return false;
    const max = queryAll(this.db, 'SELECT COALESCE(MAX(position), 0) AS p FROM bookmark_folders')[0].p;
    this.db.run(
      'INSERT INTO bookmark_folders(name, created_at, position) VALUES(?, ?, ?) ON CONFLICT(name) DO NOTHING',
      [n, Date.now(), Number(max) + 1]
    );
    this._scheduleSave();
    return true;
  }

  // Renames/moves a folder subtree: all descendant folders and their bookmarks
  // get the new path prefix.
  renameBookmarkFolder(oldName, newName) {
    const n = String(newName || '').trim().replace(/^\/+|\/+$/g, '');
    if (!n || n === oldName) return false;
    if (n.startsWith(oldName + '/')) return false; // cannot move into own subtree
    this.createBookmarkFolder(n);
    const rows = queryAll(
      this.db,
      `SELECT name FROM bookmark_folders WHERE name = ? OR name LIKE ?`,
      [oldName, oldName + '/%']
    );
    for (const r of rows) {
      const renamed = n + r.name.slice(oldName.length);
      this.db.run('UPDATE OR REPLACE bookmark_folders SET name = ? WHERE name = ?', [renamed, r.name]);
    }
    // Bookmarks can reference folders that only exist on their rows (imports).
    this.db.run('UPDATE bookmarks SET folder = ? WHERE folder = ?', [n, oldName]);
    this.db.run(
      `UPDATE bookmarks SET folder = ? || substr(folder, ?) WHERE folder LIKE ?`,
      [n, oldName.length + 1, oldName + '/%']
    );
    this._scheduleSave();
    return true;
  }

  // Deleting a folder subtree keeps its bookmarks (they become uncategorized).
  deleteBookmarkFolder(name) {
    this.db.run('DELETE FROM bookmark_folders WHERE name = ? OR name LIKE ?', [name, name + '/%']);
    this.db.run('UPDATE bookmarks SET folder = NULL WHERE folder = ? OR folder LIKE ?', [name, name + '/%']);
    this._scheduleSave();
  }

  // Reorder `name` so it sits before/after `target` (position is global; the
  // sidebar groups siblings, so relative order among siblings is what matters).
  reorderBookmarkFolder(name, target, after = true) {
    this.createBookmarkFolder(name); // import-only folders may lack a row
    if (target) this.createBookmarkFolder(target);
    const all = queryAll(this.db, 'SELECT name FROM bookmark_folders ORDER BY position, created_at').map((r) => r.name);
    const rest = all.filter((f) => f !== name);
    let idx = rest.indexOf(target);
    if (idx === -1) idx = rest.length - 1;
    rest.splice(idx + (after ? 1 : 0), 0, name);
    rest.forEach((f, i) => this.db.run('UPDATE bookmark_folders SET position = ? WHERE name = ?', [i + 1, f]));
    this._scheduleSave();
    return true;
  }

  // ---- bookmark offline archive --------------------------------------------
  setBookmarkContent(url, content) {
    this.db.run(
      `INSERT INTO bookmark_content(url, content, archived_at) VALUES(?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET content = excluded.content, archived_at = excluded.archived_at`,
      [url, String(content || ''), Date.now()]
    );
    this._scheduleSave();
  }

  getBookmarkContent(url) {
    const rows = queryAll(this.db, 'SELECT content, archived_at FROM bookmark_content WHERE url = ?', [url]);
    return rows.length ? { content: rows[0].content, archivedAt: Number(rows[0].archived_at) } : null;
  }

  // Bookmarks that still lack an offline copy.
  urlsNeedingArchive(limit = 5) {
    return queryAll(
      this.db,
      `SELECT b.url, b.title FROM bookmarks b
        WHERE b.url LIKE 'http%'
          AND b.url NOT IN (SELECT url FROM bookmark_content)
        ORDER BY b.created_at DESC LIMIT ?`,
      [limit]
    );
  }

  // Full-text search across bookmark titles/urls/tags/summaries AND the
  // offline archived content. Returns matching urls with a snippet.
  searchBookmarkContent(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const rows = queryAll(
      this.db,
      `SELECT b.url, b.title, c.tags, m.summary, m.description, bc.content
         FROM bookmarks b
         LEFT JOIN categories c ON c.url = b.url
         LEFT JOIN site_meta m ON m.url = b.url
         LEFT JOIN bookmark_content bc ON bc.url = b.url`
    );
    const out = [];
    for (const r of rows) {
      const head = `${r.title || ''} ${r.url} ${r.tags || ''} ${r.summary || ''} ${r.description || ''}`.toLowerCase();
      const body = (r.content || '').toLowerCase();
      if (!terms.every((t) => head.includes(t) || body.includes(t))) continue;
      let snippet = null;
      const pos = body.indexOf(terms[0]);
      if (pos >= 0) snippet = (r.content || '').slice(Math.max(0, pos - 40), pos + 80).replace(/\s+/g, ' ').trim();
      out.push({ url: r.url, snippet });
    }
    return out;
  }

  // Merge native browser bookmarks. Existing entries keep their note/folder.
  importBookmarks(items) {
    let imported = 0;
    for (const it of items || []) {
      if (!it.url || !/^https?:/i.test(it.url)) continue;
      this.db.run(
        `INSERT INTO bookmarks(url, title, note, created_at, folder) VALUES(?, ?, '', ?, ?)
         ON CONFLICT(url) DO NOTHING`,
        [it.url, it.title || it.url, Date.now(), it.folder || null]
      );
      imported += this.db.getRowsModified();
      if (it.folder) this.createBookmarkFolder(it.folder);
    }
    this._scheduleSave();
    return imported;
  }

  // Top visited pages of a given local day (for "memory lane").
  dayHighlights(day, limit = 3) {
    const dayStart = new Date(`${day}T00:00:00`).getTime();
    const rows = queryAll(
      this.db,
      `SELECT v.url, v.title, COUNT(*) AS n, m.favicon
         FROM visits v
         LEFT JOIN site_meta m ON m.url = v.url
        WHERE v.visit_time >= ? AND v.visit_time < ? AND ${NOT_HIDDEN}
          AND v.url LIKE 'http%'
        GROUP BY v.url
        ORDER BY n DESC, MAX(v.visit_time) DESC
        LIMIT ?`,
      [dayStart, dayStart + 86400000, limit]
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      count: Number(r.n),
      favicon: r.favicon || null,
      domain: domainOf(r.url),
    }));
  }

  // Bookmarks not visited in `days` (or never) — the "dust collectors".
  staleBookmarks(days = 90, limit = 8) {
    const cutoff = Date.now() - days * 86400000;
    const rows = queryAll(
      this.db,
      `SELECT * FROM (
         SELECT b.url, b.title, b.folder, b.created_at,
                (SELECT MAX(v.visit_time) FROM visits v WHERE v.url = b.url) AS last_visit
           FROM bookmarks b
       ) WHERE last_visit IS NULL OR last_visit < ?
        ORDER BY COALESCE(last_visit, created_at) ASC
        LIMIT ?`,
      [cutoff, limit]
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      folder: r.folder || null,
      createdAt: Number(r.created_at),
      lastVisit: r.last_visit ? Number(r.last_visit) : null,
      domain: domainOf(r.url),
    }));
  }

  setBookmarkFolder(url, folder) {
    const f = folder ? String(folder).trim() : null;
    if (f) this.createBookmarkFolder(f);
    this.db.run('UPDATE bookmarks SET folder = ? WHERE url = ?', [f, url]);
    this._scheduleSave();
  }

  setBookmarkNote(url, note) {
    this.db.run('UPDATE bookmarks SET note = ? WHERE url = ?', [String(note || ''), url]);
    this._scheduleSave();
  }

  // Related bookmarks by shared AI keywords/tags, domain and folder.
  relatedBookmarks(url, limit = 8) {
    const rows = queryAll(
      this.db,
      `SELECT b.url, b.title, b.folder, m.keywords, m.summary, c.tags
         FROM bookmarks b
         LEFT JOIN site_meta m ON m.url = b.url
         LEFT JOIN categories c ON c.url = b.url`
    );
    const parse = (s) => { try { return s ? JSON.parse(s) : []; } catch (e) { return []; } };
    const me = rows.find((r) => r.url === url) || {};
    const meMeta = queryAll(this.db, 'SELECT keywords FROM site_meta WHERE url = ?', [url])[0] || {};
    const meCat = queryAll(this.db, 'SELECT tags FROM categories WHERE url = ?', [url])[0] || {};
    const myKw = new Set(
      [...parse(me.keywords || meMeta.keywords), ...parse(me.tags || meCat.tags)].map((k) => String(k).toLowerCase())
    );
    const myDomain = domainOf(url);
    const myFolder = me.folder || '';
    const scored = [];
    for (const r of rows) {
      if (r.url === url) continue;
      let score = 0;
      for (const k of [...parse(r.keywords), ...parse(r.tags)]) {
        if (myKw.has(String(k).toLowerCase())) score += 2;
      }
      if (domainOf(r.url) === myDomain) score += 1;
      if (myFolder && r.folder === myFolder) score += 1;
      if (score > 0) {
        scored.push({
          url: r.url,
          title: r.title || r.url,
          folder: r.folder || '',
          summary: r.summary || '',
          domain: domainOf(r.url),
          score,
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  setCategory(url, category, tags = [], summary = '') {
    this.db.run(
      `INSERT INTO categories(url, category, tags, summary, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET category = excluded.category, tags = excluded.tags,
         summary = excluded.summary, updated_at = excluded.updated_at`,
      [url, category, JSON.stringify(tags || []), summary || '', Date.now()]
    );
    this._scheduleSave();
  }

  listCategories() {
    const rows = queryAll(
      this.db,
      `SELECT c.category, COUNT(*) AS count
         FROM categories c
        WHERE c.category IS NOT NULL AND c.category != ''
        GROUP BY c.category
        ORDER BY count DESC`
    );
    return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
  }

  // Ontology model of browsing behaviour: topics, sites, keywords, time patterns.
  buildOntology(days = 30) {
    const since = Date.now() - days * 86400000;
    const rows = queryAll(
      this.db,
      `SELECT v.url, v.visit_time, v.domain, c.category, m.keywords
         FROM visits v
         LEFT JOIN categories c ON c.url = v.url
         LEFT JOIN site_meta m ON m.url = v.url
        WHERE v.visit_time >= ? AND v.url LIKE 'http%'`,
      [since]
    );
    const topics = new Map();
    const sites = new Map();
    const keywords = new Map();
    const hourDist = new Array(24).fill(0);
    const weekdayDist = new Array(7).fill(0);
    const urls = new Set();
    for (const r of rows) {
      urls.add(r.url);
      const d = new Date(Number(r.visit_time));
      hourDist[d.getHours()] += 1;
      weekdayDist[d.getDay()] += 1;
      const dom = r.domain || '(其他)';
      if (!sites.has(dom)) sites.set(dom, { count: 0, categories: new Set() });
      const s = sites.get(dom);
      s.count += 1;
      let kws = [];
      try { kws = r.keywords ? JSON.parse(r.keywords) : []; } catch (e) { /* ignore */ }
      for (const k of kws) keywords.set(k, (keywords.get(k) || 0) + 1);
      if (r.category) {
        s.categories.add(r.category);
        if (!topics.has(r.category)) topics.set(r.category, { count: 0, domains: new Set(), keywords: new Map() });
        const t = topics.get(r.category);
        t.count += 1;
        t.domains.add(dom);
        for (const k of kws) t.keywords.set(k, (t.keywords.get(k) || 0) + 1);
      }
    }
    const topEntries = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      periodDays: days,
      totalVisits: rows.length,
      distinctUrls: urls.size,
      topics: Array.from(topics.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 12)
        .map(([name, t]) => ({
          name,
          visits: t.count,
          sites: Array.from(t.domains).slice(0, 6),
          keywords: topEntries(t.keywords, 8).map(([k]) => k),
        })),
      sites: Array.from(sites.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 15)
        .map(([domain, s]) => ({ domain, visits: s.count, topics: Array.from(s.categories) })),
      keywords: topEntries(keywords, 30).map(([keyword, count]) => ({ keyword, count })),
      activeHours: hourDist
        .map((n, h) => ({ h, n }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 5)
        .map((x) => x.h),
      activeWeekdays: weekdayDist
        .map((n, i) => ({ i, n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 3)
        .map((x) => x.i),
    };
  }

  // -------- noise cleanup (search results / auth / redirect pages) --------
  // Returns visit ids+urls that look like transient noise.
  _noiseIds() {
    // SQL LIKE prefilter keeps huge histories out of JS memory; the regexes
    // then verify the smaller candidate set.
    const likes = [
      '%?q=%', '%&q=%', '%query=%', '%search_query=%', '%?wd=%', '%&wd=%', '%?kw=%', '%&kw=%',
      '%/search%', '%/login%', '%/signin%', '%/sign-in%', '%/logout%', '%/signup%', '%/sign-up%',
      '%/auth%', '%/oauth%', '%/sso%', '%/callback%', '%/redirect%',
      '%accounts.google.com%', '%account.google.com%', '%login.microsoftonline.com%',
    ];
    const cond = likes.map(() => 'url LIKE ?').join(' OR ');
    const rows = queryAll(
      this.db,
      `SELECT id, url FROM visits WHERE (hidden IS NULL OR hidden = 0) AND (${cond})`,
      likes
    );
    return rows.filter((r) => NOISE_URL_RE.some((re) => re.test(r.url))).map((r) => r.id);
  }

  noiseCount() {
    return this._noiseIds().length;
  }

  // Hide (not delete) noise visits; reversible via restoreNoise().
  purgeNoise() {
    const ids = this._noiseIds();
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      this.db.run(`UPDATE visits SET hidden = 1 WHERE id IN (${slice.join(',')})`);
    }
    this._scheduleSave();
    return ids.length;
  }

  restoreNoise() {
    this.db.run('UPDATE visits SET hidden = 0 WHERE hidden = 1');
    const n = this.db.getRowsModified();
    this._scheduleSave();
    return n;
  }

  // -------- referrer path chain (how did I get to this page) ---------------
  pathChain(url, maxHops = 10) {
    const chain = [];
    let cur = url;
    const seen = new Set();
    for (let hop = 0; hop <= maxHops && cur && !seen.has(cur); hop++) {
      seen.add(cur);
      const rows = queryAll(
        this.db,
        `SELECT url, title, visit_time, from_url, domain FROM visits
          WHERE url = ? ORDER BY visit_time DESC LIMIT 1`,
        [cur]
      );
      if (!rows.length) break;
      const r = rows[0];
      chain.push({
        url: r.url,
        title: r.title,
        visitTime: Number(r.visit_time),
        domain: r.domain,
      });
      cur = r.from_url || null;
    }
    return chain;
  }

  // -------- stale unread (read-later backlog) ------------------------------
  staleUnread(days = 7) {
    const cutoff = Date.now() - days * 86400000;
    return this.listReadLater(false).filter((r) => r.addedAt && r.addedAt < cutoff);
  }

  // -------- estimated per-domain dwell time over a range --------------------
  domainDwell(fromMs, toMs, browser = null) {
    const params = [fromMs, toMs];
    let where = `visit_time >= ? AND visit_time < ? AND url LIKE 'http%' AND (hidden IS NULL OR hidden = 0)`;
    if (browser) {
      where += ' AND browser = ?';
      params.push(browser);
    }
    const rows = queryAll(
      this.db,
      `SELECT url, domain, visit_time, browser, profile FROM visits
        WHERE ${where}
        ORDER BY browser, profile, visit_time ASC`,
      params
    );
    const byDomain = new Map();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const next = rows[i + 1];
      let dwell = DWELL_DEFAULT_MS;
      if (next && next.browser === r.browser && next.profile === r.profile) {
        const gap = Number(next.visit_time) - Number(r.visit_time);
        if (gap > 0 && gap <= DWELL_CAP_MS) dwell = gap;
      }
      const d = r.domain || '(其他)';
      const cur = byDomain.get(d) || { domain: d, dwellMs: 0, visits: 0 };
      cur.dwellMs += dwell;
      cur.visits += 1;
      byDomain.set(d, cur);
    }
    return Array.from(byDomain.values()).sort((a, b) => b.dwellMs - a.dwellMs);
  }

  stats() {
    const total = queryAll(this.db, 'SELECT COUNT(*) AS c FROM visits')[0].c;
    const distinct = queryAll(this.db, 'SELECT COUNT(DISTINCT url) AS c FROM visits')[0].c;
    const bookmarks = queryAll(this.db, 'SELECT COUNT(*) AS c FROM bookmarks')[0].c;
    return { totalVisits: Number(total), distinctUrls: Number(distinct), bookmarks: Number(bookmarks) };
  }
}

const NOT_HIDDEN = '(v.hidden IS NULL OR v.hidden = 0)';

// URL patterns considered "noise": search result pages, auth flows, redirects.
const NOISE_URL_RE = [
  /[?&](q|query|search_query|wd|kw)=/i,
  /\/(search|login|signin|sign-in|logout|signup|sign-up|auth|oauth|sso|callback|redirect)([/?#]|$)/i,
  /accounts?\.google\.com|login\.microsoftonline\.com/i,
];

// Dwell estimation: gap to the next visit in the same browser+profile,
// capped (a huge gap means the user left, not read for hours).
const DWELL_CAP_MS = 30 * 60000;
const DWELL_DEFAULT_MS = 15000; // last visit of a burst: assume a short skim
const ENGAGED_MS = 45000; // >= 45s counts as "actually read"

// Mutates items (sorted any order) adding dwellMs + engaged flags.
function attachDwell(items) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.browser}|${it.profile}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.visitTime - b.visitTime);
    for (let i = 0; i < list.length; i++) {
      const next = list[i + 1];
      let dwell = DWELL_DEFAULT_MS;
      if (next) {
        const gap = next.visitTime - list[i].visitTime;
        if (gap > 0 && gap <= DWELL_CAP_MS) dwell = gap;
      }
      list[i].dwellMs = dwell;
      list[i].engaged = dwell >= ENGAGED_MS;
    }
  }
  return items;
}

const SELECT_ITEMS = `SELECT v.url, v.title, v.visit_time, v.browser, v.browser_name, v.profile, v.domain, v.from_url,
              c.category, c.tags,
              m.favicon, m.description, m.summary, m.keywords,
              th.file AS thumb,
              (SELECT 1 FROM bookmarks b WHERE b.url = v.url) AS bookmarked,
              (SELECT 1 FROM read_later r WHERE r.url = v.url AND r.done_at IS NULL) AS read_later
         FROM visits v
         LEFT JOIN categories c ON c.url = v.url
         LEFT JOIN site_meta m ON m.url = v.url
         LEFT JOIN thumbs th ON th.url = v.url AND th.failed = 0`;

function rowToItem(r) {
  return {
    url: r.url,
    title: r.title,
    visitTime: Number(r.visit_time),
    browser: r.browser,
    browserName: r.browser_name,
    profile: r.profile,
    domain: r.domain,
    fromUrl: r.from_url || null,
    category: r.category || null,
    tags: r.tags ? JSON.parse(r.tags) : [],
    bookmarked: !!r.bookmarked,
    readLater: !!r.read_later,
    favicon: r.favicon || null,
    thumb: r.thumb || null,
    description: r.description || null,
    summary: r.summary || null,
    keywords: r.keywords ? JSON.parse(r.keywords) : [],
  };
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function syncCursorKey(browser, profile) {
  return `syncCursor:${JSON.stringify([String(browser || ''), String(profile || '')])}`;
}

// Local-time day key YYYY-MM-DD.
function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { Store, domainOf, dayKey, NOISE_URL_RE };
