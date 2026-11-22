'use strict';

/**
 * Packaged-app self-test. Runs inside Electron against an isolated userData.
 * It exercises real native sqlite, packed resource paths, and the loopback
 * HTTP bridge. HTTP command acks are issued by this process, not by Chrome.
 * This is not a real-browser GUI test and never reads the user's history.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const { packagedResourcePaths, resolveHistoryWorkerPath } = require('./paths');
const { extensionDir } = require('./snapshot-service');
const snap = require('./snapshot-store');
const { isSqliteFile, restoreDatabase } = require('./backup');

const CHROME_EPOCH_OFFSET_MS = 11644473600000;
const SELFTEST_EXT = 'abcdefghijklmnopqrstuvwxyzabcdef';

function check(id, real, fn) {
  return { id, real, fn };
}

function summarize(entry, result) {
  const out = { id: entry.id, ok: false, real: entry.real };
  if (result && typeof result === 'object') Object.assign(out, result);
  out.ok = result ? result.ok !== false : false;
  return out;
}

function httpJson(port, method, urlPath, { token, extensionId, browserId, body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Accept: 'application/json' };
    if (origin) headers.Origin = origin;
    if (token) headers['X-TraceHub-Token'] = token;
    if (extensionId) headers['X-Extension-Id'] = extensionId;
    if (browserId) headers['X-TraceHub-Browser'] = browserId;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = { parseError: true, raw: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function writeSyntheticChromeHistory(filePath) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER);
  `);
  const visitTime = BigInt(Date.now() + CHROME_EPOCH_OFFSET_MS) * 1000n;
  db.prepare('INSERT INTO urls (id, url, title) VALUES (1, ?, ?)').run('https://example.com/', 'Example Domain');
  db.prepare('INSERT INTO visits (id, url, visit_time, from_visit) VALUES (1, 1, ?, 0)').run(visitTime);
  db.close();
}

function snapshotPayload() {
  return {
    source: 'extension',
    capturedAt: Date.now(),
    extensionId: SELFTEST_EXT,
    browser: { id: 'chrome', name: 'Chrome', profile: 'SelfTest' },
    windows: [
      {
        windowId: 1,
        focused: true,
        state: 'maximized',
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        tabs: [
          { tabId: 11, index: 0, url: 'https://example.com/', title: 'Example Domain', groupId: 4, groupTitle: 'Test Pages', groupColor: 'blue' },
          { tabId: 12, index: 1, url: 'https://example.org/', title: 'Example Org' },
        ],
      },
    ],
  };
}

async function runCheck(entry) {
  try {
    const result = await entry.fn();
    return summarize(entry, result || { ok: true });
  } catch (e) {
    return { id: entry.id, ok: false, real: entry.real, error: e.message || String(e) };
  }
}

async function runSelfTest(ctx) {
  const app = ctx.app;
  const store = ctx.store;
  const config = ctx.config;
  const bridge = ctx.bridge;
  const flags = ctx.flags || {};
  const userData = ctx.userData;
  const startedAt = new Date().toISOString();
  const packed = packagedResourcePaths();

  const checks = [];

  checks.push(check('native-better-sqlite3', 'windows-packaged-native-if-isPackaged', async () => {
    const Database = require('better-sqlite3');
    const probe = path.join(userData, 'native-probe.sqlite');
    const db = new Database(probe);
    db.exec('CREATE TABLE IF NOT EXISTS t (x TEXT); DELETE FROM t; INSERT INTO t VALUES (\'ok\');');
    const row = db.prepare('SELECT x FROM t').get();
    db.close();
    return {
      ok: row && row.x === 'ok',
      module: require.resolve('better-sqlite3'),
      modulesAbi: process.versions.modules,
      electron: process.versions.electron || null,
      detail: 'wrote and read a temp sqlite file with better-sqlite3 in this process',
    };
  }));

  checks.push(check('sqljs-wasm', 'packaged-sqljs-path', async () => {
    const engine = require('./sqlengine');
    const fixture = path.join(userData, 'sqljs-fixture.sqlite');
    writeSyntheticChromeHistory(fixture);
    if (typeof engine.openDatabaseFromFile === 'function') {
      const db = await engine.openDatabaseFromFile(fixture);
      try {
        const rows = engine.queryAll
          ? engine.queryAll(db, 'SELECT url FROM urls', [])
          : db.all('SELECT url FROM urls');
        const ok = Array.isArray(rows) && rows.some((r) => r.url === 'https://example.com/');
        if (typeof db.close === 'function') db.close();
        return { ok, detail: 'opened a synthetic Chrome-like history with sql.js (not a user profile)' };
      } catch (e) {
        try { db.close(); } catch (e2) { /* ignore */ }
        throw e;
      }
    }
    if (typeof engine.getSQL === 'function') {
      const SQL = await engine.getSQL();
      const buf = fs.readFileSync(fixture);
      const db = new SQL.Database(buf);
      const rows = db.exec('SELECT url FROM urls');
      db.close();
      const ok = JSON.stringify(rows).includes('example.com');
      return { ok, detail: 'loaded sql.js WASM and read a synthetic history file (not a user profile)' };
    }
    return { ok: false, error: 'sqlengine has no openDatabaseFromFile or getSQL' };
  }));

  checks.push(check('history-worker', 'packaged-worker-thread', async () => {
    const workerPath = resolveHistoryWorkerPath();
    const hist = path.join(userData, 'synthetic-chrome', 'History');
    writeSyntheticChromeHistory(hist);
    const items = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath);
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch (e) { /* ignore */ }
        reject(new Error('history-worker timed out'));
      }, 15000);
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.on('message', (msg) => {
        clearTimeout(timer);
        worker.terminate();
        if (msg && msg.error) reject(new Error(msg.error));
        else resolve((msg && msg.items) || []);
      });
      worker.postMessage({
        id: 1,
        browser: { id: 'chrome', name: 'Chrome', engine: 'chromium' },
        profile: { profile: 'SelfTest', historyPath: hist },
        since: 0,
      });
    });
    const ok = Array.isArray(items) && items.some((it) => it && it.url === 'https://example.com/');
    return {
      ok,
      workerPath,
      itemCount: items.length,
      detail: 'worker parsed a synthetic History file created in userData; it did not read real browser profiles',
    };
  }));

  checks.push(check('extension-resources', 'packaged-extraResources', async () => {
    const dir = extensionDir(app);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { ok: false, path: dir, error: 'extension manifest missing' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bg = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
    const cg = fs.readFileSync(path.join(dir, 'close-guard.js'), 'utf8');
    const ok = manifest.version
      && bg.includes('bridgeRequest')
      && bg.includes('handleRestoreCommand')
      && cg.includes('closeGuardApi')
      && cg.includes('buildWindowCreateAttempts')
      && !/\bvar api\b/.test(cg);
    return {
      ok,
      path: dir,
      manifestVersion: manifest.version,
      detail: 'checked packed extension files; loading them in Chrome/Edge is a separate real-GUI step',
    };
  }));

  checks.push(check('asar-unpack-paths', 'packaged-layout', async () => {
    if (!app || !app.isPackaged) {
      return { ok: true, skipped: true, detail: 'not packaged; skipped win-unpacked path assertions' };
    }
    const missing = [];
    for (const [name, p] of Object.entries({
      nativeNode: packed.nativeNode,
      sqlJsWasm: packed.sqlJsWasm,
      historyWorkerUnpacked: packed.historyWorkerUnpacked,
      extensionDir: packed.extensionDir,
    })) {
      if (!p || !fs.existsSync(p)) missing.push(name);
    }
    return {
      ok: missing.length === 0,
      missing,
      paths: packed,
      detail: 'verified unpacked native, wasm, worker, and extension files exist on disk',
    };
  }));

  checks.push(check('bridge-loopback', 'in-process-http-bridge', async () => {
    if (!bridge || !bridge.listeningPort) return { ok: false, error: 'bridge is not listening' };
    const health = await httpJson(bridge.listeningPort, 'GET', '/v1/health');
    return {
      ok: health.status === 200 && health.json && health.json.ok === true,
      port: bridge.listeningPort,
      detail: 'GET /v1/health on 127.0.0.1 (no token, no paths leaked)',
    };
  }));

  checks.push(check('bridge-snapshot-save-and-restart-read', 'http-client-not-chrome-gui', async () => {
    if (!bridge || !bridge.listeningPort) return { ok: false, error: 'bridge is not listening' };
    const token = config.get().bridgeToken;
    const posted = await httpJson(bridge.listeningPort, 'POST', '/v1/snapshot', {
      token,
      extensionId: SELFTEST_EXT,
      origin: `chrome-extension://${SELFTEST_EXT}`,
      body: snapshotPayload(),
    });
    if (!(posted.json && posted.json.ok && posted.json.snapshotId)) {
      return { ok: false, error: (posted.json && posted.json.error) || 'snapshot POST failed', status: posted.status };
    }
    const id = posted.json.snapshotId;
    const before = snap.getSnapshot(store, id);
    if (!before || before.tabCount < 2) return { ok: false, error: 'snapshot not readable immediately after save' };
    const dbPath = store.dbPath || path.join(userData, 'hub.sqlite');
    if (typeof store.close === 'function') store.close();
    const { Store } = require('./store');
    const reopened = new Store(dbPath);
    await reopened.init();
    const after = snap.getSnapshot(reopened, id);
    if (typeof reopened.close === 'function') reopened.close();
    await store.init();
    ctx.store = store;
    const ok = after && after.id === id && after.tabCount === before.tabCount
      && (after.windows || []).length === (before.windows || []).length;
    return {
      ok,
      snapshotId: id,
      tabCount: after && after.tabCount,
      detail: 'saved via HTTP (simulated extension client), closed sqlite, reopened, and read the same snapshot. Not a process restart. Not real Chrome.',
    };
  }));

  checks.push(check('bridge-restore-and-close-ack', 'http-ack-not-chrome-gui', async () => {
    if (!bridge || !bridge.listeningPort) return { ok: false, error: 'bridge is not listening' };
    const token = config.get().bridgeToken;
    const posted = await httpJson(bridge.listeningPort, 'POST', '/v1/snapshot', {
      token,
      extensionId: SELFTEST_EXT,
      origin: `chrome-extension://${SELFTEST_EXT}`,
      body: snapshotPayload(),
    });
    const id = posted.json && posted.json.snapshotId;
    if (!id) return { ok: false, error: 'could not save snapshot for command test' };
    const restoreCmd = bridge.enqueueCommand('restore', {
      snapshotId: id,
      windows: [{ url: 'https://example.com/' }, { url: 'https://example.org/' }],
    }, { extensionId: SELFTEST_EXT, browserId: 'chrome' });
    const pending = await httpJson(bridge.listeningPort, 'GET', '/v1/pending', {
      token,
      extensionId: SELFTEST_EXT,
      browserId: 'chrome',
      origin: `chrome-extension://${SELFTEST_EXT}`,
    });
    const gotRestore = (pending.json && pending.json.commands || []).some((c) => c.id === restoreCmd.id);
    const mid = snap.getSnapshot(store, id);
    // enqueue itself may not mark queued unless going through restore-batch IPC.
    const ackRestore = await httpJson(bridge.listeningPort, 'POST', '/v1/command-result', {
      token,
      extensionId: SELFTEST_EXT,
      origin: `chrome-extension://${SELFTEST_EXT}`,
      body: {
        commandId: restoreCmd.id,
        type: 'restore',
        snapshotId: id,
        ok: true,
        opened: [{ url: 'https://example.com/' }, { url: 'https://example.org/' }],
        failed: [],
      },
    });
    const afterRestore = snap.getSnapshot(store, id);
    const restoreOk = afterRestore && (afterRestore.windows || []).every((w) =>
      (w.tabs || []).filter((t) => /^https:\/\/example\.(com|org)\//.test(t.url))
        .every((t) => t.restoreStatus === 'opened'));

    const closeCmd = bridge.enqueueCommand('close', {
      snapshotId: id,
      windowIds: [1],
    }, { extensionId: SELFTEST_EXT, browserId: 'chrome' });
    snap.setCloseStatus(store, id, 'pending', '');
    const pendingClose = await httpJson(bridge.listeningPort, 'GET', '/v1/pending', {
      token,
      extensionId: SELFTEST_EXT,
      browserId: 'chrome',
      origin: `chrome-extension://${SELFTEST_EXT}`,
    });
    const gotClose = (pendingClose.json && pendingClose.json.commands || []).some((c) => c.id === closeCmd.id);
    await httpJson(bridge.listeningPort, 'POST', '/v1/command-result', {
      token,
      extensionId: SELFTEST_EXT,
      origin: `chrome-extension://${SELFTEST_EXT}`,
      body: {
        commandId: closeCmd.id,
        type: 'close',
        snapshotId: id,
        ok: true,
        closedCount: 2,
        failed: [],
        skipped: [],
      },
    });
    const afterClose = snap.getSnapshot(store, id);
    const closeOk = afterClose && afterClose.closeStatus === 'done';
    return {
      ok: !!(gotRestore && ackRestore.json && ackRestore.json.ok && restoreOk && gotClose && closeOk),
      gotRestore,
      restoreStatusWritten: restoreOk,
      gotClose,
      closeStatus: afterClose && afterClose.closeStatus,
      queuedBeforeAck: mid && mid.id === id,
      detail: 'extension-shaped HTTP poll + command-result updated store. This did not call chrome.windows/tabs and is not a real GUI close/restore.',
    };
  }));

  checks.push(check('backup-restore-export', 'temp-sqlite-only', async () => {
    store.addBookmark('https://example.com/backup', 'Backup Probe', 'self-test');
    const exported = store.exportAll();
    const exportPath = path.join(userData, 'self-test-export.json');
    fs.writeFileSync(exportPath, JSON.stringify({ count: exported.length, sample: 'no-secrets' }), 'utf8');
    if (typeof store.checkpoint === 'function') store.checkpoint();
    else if (store.db && typeof store.db.checkpoint === 'function') store.db.checkpoint();
    const dbPath = store.dbPath || path.join(userData, 'hub.sqlite');
    const backupDir = path.join(userData, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, 'self-test.sqlite');
    if (typeof store.close === 'function') store.close();
    fs.copyFileSync(dbPath, backupPath);
    if (!isSqliteFile(backupPath)) {
      await store.init();
      return { ok: false, error: 'backup copy was not a sqlite file' };
    }
    const junk = path.join(userData, 'not-a-backup.bin');
    fs.writeFileSync(junk, 'not sqlite');
    let rejected = false;
    try {
      restoreDatabase(dbPath, junk, { safetyDir: backupDir });
    } catch (e) {
      rejected = /SQLite|有效/.test(e.message || '');
    }
    const restored = restoreDatabase(dbPath, backupPath, { safetyDir: backupDir });
    await store.init();
    const bookmarks = store.listBookmarks ? store.listBookmarks() : [];
    const found = (bookmarks || []).some((b) => b.url === 'https://example.com/backup');
    return {
      ok: rejected && restored && restored.ok && found && fs.existsSync(exportPath),
      exportPath,
      rejectedCorruptBackup: rejected,
      detail: 'backup header check, corrupt-file rejection, restore, and JSON export all used the isolated userData sqlite',
    };
  }));

  checks.push(check('migration-read-later-decouple', 'temp-sqlite-only', async () => {
    const Database = require('better-sqlite3');
    const migPath = path.join(userData, 'migrate-probe.sqlite');
    if (fs.existsSync(migPath)) fs.unlinkSync(migPath);
    const { Store } = require('./store');
    const s1 = new Store(migPath);
    await s1.init();
    s1.addBookmark('https://example.com/mig', 'Mig');
    s1.addReadLater('https://example.com/mig', 'Mig');
    if (typeof s1.setMeta === 'function') {
      // force remigration if the constructor already ran it after both inserts
    }
    // If constructor already decoupled because bookmark existed first, clear the flag and re-run.
    if (typeof s1.db !== 'undefined') {
      try { s1.setMeta('readLaterDecoupledAt', ''); } catch (e) { /* ignore */ }
    }
    const n = s1.migrateDecoupleReadLater();
    const rows = s1.listReadLater ? s1.listReadLater(true) : [];
    const item = (rows || []).find((r) => r.url === 'https://example.com/mig');
    if (typeof s1.close === 'function') s1.close();
    const ok = item && (item.done_at || item.doneAt || item.done);
    return {
      ok: !!ok,
      updated: n,
      detail: 'temporary db only; leftover unread read-later items that are also bookmarks are marked done',
    };
  }));

  const results = [];
  for (const entry of checks) {
    results.push(await runCheck(entry));
  }

  const report = {
    app: 'TraceHub',
    version: (ctx.version) || null,
    mode: 'packaged-self-test',
    platform: process.platform,
    arch: process.arch,
    isPackaged: !!(app && app.isPackaged),
    argv: (ctx.argv || []).map((a) => String(a)),
    argvSelfTestSeen: !!flags.argvSelfTestSeen,
    argvUserDataSeen: !!flags.argvUserDataSeen,
    userData,
    reportPath: ctx.reportPath || null,
    syncDisabled: process.env.TRACEHUB_DISABLE_SYNC === '1' || process.env.TRACEHUB_DISABLE_SYNC === 'true',
    startedAt,
    finishedAt: new Date().toISOString(),
    hostnameKind: 'isolated-self-test',
    checks: results,
    ok: results.every((c) => c.ok),
    notClaimed: [
      'Real Chrome/Edge GUI save, grouped restore, or close (HTTP ack only)',
      'Real user browser history sync or profile import',
      'Real AI calls',
      'Windows native is only proven when this report was produced by a packaged win32 build (isPackaged=true, platform=win32)',
    ],
  };
  return report;
}

function writeReport(report, reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

function defaultReportPath(userData) {
  return path.join(userData, 'self-test-report.json');
}

function defaultSelfTestUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-selftest-'));
}

module.exports = {
  runSelfTest,
  writeReport,
  defaultReportPath,
  defaultSelfTestUserData,
  parseLaunchFlags: require('./cli-flags').parseLaunchFlags,
};
