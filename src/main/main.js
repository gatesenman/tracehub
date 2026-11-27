'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, globalShortcut, Notification, clipboard } = require('electron');
const { parseLaunchFlags } = require('./cli-flags');
const { runSelfTest, writeReport, defaultReportPath, defaultSelfTestUserData } = require('./self-test');

const { Store, NOISE_URL_RE } = require('./store');
const { Config } = require('./config');
const { SyncEngine } = require('./sync');
const { Enricher } = require('./enricher');
const { detectBrowsers, readAllBookmarks } = require('./browsers');
const { fetchSiteMeta, fetchReadableContent, fetchLocalText, faviconFor } = require('./metadata');
const { ThumbWorker } = require('./thumbs');
const ai = require('./ai');
const { startBridge, registerSnapshotIpc } = require('./snapshot-service');
const { isSqliteFile, restoreDatabase } = require('./backup');
const { openHttpUrlList } = require('../shared/open-urls');
const { domainOf } = require('./store');

// The thumbnail worker renders pages in an offscreen window; offscreen
// rendering is only reliable with hardware acceleration off (with it on, the
// GPU process can crash and take the whole app down, especially on Windows).
app.disableHardwareAcceleration();

// Isolated userData must be applied before the single-instance lock so a
// self-test never attaches to the user's real profile. --user-data-dir may
// be dropped by a portable wrapper; TRACEHUB_USER_DATA is the fallback.
const launchFlags = parseLaunchFlags(process.argv, process.env);
if (launchFlags.selfTest && !launchFlags.userData) {
  launchFlags.userData = defaultSelfTestUserData();
}
if (launchFlags.userData) {
  fs.mkdirSync(launchFlags.userData, { recursive: true });
  process.env.TRACEHUB_USER_DATA = launchFlags.userData;
  app.setPath('userData', launchFlags.userData);
}
if (launchFlags.selfTest) {
  process.env.TRACEHUB_SELFTEST = '1';
  process.env.TRACEHUB_DISABLE_SYNC = '1';
}
if (launchFlags.disableSync) process.env.TRACEHUB_DISABLE_SYNC = '1';
if (launchFlags.reportPath) process.env.TRACEHUB_SELFTEST_REPORT = launchFlags.reportPath;

// Never let an unexpected async error kill the app.
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

const APP_TITLE = '拾迹 TraceHub';

// Only ever run one instance: launching the app again (e.g. from the Start
// menu while it sits in the tray) focuses the existing window instead of
// starting a second process fighting over the same database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

let mainWindow = null;
let store = null;
let config = null;
let sync = null;
let enricher = null;
let thumbs = null;
let tray = null;
let quitting = false;
let tabBridge = null;

