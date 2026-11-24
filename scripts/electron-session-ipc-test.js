'use strict';

/**
 * Linux isolated Electron renderer/IPC test for the session-file path.
 * Programmatic (hidden BrowserWindow + preload invoke), not a desktop driver
 * and not a real Chrome/Edge/Windows end-to-end test. Uses synthetic SNSS only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.disableHardwareAcceleration();

const isolated = process.env.TRACEHUB_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'tracehub-eipc-'));
fs.mkdirSync(isolated, { recursive: true });
app.setPath('userData', isolated);
process.env.TRACEHUB_USER_DATA = isolated;
process.env.TRACEHUB_DISABLE_SYNC = '1';

const reportPath = process.env.TRACEHUB_EIPC_REPORT || path.join(isolated, 'electron-session-ipc-report.json');

function writeAndExit(report, code) {
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  console.log(code === 0 ? 'TRACEHUB_EIPC_OK' : 'TRACEHUB_EIPC_FAIL');
  console.log('TRACEHUB_EIPC_REPORT=' + reportPath);
  app.exit(code);
}

app.whenReady().then(async () => {
  const report = {
    ok: false,
    mode: 'linux-electron-renderer-ipc',
    platform: process.platform,
    electron: process.versions.electron || null,
    userData: isolated,
    notClaimed: [
      'Not a Windows install test',
      'Not a real Chrome/Edge session-file or GUI click test',
    ],
  };
  try {
    const { Store } = require('../src/main/store');
    const snap = require('../src/main/snapshot-store');
    const sessionFile = require('../src/main/session-file-service');
    const { sampleTwoWindows } = require('../src/shared/snss-sample');
    const core = require('../src/shared/snapshot-core');

    const root = path.join(isolated, 'synthetic-chrome');
    fs.mkdirSync(path.join(root, 'Default', 'Sessions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Default', 'Sessions', 'Session_1'), sampleTwoWindows());
    const roots = [{ id: 'chrome', name: 'Google Chrome', base: root }];

    const store = new Store(path.join(isolated, 'hub.sqlite'));
    await store.init();
    snap.migrateSnapshotTables(store.db);
    sessionFile.setSessionFileRuntime({
      roots,
      spawnFn: async () => ({ ok: true }),
      resolveExeFn: () => '/usr/bin/google-chrome',
    });
    sessionFile.registerSessionFileIpc({ ipcMain, store });

    const html = path.join(isolated, 'ipc-probe.html');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>TraceHub IPC probe</title><p>probe</p>');
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(__dirname, '../src/main/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(html);
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const api = window.api;
        if (!api || !api.sessionFileListProfiles) return { ok: false, error: 'preload api missing' };
        const list = await api.sessionFileListProfiles();
        const key = list && list.profiles && list.profiles[0] && list.profiles[0].key;
        const preview = key ? await api.sessionFilePreview(key) : { ok: false, error: 'no profile' };
        const saved = (preview && preview.ok && preview.previewId)
          ? await api.sessionFileSave({ previewId: preview.previewId, confirmed: true })
          : { ok: false, error: 'no previewId' };
        return {
          ok: !!(list && list.ok && preview && preview.ok && saved && saved.ok),
          listOk: !!(list && list.ok),
          profileKey: key || null,
          previewOk: !!(preview && preview.ok),
          tabCount: preview && preview.tabCount,
          savedOk: !!(saved && saved.ok),
          source: saved && saved.snapshot && saved.snapshot.source,
          tabIdNull: !!(saved && saved.snapshot && saved.snapshot.windows && saved.snapshot.windows[0] && saved.snapshot.windows[0].tabs.every((t) => t.tabId == null)),
          error: (list && list.error) || (preview && preview.error) || (saved && saved.error) || null,
        };
      })()
    `);
    const loaded = snap.listSnapshots(store);
    const snapRow = loaded[0];
    const gate = snapRow ? core.assertCloseable(snapRow, { userConfirmed: true, ackUnsavedRisk: true }) : { ok: false, error: 'no snapshot' };
    report.result = result;
    report.closeRefused = !gate.ok;
    report.ok = !!(result && result.ok && result.source === 'session-file' && result.tabIdNull && !gate.ok);
    if (!report.ok) report.error = (result && result.error) || gate.error || 'ipc chain failed';
    try { win.destroy(); } catch (e) { /* ignore */ }
    try { sessionFile.clearSessionFileRuntime(); } catch (e) { /* ignore */ }
    try { store.close(); } catch (e) { /* ignore */ }
    writeAndExit(report, report.ok ? 0 : 1);
  } catch (e) {
    report.error = e && e.stack ? e.stack : (e.message || String(e));
    writeAndExit(report, 1);
  }
}).catch((e) => {
  writeAndExit({ ok: false, error: e.message || String(e) }, 1);
});
