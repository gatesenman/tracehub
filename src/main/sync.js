'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { detectBrowsers, readProfileVisits } = require('./browsers');
const { resolveHistoryWorkerPath } = require('./paths');

// Continuously pulls new visits from all browsers into the unified store.
// "Real-time" is achieved by watching each history file for changes plus a
// periodic poll fallback (browser history DBs are file-locked & written in
// bursts, so watch + debounce + poll is the robust approach).
class SyncEngine {
  constructor(store, { backfillOverlapMs = 7 * 86400000, maxPagesPerSync = 50, readOptions = {}, intervalMs = 10000, onUpdate = () => {}, getBlacklist = () => [], getPausedRanges = () => [], getEnabledProfiles = () => null, isSyncAllowed = () => true } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.backfillOverlapMs = backfillOverlapMs;
    this.maxPagesPerSync = maxPagesPerSync;
    this.readOptions = readOptions;
    this.onUpdate = onUpdate;
    this.getBlacklist = getBlacklist;
    this.getPausedRanges = getPausedRanges;
    this.getEnabledProfiles = getEnabledProfiles;
    this.isSyncAllowed = isSyncAllowed;
    this.browsers = [];
    this.watchers = [];
    this.timer = null;
    this.running = false;
    this._syncing = false;
    this._debounce = null;
    this._worker = null;
    this._workerJobs = new Map();
    this._workerSeq = 0;
    this._workerBroken = false;
    this.workerError = null;
    this.lastErrors = [];
  }

  // History files can be hundreds of MB; parse them in a worker thread so the
  // UI/main process never stalls. If the worker cannot start or dies (e.g. a
  // packaging mistake makes its require() fail), fall back to in-process
  // reading for good instead of failing every profile silently.
  // Resolves to { items, cursor, hasMore } (see browsers.readProfileVisits).
  _readVisits(browser, profile, cursor) {
    if (this._workerBroken) return readProfileVisits(browser, profile, cursor, this.readOptions);
    if (!this._worker) {
      try {
        this._worker = this._createWorker();
        this._worker.on('message', (msg) => {
          const job = this._workerJobs.get(msg.id);
          if (!job) return;
          this._workerJobs.delete(msg.id);
          if (msg.error) job.reject(new Error(msg.error));
          else job.resolve(msg.page);
        });
        this._worker.on('error', (err) => this._onWorkerFailure(err));
        this._worker.on('exit', (code) => {
          if (this._workerJobs.size) this._onWorkerFailure(new Error(`history worker exited (${code})`));
        });
        if (typeof this._worker.unref === 'function') this._worker.unref();
      } catch (e) {
        this._onWorkerFailure(e);
        return readProfileVisits(browser, profile, cursor, this.readOptions);
      }
    }
    const id = ++this._workerSeq;
    return new Promise((resolve, reject) => {
      this._workerJobs.set(id, { resolve, reject, browser, profile, cursor });
      this._worker.postMessage({
        id,
        cursor,
        options: this.readOptions,
        browser: { id: browser.id, name: browser.name, engine: browser.engine },
        profile: { profile: profile.profile, historyPath: profile.historyPath },
      });
    });
  }

  _createWorker() {
    return new Worker(resolveHistoryWorkerPath());
  }

  // The worker itself is broken (load error, crash): remember why, read the
  // pending jobs in-process, and stop using the worker.
  _onWorkerFailure(err) {
    const reason = String((err && err.message) || err);
    if (!this._workerBroken) console.error('history worker unavailable, reading in-process:', reason);
    this._workerBroken = true;
    this.workerError = reason;
    const jobs = [...this._workerJobs.values()];
    this._workerJobs.clear();
    const w = this._worker;
    this._worker = null;
    if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
    for (const job of jobs) {
      Promise.resolve()
        .then(() => readProfileVisits(job.browser, job.profile, job.cursor, this.readOptions))
        .then(job.resolve, job.reject);
    }
  }