function createWindow(hidden = false) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: !hidden,
    title: APP_TITLE,
    backgroundColor: '#0f1115',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  // Coming back to the app is the moment fresh data matters most — but
  // throttled, so rapidly showing/hiding the window doesn't pile up syncs.
  let lastFocusSync = 0;
  mainWindow.on('focus', () => {
    if (!sync) return;
    const now = Date.now();
    if (now - lastFocusSync < 20000) return;
    lastFocusSync = now;
    sync.syncOnce(false);
  });
  mainWindow.on('minimize', (e) => {
    if (config.get().minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  if (process.env.BHH_DEBUG) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Closing the window hides to tray (configurable) so global shortcut / sync
  // keep working; when close-to-tray is off, closing quits the app.
  mainWindow.on('close', (e) => {
    if (quitting) return;
    if (config.get().closeToTray !== false) {
      e.preventDefault();
      mainWindow.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });
}

// Register/unregister the app as an OS login item. Only meaningful for the
// packaged app — in dev it would register the bare electron binary.
function applyAutoLaunch() {
  if (!app.isPackaged) return;
  const enabled = !!config.get().autoLaunch;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: ['--hidden'],
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  tray = new Tray(iconPath);
  refreshTrayMenu();
  tray.on('double-click', () => showMainWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const until = privacyPausedUntil();
  const paused = until > Date.now();
  tray.setToolTip(paused ? `${APP_TITLE} · 隐私暂停中（至 ${new Date(until).toLocaleTimeString('zh-CN')}）` : APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '快速搜索 (Alt+Space)', click: () => { showMainWindow(); mainWindow.webContents.send('focus:search'); } },
    { type: 'separator' },
    paused
      ? { label: `恢复记录（暂停至 ${new Date(until).toLocaleTimeString('zh-CN')}）`, click: () => privacyResume() }
      : { label: '隐私暂停 30 分钟', click: () => privacyPause(30) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

// -------- privacy pause: visits inside paused windows are never recorded ----
function privacyPausedUntil() {
  const now = Date.now();
  const pauses = config.get().privacyPauses || [];
  let until = 0;
  for (const p of pauses) {
    if (p.from <= now && p.to > now && p.to > until) until = p.to;
  }
  return until;
}

function privacyPause(minutes) {
  const now = Date.now();
  const m = Math.max(1, Math.min(24 * 60, Number(minutes) || 30));
  // Keep only recent windows so the list never grows unbounded (ranges older
  // than 90 days can no longer affect incremental imports).
  const keep = (config.get().privacyPauses || []).filter((p) => p.to > now - 90 * 86400000);
  keep.push({ from: now, to: now + m * 60000 });
  config.update({ privacyPauses: keep });
  refreshTrayMenu();
  return privacyPausedUntil();
}

function privacyResume() {
  const now = Date.now();
  const pauses = (config.get().privacyPauses || []).map((p) =>
    p.from <= now && p.to > now ? { ...p, to: now } : p
  );
  config.update({ privacyPauses: pauses });
  refreshTrayMenu();
  return 0;
}

// Weekly usage digest as a desktop notification (once per ISO week).
function maybeWeeklyNotify() {
  if (!config.get().weeklyNotify || !Notification.isSupported()) return;
  const now = new Date();
  const weekKey = `${now.getFullYear()}-W${Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 86400000 + 1) / 7)}`;
  if (store.getMeta('weeklyNotifiedAt') === weekKey) return;
  const stats = store.rangeStats(Date.now() - 7 * 86400000, Date.now());
  if (!stats.totalVisits) return;
  const top = stats.topDomains.slice(0, 3).map((t) => t.domain).join('、');
  const n = new Notification({
    title: '本周阅读摘要',
    body: `过去 7 天你浏览了 ${stats.totalVisits} 次、${stats.distinctUrls} 个网页。常去：${top}。点击查看完整报告。`,
  });
  n.on('click', () => { showMainWindow(); mainWindow.webContents.send('open:report'); });
  n.show();
  store.setMeta('weeklyNotifiedAt', weekKey);
}

// ---- bookmark archive pipeline ---------------------------------------------
// Runs after a bookmark is added (and for backfills): fetch metadata, save an
// offline readable copy, let the AI pick a folder/tags/description, and take a
// screenshot. Every step is best-effort so a failure never blocks saving.
async function archiveBookmark(url, title, { autoFile = true } = {}) {
  const result = { url, archived: false, folder: null, tags: [] };
  const cfg = config.get();
  try {
    const meta = await fetchSiteMeta(url);
    store.upsertSiteMeta(url, {
      favicon: meta.favicon || faviconFor(url),
      description: meta.description || null,
      fetchedAt: Date.now(),
      fetchFailed: !meta.ok,
    });

    let content = null;
    if (cfg.reader && cfg.reader.enabled) content = await fetchReadableContent(url, cfg.reader.jinaKey || '');
    if (!content) content = await fetchLocalText(url);
    store.setBookmarkContent(url, content || '');
    if (content) store.setPageText(url, content);
    result.archived = !!content;

    if (autoFile) {
      const folders = store.listBookmarkFolders().folders.map((f) => f.name);
      const m = await ai.aiBookmarkMeta(cfg.ai, {
        url, title, description: meta.description || '', content: content || '',
      }, folders).catch(() => null);
      if (m) {
        if (m.folder) {
          store.setBookmarkFolder(url, m.folder);
          result.folder = m.folder;
        }
        if (m.category || (m.tags && m.tags.length)) {
          store.setCategory(url, m.category || '未分类', m.tags || [], m.description || '');
          result.tags = m.tags || [];
        }
        if (m.description) store.upsertSiteMeta(url, { summary: m.description, enrichedAt: Date.now() });
      }
    }

    if (thumbs) await thumbs.capture(url).catch(() => false);
  } catch (e) { /* best-effort */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bookmark:archived', result);
  }
  return result;
}

function pushUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:updated', store.stats());
  }
}

// The product was renamed (BrowserHistoryHub → TraceHub), which moves the
// userData directory. Carry existing data over so nothing is lost.
function migrateUserData(userData) {
  try {
    if (fs.existsSync(path.join(userData, 'hub.sqlite'))) return;
    const old = path.join(path.dirname(userData), 'BrowserHistoryHub');
    if (old === userData || !fs.existsSync(path.join(old, 'hub.sqlite'))) return;
    fs.mkdirSync(userData, { recursive: true });
    for (const name of ['hub.sqlite', 'config.json']) {
      const src = path.join(old, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userData, name));
    }
    for (const dir of ['thumbs', 'backups']) {
      const src = path.join(old, dir);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(userData, dir), { recursive: true, force: false });
    }
  } catch (e) { console.error('userData migration failed', e); }
}

function onSnapshotSavedFromBridge(saved) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot:updated', saved);
  }
  try { if (typeof pushUpdate === 'function') pushUpdate(); } catch (e) { /* ignore */ }
}

