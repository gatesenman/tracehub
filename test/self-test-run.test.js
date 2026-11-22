'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { Config } = require('../src/main/config');
const { startBridge } = require('../src/main/snapshot-service');
const { runSelfTest, writeReport } = require('../src/main/self-test');

describe('runSelfTest (Node; not a packaged Windows or Chrome GUI test)', () => {
  let dir;
  let store;
  let bridge;

  after(async () => {
    try { if (bridge) await bridge.stop(); } catch (e) { /* ignore */ }
    try { if (store && store.close) store.close(); } catch (e) { /* ignore */ }
  });

  it('writes a report from isolated userData without leaking the pairing token', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-selftest-unit-'));
    store = new Store(path.join(dir, 'hub.sqlite'));
    await store.init();
    const config = new Config(path.join(dir, 'config.json'));
    config.update({ bridgeEnabled: true, bridgePort: 0, thumbsEnabled: false, contentFetchEnabled: false, enabledProfiles: [] });
    process.env.TRACEHUB_DISABLE_SYNC = '1';
    bridge = await startBridge(config, store, {});
    assert.ok(bridge && bridge.listeningPort);

    const report = await runSelfTest({
      app: { isPackaged: false, getVersion: () => '1.2.2' },
      store,
      config,
      bridge,
      userData: dir,
      argv: ['node', 'test'],
      flags: { argvSelfTestSeen: false, argvUserDataSeen: false },
      reportPath: path.join(dir, 'self-test-report.json'),
      version: '1.2.2',
    });
    const reportPath = path.join(dir, 'self-test-report.json');
    writeReport(report, reportPath);

    const text = fs.readFileSync(reportPath, 'utf8');
    const token = config.get().bridgeToken;
    assert.ok(token);
    assert.equal(text.includes(token), false, 'report must not contain the pairing token');
    assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
    assert.equal(report.syncDisabled, true);
    assert.equal(report.isPackaged, false);
    assert.ok(report.notClaimed.some((s) => /Chrome|Edge/.test(s)));
    const ids = report.checks.map((c) => c.id);
    for (const need of [
      'native-better-sqlite3',
      'sqljs-wasm',
      'history-worker',
      'extension-resources',
      'bridge-loopback',
      'bridge-snapshot-save-and-restart-read',
      'bridge-restore-and-close-ack',
      'backup-restore-export',
      'migration-read-later-decouple',
    ]) {
      assert.ok(ids.includes(need), 'missing ' + need);
    }
  });
});
