'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Linux isolated Electron renderer/IPC (synthetic session files)', () => {
  it('runs a hidden BrowserWindow preload invoke of list-preview-save and refuses close', { skip: process.env.TRACEHUB_RUN_EIPC !== '1' }, function () {
    const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');
    const harness = path.join(__dirname, '..', 'scripts', 'electron-session-ipc-test.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-eipc-test-'));
    const reportPath = path.join(dir, 'report.json');
    const env = {
      ...process.env,
      TRACEHUB_USER_DATA: dir,
      TRACEHUB_EIPC_REPORT: reportPath,
      TRACEHUB_DISABLE_SYNC: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    if (!env.DISPLAY) env.DISPLAY = ':40';
    const r = spawnSync(electron, [harness], {
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
    const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    if (r.status !== 0 && /NODE_MODULE_VERSION|better_sqlite3/.test(String(r.stderr || r.stdout || ''))) {
      // Electron ABI differs from the Node test ABI; do not pretend this ran.
      assert.ok(true, 'electron native ABI mismatch recorded, not claimed as passed');
      fs.writeFileSync(path.join(dir, 'skipped-abi.txt'), String(r.stderr || r.stdout || '').slice(0, 2000));
      // Fail so we notice if we forgot to rebuild for Electron when we intended to run it.
      assert.fail('Electron better-sqlite3 ABI mismatch; rebuild for Electron to run this isolated IPC test. stderr=' + String(r.stderr || '').slice(0, 400));
    }
    assert.equal(r.status, 0, 'electron exit ' + r.status + '\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr + '\nreport:\n' + JSON.stringify(report, null, 2));
    assert.ok(report);
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.result.source, 'session-file');
    assert.equal(report.result.tabIdNull, true);
    assert.equal(report.closeRefused, true);
    assert.match(report.mode, /electron-renderer-ipc/);
  });
});
