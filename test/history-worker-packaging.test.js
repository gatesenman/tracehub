'use strict';

/**
 * Regression for "TraceHub stopped importing browser history" (1.2.1–1.2.8):
 * the packaged build extracted src/main/history-worker.js to app.asar.unpacked,
 * where its require('./browsers') cannot resolve, so every profile read failed.
 *
 * These tests rebuild the packaged layout (app.asar + app.asar.unpacked) from
 * package.json "build.asarUnpack" as plain directories and run the real
 * worker against a Chrome-format History file. Plain Node is not Electron's
 * asar loader, but module resolution between the two trees is the same.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const CHROME_EPOCH_OFFSET_MS = 11644473600000;

function writeChromeHistory(filePath, urls) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER);
  `);
  urls.forEach((u, i) => {
    const t = BigInt(Date.now() - i * 1000 + CHROME_EPOCH_OFFSET_MS) * 1000n;
    db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(i + 1, u, `Page ${i + 1}`);
    db.prepare('INSERT INTO visits (id, url, visit_time, from_visit) VALUES (?, ?, ?, 0)').run(i + 1, i + 1, t);
  });
  db.close();
}

function listFiles(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

// Minimal glob for the patterns package.json uses ("a/b/**" and plain files).
function unpackedSrcFiles() {
  const out = [];
  for (const pattern of pkg.build.asarUnpack || []) {
    if (pattern.startsWith('node_modules/')) continue;
    if (pattern.endsWith('/**')) {
      const dir = path.join(root, pattern.slice(0, -3));
      if (fs.existsSync(dir)) out.push(...listFiles(dir).map((f) => path.relative(root, f)));
    } else {
      out.push(pattern);
    }
  }
  return out;
}

function relativeRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function resolvesIn(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [base, base + '.js', base + '.json', path.join(base, 'index.js')].some((p) => fs.existsSync(p));
}

// Build <tmp>/resources/{app.asar,app.asar.unpacked} the way electron-builder does.
function buildPackagedLayout() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-pack-layout-'));
  const asarDir = path.join(tmp, 'resources', 'app.asar');
  const unpackedDir = path.join(tmp, 'resources', 'app.asar.unpacked');
  fs.cpSync(path.join(root, 'src'), path.join(asarDir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(asarDir, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(asarDir, 'node_modules'), 'junction');
  for (const rel of unpackedSrcFiles()) {
    const dest = path.join(unpackedDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dest);
  }
  return { tmp, asarDir, unpackedDir };
}

function runWorker(workerPath, historyPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timed out')); }, 15000);
    worker.once('error', (err) => { clearTimeout(timer); reject(err); });
    worker.on('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.items);
    });
    worker.postMessage({
      id: 1,
      since: 0,
      browser: { id: 'chrome', name: 'Google Chrome', engine: 'chromium' },
      profile: { profile: 'Default', historyPath },
    });
  });
}

describe('history worker in the packaged (asar / asar.unpacked) layout', () => {
  const tmps = [];
  after(() => {
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
  });

  it('every unpacked src file can still resolve its relative requires next to it', () => {
    const broken = [];
    for (const rel of unpackedSrcFiles()) {
      for (const spec of relativeRequires(path.join(root, rel))) {
        // Simulate the unpacked tree: the sibling must itself be unpacked.
        const target = path.normalize(path.join(path.dirname(rel), spec));
        const unpacked = unpackedSrcFiles().map((f) => f.replace(/\.js$/, ''));
        if (!unpacked.includes(target.replace(/\.js$/, ''))) broken.push(`${rel} -> ${spec}`);
      }
    }
    assert.deepEqual(broken, [], 'asarUnpack splits a module from the siblings it requires');
  });

  it('does not unpack the history worker away from browsers.js / sqlengine.js', () => {
    assert.ok(!unpackedSrcFiles().includes('src/main/history-worker.js'));
  });

  it('the worker resolved by paths.js reads a Chrome History file from the packaged layout', async () => {
    const { tmp, asarDir } = buildPackagedLayout();
    tmps.push(tmp);
    const { resolveHistoryWorkerPath } = require(path.join(asarDir, 'src', 'main', 'paths.js'));
    const workerPath = resolveHistoryWorkerPath();
    for (const spec of relativeRequires(workerPath)) {
      assert.ok(resolvesIn(workerPath, spec), `${workerPath} cannot resolve ${spec}`);
    }
    const hist = path.join(tmp, 'profile', 'Default', 'History');
    writeChromeHistory(hist, ['https://example.com/a', 'https://example.org/b']);
    const items = await runWorker(workerPath, hist);
    assert.deepEqual(items.map((i) => i.url).sort(), ['https://example.com/a', 'https://example.org/b']);
    assert.ok(items.every((i) => i.browser === 'chrome' && i.profile === 'Default' && i.visitTime > 0));
  });
});

describe('SyncEngine when the history worker is broken', () => {
  const { SyncEngine } = require('../src/main/sync');

  function fakeStore() {
    const rows = [];
    return {
      rows,
      latestVisitTime: () => 0,
      upsertVisits: (items) => { rows.push(...items); return items.length; },
    };
  }

  it('falls back to in-process reading instead of dropping every profile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-sync-fallback-'));
    try {
      const hist = path.join(dir, 'Default', 'History');
      writeChromeHistory(hist, ['https://example.com/fallback']);
      const store = fakeStore();
      const updates = [];
      const sync = new SyncEngine(store, { onUpdate: (u) => updates.push(u), isSyncAllowed: () => true });
      // Same failure mode as the 1.2.8 installer: the worker script throws on load.
      sync._createWorker = () => new Worker(
        "throw new Error(\"Cannot find module './browsers'\")",
        { eval: true }
      );
      const origError = console.error;
      console.error = () => {};
      try {
        sync.browsers = [{ id: 'chrome', name: 'Google Chrome', engine: 'chromium', profiles: [{ profile: 'Default', historyPath: hist }] }];
        sync.running = true;
        const first = await sync.syncOnce(true);
        assert.equal(first.inserted, 1);
        assert.deepEqual(first.errors, []);
        assert.match(sync.workerError, /Cannot find module/);
        // Later syncs keep working without re-spawning the broken worker.
        writeChromeHistory(path.join(dir, 'Profile 1', 'History'), ['https://example.org/later']);
        sync.browsers[0].profiles.push({ profile: 'Profile 1', historyPath: path.join(dir, 'Profile 1', 'History') });
        const second = await sync.syncOnce(true);
        assert.equal(second.inserted, 2);
        assert.equal(sync._worker, null);
      } finally {
        console.error = origError;
        sync.stop();
      }
      assert.deepEqual(store.rows.map((r) => r.url).sort(), ['https://example.com/fallback', 'https://example.com/fallback', 'https://example.org/later'].sort());
      assert.equal(updates.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