async function startAppBridge() {
  if (tabBridge && typeof tabBridge.stop === 'function') {
    try { await tabBridge.stop(); } catch (e) { console.error('tab bridge stop failed', e); }
    tabBridge = null;
  }
  tabBridge = await startBridge(config, store, { onSnapshotSaved: onSnapshotSavedFromBridge });
  return tabBridge;
}

async function bootstrap() {
  const userData = app.getPath('userData');
  process.env.TRACEHUB_USER_DATA = process.env.TRACEHUB_USER_DATA || userData;
  if (!process.env.TRACEHUB_HISTORY_CACHE) {
    process.env.TRACEHUB_HISTORY_CACHE = path.join(userData, 'history-cache');
  }
  const selfTest = process.env.TRACEHUB_SELFTEST === '1' || process.env.TRACEHUB_SELFTEST === 'true';
  if (!selfTest) migrateUserData(userData);
  config = new Config(path.join(userData, 'config.json'));
  store = new Store(path.join(userData, 'hub.sqlite'));
  await store.init();

  if (selfTest) {
    process.env.TRACEHUB_DISABLE_SYNC = '1';
    const bridgePort = process.env.TRACEHUB_BRIDGE_PORT ? Number(process.env.TRACEHUB_BRIDGE_PORT) : 0;
    config.update({
      bridgeEnabled: true,
      bridgePort,
      thumbsEnabled: false,
      contentFetchEnabled: false,
      enabledProfiles: [],
    });
    try {
      tabBridge = await startBridge(config, store, {});
    } catch (e) {
      console.error('tab bridge start failed', e);
    }
    const reportPath = process.env.TRACEHUB_SELFTEST_REPORT || launchFlags.reportPath || defaultReportPath(userData);
    let report;
    try {
      report = await runSelfTest({
        app,
        store,
        config,
        bridge: tabBridge,
        userData,
        argv: process.argv,
        flags: launchFlags,
        reportPath,
        version: typeof app.getVersion === 'function' ? app.getVersion() : null,
      });
    } catch (e) {
      report = {
        ok: false,
        error: e.message || String(e),
        mode: 'packaged-self-test',
        userData,
        isPackaged: !!(app && app.isPackaged),
        platform: process.platform,
      };
    }
    try { writeReport(report, reportPath); } catch (e) { console.error('failed to write self-test report', e); }
    console.log(report.ok ? 'TRACEHUB_SELFTEST_OK' : 'TRACEHUB_SELFTEST_FAIL');
    console.log('TRACEHUB_SELFTEST_REPORT=' + reportPath);
    try { if (tabBridge) await tabBridge.stop(); } catch (e) { /* ignore */ }
    try { if (store && store.close) store.close(); } catch (e) { /* ignore */ }
    quitting = true;
    app.exit(report.ok ? 0 : 1);
    return;
  }

  const isPausedNow = () => (privacyPausedUntil() > Date.now());
  sync = new SyncEngine(store, {
    intervalMs: config.get().syncIntervalMs || 5000,
    onUpdate: () => pushUpdate(),
    getBlacklist: () => config.get().blacklist || [],
    getPausedRanges: () => config.get().privacyPauses || [],
    getEnabledProfiles: () => config.get().enabledProfiles,
    isSyncAllowed: () => !!config.get().onboardingCompleted && !process.env.TRACEHUB_SMOKE && !process.env.TRACEHUB_DISABLE_SYNC && process.env.TRACEHUB_SELFTEST !== '1' && process.env.TRACEHUB_SELFTEST !== 'true',
  });
  // Start the engine (watchers/timer). Actual imports wait until first-run consent.
  sync.start().then(() => pushUpdate()).catch((e) => console.error('sync start failed', e));

  enricher = new Enricher(store, () => config.get(), {
    onUpdate: () => pushUpdate(),
    isPaused: isPausedNow,
  });
  enricher.start();

  thumbs = new ThumbWorker(store, path.join(userData, 'thumbs'), {
    onUpdate: () => pushUpdate(),
    isEnabled: () => !!config.get().thumbsEnabled,
    isPaused: isPausedNow,
  });
  thumbs.start();

  if (process.env.TRACEHUB_BRIDGE_PORT) {
    config.update({ bridgePort: Number(process.env.TRACEHUB_BRIDGE_PORT) });
  }

  try {
    await startAppBridge();
  } catch (e) {
    console.error('tab bridge start failed', e);
  }

  registerIpc();
  const startHidden = process.argv.includes('--hidden') || !!config.get().startMinimized;
  createWindow(startHidden);
  createTray();
  applyAutoLaunch();
  globalShortcut.register('Alt+Space', () => {
    showMainWindow();
    mainWindow.webContents.send('focus:search');
  });
  setTimeout(() => { try { maybeWeeklyNotify(); } catch (e) { /* ignore */ } }, 15000);
  // Daily automatic backup: shortly after launch, then every 6 hours.
  setTimeout(() => { try { runBackup(false); } catch (e) { /* ignore */ } }, 30000);
  setInterval(() => { try { runBackup(false); } catch (e) { /* ignore */ } }, 6 * 3600000);

  if (process.env.TRACEHUB_SMOKE) {
    setTimeout(() => {
      try { if (tabBridge) tabBridge.stop(); } catch (e) { /* ignore */ }
      console.log('TRACEHUB_SMOKE_OK');
      quitting = true;
      app.exit(0);
    }, 2500);
  }
}