  async start() {
    this.browsers = detectBrowsers();
    this.running = true;
    await this.syncOnce(true);
    this._setupWatchers();
    this.timer = setInterval(() => this.syncOnce(false), this.intervalMs);
    // Periodically re-detect browsers/profiles (new profile created, browser
    // installed, history file replaced) and re-arm the watchers.
    this.redetectTimer = setInterval(() => {
      if (!this.running) return;
      this.browsers = detectBrowsers();
      for (const w of this.watchers) {
        try { w.close(); } catch (e) { /* ignore */ }
      }
      this.watchers = [];
      this._setupWatchers();
    }, 5 * 60000);
    return this.browsers;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.redetectTimer) clearInterval(this.redetectTimer);
    this.redetectTimer = null;
    for (const w of this.watchers) {
      try { w.close(); } catch (e) { /* ignore */ }
    }
    this.watchers = [];
    if (this._worker) {
      try { this._worker.terminate(); } catch (e) { /* ignore */ }
      this._worker = null;
    }
  }

  _setupWatchers() {
    // Watch the profile DIRECTORY, not the History file itself: browsers write
    // through journal/WAL side files (History-journal, places.sqlite-wal) and
    // sometimes replace the db file, which silently kills a file watcher.
    // Directory watching sees all of that, so new visits land within ~1s.
    const dirs = new Map(); // dir -> Set of basenames to react to
    for (const browser of this.browsers) {
      for (const profile of browser.profiles) {
        const dir = path.dirname(profile.historyPath);
        if (!dirs.has(dir)) dirs.set(dir, new Set());
        dirs.get(dir).add(path.basename(profile.historyPath));
      }
    }
    for (const [dir, bases] of dirs) {
      try {
        const watcher = fs.watch(dir, (_ev, file) => {
          if (!file) return this._debouncedSync();
          const f = String(file);
          for (const base of bases) {
            if (f === base || f.startsWith(base + '-')) return this._debouncedSync();
          }
        });
        this.watchers.push(watcher);
      } catch (e) {
        // Some platforms disallow watching; poll covers this.
      }
    }
  }

  // Live-apply a new poll interval (from settings) without a restart.
  setIntervalMs(ms) {
    const v = Math.max(1000, Number(ms) || this.intervalMs);
    if (v === this.intervalMs) return;
    this.intervalMs = v;
    if (this.timer) clearInterval(this.timer);
    if (this.running) this.timer = setInterval(() => this.syncOnce(false), this.intervalMs);
  }

  _debouncedSync() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.syncOnce(false), 300);
  }

  // Pull incremental visits from every profile and merge into the store.
  _profileAllowed(browserId, profileName) {
    if (this.isSyncAllowed && !this.isSyncAllowed()) return false;
    const list = this.getEnabledProfiles ? this.getEnabledProfiles() : null;
    if (!list) return profileName !== 'Guest Profile';
    return list.some((x) => x.browserId === browserId && x.profile === profileName);
  }

  // Drop blacklisted domains and visits inside privacy-pause windows, even if
  // they only get synced much later.
  _filterItems(items) {
    const blacklist = (this.getBlacklist() || []).map((d) => String(d).toLowerCase());
    if (blacklist.length) {
      items = items.filter((it) => {
        try {
          const host = new URL(it.url).hostname.toLowerCase();
          return !blacklist.some((d) => host === d || host.endsWith('.' + d));
        } catch (e) {
          return true;
        }
      });
    }
    const pauses = this.getPausedRanges() || [];
    if (pauses.length) {
      items = items.filter(
        (it) => !pauses.some((p) => it.visitTime >= p.from && it.visitTime < p.to)
      );
    }
    return items;
  }

  // Import every visit the browser recorded since this profile's cursor,
  // including visits made while TraceHub was not running. The cursor lives in
  // the store and only advances after the page has been written, so a crash
  // re-reads (and dedupes) instead of skipping. Without a cursor (first run,
  // or upgrading from <=1.2.8 which kept none) start a little before the
  // newest stored visit, or from the beginning of the browser's history.
  async _syncProfile(browser, profile) {
    let cursor = this.store.getSyncCursor
      ? this.store.getSyncCursor(browser.id, profile.profile)
      : null;
    if (!cursor) {
      const latest = this.store.latestVisitTime(browser.id, profile.profile);
      cursor = { visitId: null, visitTime: latest > 0 ? Math.max(0, latest - this.backfillOverlapMs) : 0 };
    }
    let inserted = 0;
    for (let page = 0; page < this.maxPagesPerSync; page++) {
      const res = await this._readVisits(browser, profile, cursor);
      inserted += this.store.upsertVisits(this._filterItems(res.items || []));
      cursor = res.cursor;
      if (this.store.setSyncCursor) this.store.setSyncCursor(browser.id, profile.profile, cursor);
      if (!res.hasMore) break;
    }
    return inserted;
  }

  // full is kept for callers; every sync now backfills from the cursor.
  async syncOnce(full) {
    if (this._syncing || !this.running) return { inserted: 0 };
    if (this.isSyncAllowed && !this.isSyncAllowed()) return { inserted: 0, skipped: 'onboarding' };
    this._syncing = true;
    let inserted = 0;
    const errors = [];
    try {
      for (const browser of this.browsers) {
        for (const profile of browser.profiles) {
          if (!this._profileAllowed(browser.id, profile.profile)) continue;
          try {
            inserted += await this._syncProfile(browser, profile);
          } catch (e) {
            errors.push({ browser: browser.id, profile: profile.profile, error: String(e.message || e) });
          }
        }
      }
    } finally {
      this._syncing = false;
    }
    this.lastErrors = errors;
    if (errors.length) console.error('history sync errors:', JSON.stringify(errors));
    if (inserted > 0) {
      this.onUpdate({ inserted, errors });
    }
    return { inserted, errors };
  }
}

module.exports = { SyncEngine };