function registerIpc() {
  ipcMain.handle('browsers:detect', async () => detectBrowsers().map((b) => ({
    id: b.id, name: b.name, engine: b.engine, profiles: b.profiles.map((p) => p.profile),
  })));

  ipcMain.handle('sync:now', async () => sync.syncOnce(false));

  ipcMain.handle('sync:catch-up', async () => sync.catchUpFromStart());

  ipcMain.handle('stats:get', async () => store.stats());

  ipcMain.handle('days:list', async () => store.listDays());

  ipcMain.handle('timeline:day', async (_e, { day, browser }) =>
    buildTimeline(store.timelineForDay(day, browser || null)));

  ipcMain.handle('stats:day', async (_e, { day, browser }) => store.statsForDay(day, browser || null));

  ipcMain.handle('search:basic', async (_e, { query, browser, fromMs, toMs, domain }) =>
    dedupeByUrl(store.search(query, 500, browser || null, fromMs || null, toMs || null, domain || null)));

  ipcMain.handle('domain:profile', async (_e, domain) => store.domainProfile(domain));

  ipcMain.handle('search:ai', async (_e, { query, fromMs, toMs, domain }) => {
    const rest = String(query || '').trim();
    let candidates = store.search(rest, 500, null, fromMs || null, toMs || null, domain || null);
    if (!candidates.length) {
      candidates = store.recentDistinct(400);
      if (fromMs) candidates = candidates.filter((c) => c.visitTime >= fromMs);
      if (toMs) candidates = candidates.filter((c) => c.visitTime < toMs);
      if (domain) {
        const d = String(domain).toLowerCase().replace(/^www\./, '');
        candidates = candidates.filter((c) => {
          const host = (c.domain || domainOf(c.url) || '').toLowerCase();
          return host === d || host.endsWith('.' + d);
        });
      }
    }
    return ai.aiSearch(config.get().ai, rest || query, candidates);
  });

  ipcMain.handle('providers:list', async () => ai.PROVIDERS);

  ipcMain.handle('export:data', async (_e, format) => {
    const items = store.exportAll();
    const ext = format === 'csv' ? 'csv' : 'json';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `TraceHub-history-${Date.now()}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) return { saved: false };
    if (ext === 'csv') {
      // Quote + prefix formula-looking values so spreadsheets don't execute them.
      const esc = (s) => {
        let v = String(s == null ? '' : s);
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
        return `"${v.replace(/"/g, '""')}"`;
      };
      const head = 'visit_time,url,title,browser,profile,domain,category,summary,keywords\n';
      const body = items
        .map((i) =>
          [
            new Date(i.visitTime).toISOString(),
            i.url, i.title, i.browserName, i.profile, i.domain,
            i.category || '', i.summary || '', (i.keywords || []).join(' '),
          ].map(esc).join(',')
        )
        .join('\n');
      fs.writeFileSync(filePath, '\ufeff' + head + body, 'utf8');
    } else {
      fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8');
    }
    return { saved: true, filePath, count: items.length };
  });

  ipcMain.handle('organize:run', async (_e, limit) => {
    const items = store.recentDistinct(limit || 120);
    const result = await ai.aiOrganize(config.get().ai, items);
    for (const r of result) {
      store.setCategory(r.url, r.category, r.tags);
    }
    return { organized: result.length, categories: store.listCategories() };
  });

  ipcMain.handle('categories:list', async () => store.listCategories());

  ipcMain.handle('summary:day', async (_e, day) => {
    const items = store.timelineForDay(day);
    return ai.dailySummary(config.get().ai, day, items);
  });

  ipcMain.handle('bookmarks:list', async () => store.listBookmarks());
  ipcMain.handle('bookmarks:add', async (_e, { url, title, note }) => {
    store.addBookmark(url, title, note);
    // Fire the enrichment pipeline in the background — saving stays instant.
    if (/^https?:/i.test(url)) archiveBookmark(url, title).catch(() => {});
    return store.listBookmarks();
  });
  ipcMain.handle('bookmarks:archive', async (_e, { url, title }) => archiveBookmark(url, title, { autoFile: false }));
  ipcMain.handle('bookmarks:archive-missing', async () => {
    const pending = store.urlsNeedingArchive(50);
    let done = 0;
    for (const p of pending) {
      await archiveBookmark(p.url, p.title, { autoFile: false });
      done++;
    }
    return { done };
  });
  ipcMain.handle('bookmarks:content', async (_e, url) => store.getBookmarkContent(url));
  ipcMain.handle('bookmarks:search', async (_e, q) => store.searchBookmarkContent(q));
  ipcMain.handle('bookmarks:folder-reorder', async (_e, { name, target, after }) => {
    store.reorderBookmarkFolder(name, target, after !== false);
    return store.listBookmarkFolders();
  });
  // AI curation: propose which of a day's visits deserve to become bookmarks.
  // Returns suggestions only — nothing is saved until bookmarks:curate-apply.
  ipcMain.handle('bookmarks:curate-day', async (_e, day) => {
    const existing = new Set(store.listBookmarks().map((b) => b.url));
    const candidates = dedupeByUrl(store.timelineForDay(day)).filter(
      (it) =>
        /^https?:/i.test(it.url) &&
        !existing.has(it.url) &&
        !NOISE_URL_RE.some((re) => re.test(it.url))
    );
    const folders = store.listBookmarkFolders().folders.map((f) => f.name);
    const items = await ai.aiCurateDay(config.get().ai, candidates, folders);
    return { candidates: candidates.length, items };
  });
  ipcMain.handle('bookmarks:curate-apply', async (_e, picks) => {
    let added = 0;
    for (const p of Array.isArray(picks) ? picks : []) {
      if (!p || !p.url || !/^https?:/i.test(p.url)) continue;
      store.addBookmark(p.url, p.title || p.url, p.reason || '');
      if (p.folder) store.setBookmarkFolder(p.url, p.folder);
      if (p.tags && p.tags.length) store.setCategory(p.url, p.folder || '未分类', p.tags);
      added++;
    }
    return { added };
  });

  // Batch AI filing: 'uncategorized' files loose bookmarks into folders,
  // 'all' proposes a whole new structure. Suggestions only until …-apply.
  ipcMain.handle('bookmarks:ai-file', async (_e, scope) => {
    const all = store.listBookmarks();
    const items = (scope === 'all' ? all : all.filter((b) => !b.folder)).map((b) => ({
      url: b.url, title: b.title, domain: b.domain, folder: b.folder || '',
    }));
    const folders = store.listBookmarkFolders().folders.map((f) => f.name);
    const cfg = config.get().ai;
    const res = scope === 'all'
      ? await ai.aiFolderStructure(cfg, items, folders)
      : await ai.aiOrganizeBookmarks(cfg, items, folders);
    return { total: items.length, items: res.filter((x) => x.folder && x.folder !== x.oldFolder) };
  });
  ipcMain.handle('bookmarks:ai-file-apply', async (_e, picks) => {
    let moved = 0;
    for (const p of Array.isArray(picks) ? picks : []) {
      if (!p || !p.url || !p.folder) continue;
      store.setBookmarkFolder(p.url, p.folder);
      if (p.tags && p.tags.length) store.setCategory(p.url, p.folder, p.tags);
      moved++;
    }
    return { moved };
  });
  ipcMain.handle('bookmarks:duplicates', async () => {
    const items = store.listBookmarks();
    return ai.aiDuplicateBookmarks(config.get().ai, items);
  });
  ipcMain.handle('bookmarks:related', async (_e, url) => store.relatedBookmarks(url, 8));
  ipcMain.handle('bookmarks:set-note', async (_e, { url, note }) => {
    store.setBookmarkNote(url, note);
    return true;
  });
  // Dead-link scan: HEAD (falling back to GET) every bookmark, 8 in parallel.
  ipcMain.handle('bookmarks:check-links', async () => {
    const bms = store.listBookmarks().filter((b) => /^https?:/i.test(b.url));
    const queue = [...bms];
    const dead = [];
    const probe = async (b) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        let res = await fetch(b.url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
        if (res.status === 405 || res.status === 403 || res.status === 501) {
          res = await fetch(b.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
        }
        if (res.status >= 400) dead.push({ url: b.url, title: b.title, folder: b.folder || '', status: res.status });
      } catch (e) {
        dead.push({ url: b.url, title: b.title, folder: b.folder || '', status: 0, error: String(e.message || e).slice(0, 80) });
      } finally {
        clearTimeout(timer);
      }
    };
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (queue.length) await probe(queue.shift());
    }));
    return { checked: bms.length, dead };
  });

  ipcMain.handle('bookmarks:ask', async (_e, question) => {
    const items = store.listBookmarks().map((b) => ({
      ...b,
      content: (store.getBookmarkContent(b.url) || {}).content || '',
    }));
    return ai.askBookmarks(config.get().ai, question, items);
  });
  ipcMain.handle('bookmarks:import-browser', async () => {
    const { items, errors } = await readAllBookmarks();
    const imported = store.importBookmarks(items);
    return { found: items.length, imported, errors };
  });
  ipcMain.handle('memory:day-highlights', async (_e, { day, limit }) => store.dayHighlights(day, limit || 3));
  ipcMain.handle('memory:stale-bookmarks', async (_e, { days, limit } = {}) => store.staleBookmarks(days || 90, limit || 8));
  ipcMain.handle('bookmarks:folders', async () => store.listBookmarkFolders());
  ipcMain.handle('bookmarks:folder-create', async (_e, name) => {
    store.createBookmarkFolder(name);
    return store.listBookmarkFolders();
  });
  ipcMain.handle('bookmarks:folder-rename', async (_e, { oldName, newName }) => {
    store.renameBookmarkFolder(oldName, newName);
    return store.listBookmarkFolders();
  });
  ipcMain.handle('bookmarks:folder-delete', async (_e, name) => {
    store.deleteBookmarkFolder(name);
    return store.listBookmarkFolders();
  });
  ipcMain.handle('bookmarks:set-folder', async (_e, { url, folder }) => {
    store.setBookmarkFolder(url, folder);
    return true;
  });
  ipcMain.handle('bookmarks:remove', async (_e, url) => {
    store.removeBookmark(url);
    return store.listBookmarks();
  });

  const publicConfig = () => {
    const c = config.get();
    // Do not leak full keys to the renderer; send masked presence flags.
    return {
      ai: {
        provider: c.ai.provider || 'custom',
        baseUrl: c.ai.baseUrl,
        model: c.ai.model,
        hasKey: !!(c.ai.apiKey && c.ai.apiKey.trim()),
      },
      reader: { enabled: !!c.reader.enabled, hasKey: !!(c.reader.jinaKey && c.reader.jinaKey.trim()) },
      syncIntervalMs: c.syncIntervalMs,
      blacklist: c.blacklist || [],
      weeklyNotify: c.weeklyNotify !== false,
      autoLaunch: !!c.autoLaunch,
      startMinimized: !!c.startMinimized,
      closeToTray: c.closeToTray !== false,
      minimizeToTray: !!c.minimizeToTray,
      blackholeMinutes: Number(c.blackholeMinutes) || 0,
      privacyPausedUntil: privacyPausedUntil(),
      thumbsEnabled: !!c.thumbsEnabled,
      contentFetchEnabled: !!c.contentFetchEnabled,
      onboardingCompleted: !!c.onboardingCompleted,
      enabledProfiles: c.enabledProfiles,
      bridgeEnabled: c.bridgeEnabled !== false,
      bridgePort: c.bridgePort || 17862,
      bridgeToken: c.bridgeToken || '',
    };
  };
  ipcMain.handle('config:get', async () => publicConfig());
  ipcMain.handle('config:update', async (_e, patch) => {
    if (patch && Array.isArray(patch.enabledProfiles)) patch.onboardingCompleted = true;
    const prevListen = tabBridge && tabBridge.listeningPort;
    config.update(patch);
    if (patch.syncIntervalMs && sync) sync.setIntervalMs(patch.syncIntervalMs);
    if ('autoLaunch' in patch) applyAutoLaunch();
    if (sync && (patch.onboardingCompleted || patch.enabledProfiles)) {
      sync.syncOnce(true).catch((e) => console.error('sync after config', e));
    }
    if (patch && patch.bridgePort != null && Number(patch.bridgePort) !== Number(prevListen || 0)) {
      try {
        await startAppBridge();
      } catch (e) {
        const out = publicConfig();
        out.bridgeError = e.message || String(e);
        return out;
      }
    }
    return publicConfig();
  });

  ipcMain.handle('open:external', async (_e, url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '只允许打开 http(s) 地址' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('clipboard:write', async (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('ai:test', async () => ai.testConnection(config.get().ai));

  // -------- privacy pause --------
  ipcMain.handle('privacy:pause', async (_e, minutes) => ({ pausedUntil: privacyPause(minutes) }));
  ipcMain.handle('privacy:resume', async () => ({ pausedUntil: privacyResume() }));
  ipcMain.handle('privacy:status', async () => ({ pausedUntil: privacyPausedUntil() }));

  // Privacy blacklist: never record a domain again + purge existing records.
  ipcMain.handle('blacklist:add', async (_e, domain) => {
    const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!d) return { removed: 0, blacklist: config.get().blacklist || [] };
    const list = Array.from(new Set([...(config.get().blacklist || []), d]));
    config.update({ blacklist: list });
    const removed = store.deleteByDomain(d);
    pushUpdate();
    return { removed, blacklist: list };
  });
  ipcMain.handle('blacklist:remove', async (_e, domain) => {
    const d = String(domain || '').trim().toLowerCase();
    const list = (config.get().blacklist || []).filter((x) => x !== d);
    config.update({ blacklist: list });
    return { blacklist: list };
  });

  // -------- read later --------
  ipcMain.handle('readlater:list', async (_e, includeDone) => store.listReadLater(includeDone !== false));
  ipcMain.handle('readlater:add', async (_e, { url, title }) => {
    store.addReadLater(url, title);
    return true;
  });
  ipcMain.handle('readlater:done', async (_e, { url, done }) => {
    store.markReadLaterDone(url, done !== false);
    return true;
  });
  ipcMain.handle('readlater:remove', async (_e, url) => {
    store.removeReadLater(url);
    return true;
  });

  // -------- session restore --------
  ipcMain.handle('session:preview', async (_e, { fromMs, toMs, browser }) =>
    store.sessionUrls(fromMs, toMs, browser || null));
  ipcMain.handle('session:restore', async (_e, { urls }) => {
    return openHttpUrlList(urls, async (url) => {
      try {
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }, { limit: 30, delayMs: 250 });
  });

  // -------- insights --------
  ipcMain.handle('insights:revisits', async () => store.revisitInsights(7, 3, 8));
  ipcMain.handle('index:stats', async () => ({ indexedPages: store.textIndexCount() }));

  // -------- advanced AI --------
  ipcMain.handle('report:range', async (_e, { days, browser }) => {
    const n = Math.max(1, Math.min(90, Number(days) || 7));
    const toMs = Date.now();
    const fromMs = toMs - n * 86400000;
    const stats = store.rangeStats(fromMs, toMs, browser || null);
    const label = n === 7 ? '最近一周' : n === 30 ? '最近一个月' : `最近 ${n} 天`;
    const narrative = await ai.weeklyReport(config.get().ai, label, stats).catch((e) => `报告生成失败：${e.message}`);
    return { label, stats, narrative };
  });

  ipcMain.handle('collections:run', async () => {
    const items = store.recentDistinct(150);
    return ai.aiCollections(config.get().ai, items);
  });

  ipcMain.handle('ask:history', async (_e, question) => {
    const q = String(question || '').trim();
    // Ground on both keyword matches and recent pages.
    const matched = store.search(q, 60);
    const recent = store.recentDistinct(80);
    const seen = new Set();
    const items = [];
    for (const it of [...matched, ...recent]) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
    }
    const ontology = store.buildOntology(30);
    return ai.askHistory(config.get().ai, q, items, ontology);
  });

  ipcMain.handle('ontology:get', async (_e, days) => store.buildOntology(Number(days) || 30));

  // -------- offline page snapshot (时光机) --------
  ipcMain.handle('pageshot:get', async (_e, url) => store.getPageText(url));

  // -------- referrer path chain --------
  ipcMain.handle('trace:path', async (_e, url) => store.pathChain(url, 10));

  // -------- noise cleanup --------
  ipcMain.handle('noise:count', async () => ({ count: store.noiseCount() }));
  ipcMain.handle('noise:purge', async () => {
    const hidden = store.purgeNoise();
    pushUpdate();
    return { hidden };
  });
  ipcMain.handle('noise:restore', async () => {
    const restored = store.restoreNoise();
    pushUpdate();
    return { restored };
  });

  // -------- stale unread backlog --------
  ipcMain.handle('readlater:stale', async (_e, days) => store.staleUnread(Number(days) || 7));

  // -------- per-domain dwell (time blackhole) --------
  ipcMain.handle('dwell:domains', async (_e, { fromMs, toMs, browser }) =>
    store.domainDwell(fromMs, toMs, browser || null));

  // -------- backup & restore --------
  ipcMain.handle('backup:now', async () => runBackup(true));
  ipcMain.handle('backup:list', async () => listBackups());
  ipcMain.handle('backup:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要恢复的备份文件',
      defaultPath: backupDir(),
      filters: [{ name: 'SQLite 备份', extensions: ['sqlite'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { restored: false };
    const src = filePaths[0];
    if (!isSqliteFile(src)) {
      return { restored: false, error: '所选文件不是有效的 SQLite 备份，当前数据未改动' };
    }
    if (sync) sync.stop();
    if (enricher) enricher.stop();
    if (thumbs) thumbs.stop();
    store.save();
    try {
      restoreDatabase(path.join(app.getPath('userData'), 'hub.sqlite'), src, { safetyDir: backupDir() });
    } catch (e) {
      return { restored: false, error: e.message || String(e) };
    }
    quitting = true;
    app.relaunch();
    app.exit(0);
    return { restored: true };
  });

  registerSnapshotIpc({
    ipcMain,
    store,
    config,
    getBridge: () => tabBridge,
    dialog,
    shell,
    ai,
    getMainWindow: () => mainWindow,
    app,
    getSync: () => sync,
  });
}

// -------- automatic database backup --------
function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups() {
  const dir = backupDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// One backup per day, keep the newest 14.
function runBackup(force = false) {
  const dir = backupDir();
  const day = new Date();
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const dest = path.join(dir, `hub-${key}.sqlite`);
  if (!force && fs.existsSync(dest)) return { backedUp: false, path: dest };
  store.save();
  fs.copyFileSync(path.join(app.getPath('userData'), 'hub.sqlite'), dest);
  const all = listBackups();
  for (const b of all.slice(14)) {
    try { fs.unlinkSync(b.path); } catch (e) { /* ignore */ }
  }
  return { backedUp: true, path: dest };
}

// Collapse repeated visits to the same URL, keeping the newest and counting the rest.
function dedupeByUrl(items) {
  const byUrl = new Map();
  for (const it of items) {
    const cur = byUrl.get(it.url);
    if (cur) {
      cur.visitCount += 1;
      const dwellSum = (cur.dwellSumMs || 0) + (it.dwellMs || 0);
      const engagedAny = !!(cur.engaged || it.engaged);
      if (it.visitTime > cur.visitTime) Object.assign(cur, it, { visitCount: cur.visitCount });
      cur.dwellSumMs = dwellSum;
      cur.engaged = engagedAny;
    } else {
      byUrl.set(it.url, { ...it, visitCount: 1, dwellSumMs: it.dwellMs || 0 });
    }
  }
  return Array.from(byUrl.values());
}

// Group flat visit items into a day -> hour -> domain tree for the UI.
// Repeated visits to the same URL are collapsed into one entry with a count.
function buildTimeline(items) {
  const deduped = dedupeByUrl(items);
  const hours = new Map();
  for (const it of deduped) {
    const d = new Date(it.visitTime);
    const hour = d.getHours();
    if (!hours.has(hour)) hours.set(hour, new Map());
    const domains = hours.get(hour);
    const key = it.domain || '(其他)';
    if (!domains.has(key)) domains.set(key, []);
    domains.get(key).push(it);
  }
  const total = items.length;
  const hourList = Array.from(hours.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([hour, domains]) => ({
      hour,
      domains: Array.from(domains.entries())
        .map(([domain, entries]) => ({
          domain,
          count: entries.length,
          entries: entries.sort((a, b) => b.visitTime - a.visitTime),
        }))
        .sort((a, b) => b.count - a.count),
    }));
  return { total, distinct: deduped.length, hours: hourList };
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  // Keep running in the tray; actual quit happens via tray menu / before-quit.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
  if (sync) sync.stop();
  if (enricher) enricher.stop();
  if (thumbs) thumbs.stop();
  if (tabBridge) { try { tabBridge.stop(); } catch (e) { /* ignore */ } }
  if (store) store.save();
});
