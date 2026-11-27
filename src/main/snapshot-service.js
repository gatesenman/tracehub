'use strict';

const path = require('path');
const fs = require('fs');
const { TabBridge } = require('./tab-bridge');
const snap = require('./snapshot-store');
const core = require('../shared/snapshot-core');
const { isRestorableUrl, sanitizeAiList } = require('../shared/close-guard');
const extSession = require('../shared/extension-session');
const sessionFile = require('./session-file-service');

function extensionDir(app) {
  if (app && app.isPackaged) return path.join(process.resourcesPath, 'extension');
  return path.join(__dirname, '..', '..', 'extension');
}

async function startBridge(config, store, { onSnapshotSaved } = {}) {
  if (!config.get().bridgeEnabled) return null;
  const commandMeta = new Map();
  const bridge = new TabBridge({
    port: (config.get().bridgePort == null || config.get().bridgePort === '') ? 17862 : Number(config.get().bridgePort),

    getToken: () => config.get().bridgeToken,
    onSnapshot: async (raw, meta) => {
      try {
        const saved = snap.saveSnapshot(store, raw, {
          source: 'extension',
          browserId: meta && meta.browserId,
          extensionId: meta && meta.extensionId,
          audienceBrowser: meta && meta.browserId,
        });
        if (onSnapshotSaved) onSnapshotSaved(saved);
        return {
          ok: true,
          snapshotId: saved.id,
          tabCount: saved.tabCount,
          title: saved.title,
          message: `已保存 ${saved.tabCount} 个页签。默认不会关闭浏览器。`,
        };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    onCommandResult: async (body) => {
      if (!body || !body.commandId) return;
      const sid = body.snapshotId || (commandMeta.get(body.commandId) || {}).snapshotId;
      if (body.type === 'close' && sid) {
        const skipped = (body.skipped || []).length;
        const failed = (body.failed || []).length;
        const status = body.timedOut ? 'failed'
          : (body.ok && !failed && !skipped ? 'done'
          : (body.closedCount ? 'partial' : 'failed'));
        const detail = [body.message || body.error || '', skipped ? `${skipped} 个因地址变化或已不存在已跳过` : '']
          .filter(Boolean).join('；');
        snap.setCloseStatus(store, sid, status, detail);
      }
      if (body.type === 'restore' && sid) {
        const failedList = body.failed || [];
        const failedUrls = new Set(failedList.map((f) => f.url));
        const openedUrls = new Set((body.opened || []).map((o) => o.url));
        const current = snap.getSnapshot(store, sid);
        if (current) {
          for (const t of core.flattenTabs(current)) {
            if (t.restoreStatus === 'opened') continue;
            if (failedUrls.has(t.url)) {
              const fe = failedList.find((f) => f.url === t.url);
              snap.updateTabMeta(store, t.id, {
                restoreStatus: 'failed',
                restoreError: (fe && fe.error) || body.message || body.error || '扩展打开失败',
              });
            } else if (openedUrls.has(t.url)) {
              snap.updateTabMeta(store, t.id, { restoreStatus: 'opened', restoreError: '' });
            } else if (body.timedOut && t.restoreStatus === 'queued') {
              snap.updateTabMeta(store, t.id, {
                restoreStatus: 'failed',
                restoreError: body.message || '扩展未在有效期内打开页签（可能离线或未轮询）',
              });
            }
          }
        }
      }
      if (onSnapshotSaved) onSnapshotSaved({ id: sid, commandResult: body });
    },
  });
  if (store && typeof snap.clearStaleInFlight === 'function') {
    try {
      snap.clearStaleInFlight(store);
    } catch (e) { /* store may not have snapshot tables yet in some tests */ }
  }
  try {
    await bridge.start();
    if (bridge.listeningPort && config && typeof config.update === 'function') {
      const current = Number((config.get() || {}).bridgePort);
      if (current !== Number(bridge.listeningPort)) {
        config.update({ bridgePort: bridge.listeningPort });
      }
    }
    const rawEnqueue = bridge.enqueueCommand.bind(bridge);
    bridge.enqueueCommand = (type, payload, audience) => {
      const cmd = rawEnqueue(type, payload, audience);
      commandMeta.set(cmd.id, { ...(payload || {}), type });
      return cmd;
    };
    const tick = () => {
      try {
        const expired = bridge.expireStaleCommands();
        for (const cmd of expired) {
          const type = cmd.type || (commandMeta.get(cmd.id) || {}).type;
          bridge.onCommandResult({
            commandId: cmd.id,
            type,
            snapshotId: (cmd.payload || {}).snapshotId,
            ok: false,
            timedOut: true,
            opened: [],
            failed: [],
            closedCount: 0,
            message: type === 'close'
              ? '关闭指令已过期，扩展未在有效期内执行'
              : '扩展未在有效期内打开页签（可能离线或未轮询）',
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
    };
    bridge._expireTimer = setInterval(tick, 15000);
    if (typeof bridge._expireTimer.unref === 'function') bridge._expireTimer.unref();
    const rawStop = bridge.stop.bind(bridge);
    bridge.stop = async () => {
      if (bridge._expireTimer) { clearInterval(bridge._expireTimer); bridge._expireTimer = null; }
      return rawStop();
    };
    return bridge;
  } catch (e) {
    console.error('[tab-bridge] failed to start', e);
    return null;
  }
}

function registerSnapshotIpc({ ipcMain, store, config, getBridge, dialog, shell, ai, getMainWindow, app, getSync }) {
  const notify = (channel, payload) => {
    const w = getMainWindow && getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  ipcMain.handle('onboarding:complete', async (_e, payload) => {
    const profiles = Array.isArray(payload && payload.enabledProfiles) ? payload.enabledProfiles : [];
    const patch = {
      onboardingCompleted: true,
      enabledProfiles: profiles,
      thumbsEnabled: !!(payload && payload.thumbsEnabled),
      contentFetchEnabled: !!(payload && payload.contentFetchEnabled),
    };
    config.update(patch);
    const sync = getSync && getSync();
    if (sync) sync.syncOnce(true).catch((e) => console.error('post-onboarding sync', e));
    return { ok: true, config: publicSlice(config) };
  });

  ipcMain.handle('config:clear-keys', async () => {
    config.clearSecrets();
    return publicSlice(config);
  });

  ipcMain.handle('domain:count', async (_e, domain) => ({ count: snap.countByDomain(store, domain) }));

  ipcMain.handle('extension:open-dir', async () => {
    const dir = extensionDir(app);
    await shell.openPath(dir);
    return { ok: true, path: dir };
  });

  ipcMain.handle('extension:open-management-page', async (_e, browserId) => {
    const id = browserId === 'edge' ? 'edge' : (browserId === 'chrome' ? 'chrome' : '');
    if (!id) return { ok: false, error: '只支持为 Chrome 或 Edge 打开官方扩展管理页' };
    try {
      const { openExtensionsManagementPage } = require('./browser-launch');
      return await openExtensionsManagementPage(id);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('bridge:status', async () => {
    const b = getBridge && getBridge();
    return {
      enabled: !!config.get().bridgeEnabled,
      port: (b && b.listeningPort) || config.get().bridgePort || 17862,
      listening: !!(b && b.listeningPort),
      lastSeenAt: (b && b.lastSeenAt) || null,
      lastExtensionId: (b && b.lastExtensionId) || null,
      token: config.get().bridgeToken || '',
      extensionDir: extensionDir(app),
    };
  });

  ipcMain.handle('bridge:regen-token', async () => {
    const crypto = require('crypto');
    config.update({ bridgeToken: crypto.randomBytes(24).toString('base64url') });
    return publicSlice(config);
  });

  sessionFile.registerSessionFileIpc({ ipcMain, store });

  ipcMain.handle('snapshot:list', async () => snap.listSnapshots(store));
  ipcMain.handle('snapshot:get', async (_e, id) => snap.getSnapshot(store, id));
  ipcMain.handle('snapshot:delete', async (_e, id) => {
    snap.deleteSnapshot(store, id);
    return { ok: true };
  });

  ipcMain.handle('snapshot:import', async (_e, raw) => {
    try {
      const source = raw && raw.source === 'session-file' ? 'session-file' : 'file-import';
      const saved = snap.saveSnapshot(store, raw, { source, origin: raw && raw.origin });
      return { ok: true, snapshot: saved };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('snapshot:import-file', async () => {
    try {
      const w = getMainWindow && getMainWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(w || undefined, {
        title: '导入页签快照 JSON',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths.length) return { ok: false, cancelled: true };
      const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      const source = raw && raw.source === 'session-file' ? 'session-file' : 'file-import';
      const saved = snap.saveSnapshot(store, raw, { source, origin: raw && raw.origin });
      return { ok: true, snapshot: saved };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('snapshot:export', async (_e, id) => {
    const s = snap.getSnapshot(store, id);
    if (!s) return { ok: false, error: '找不到快照' };
    const w = getMainWindow && getMainWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(w || undefined, {
      defaultPath: `TraceHub-tabsnap-${id.slice(0, 8)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    const payload = sessionFile.exportableSnapshot(s);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('snapshot:rename-group', async (_e, { id, from, to }) => {
    snap.renameGroup(store, id, from, to);
    return snap.getSnapshot(store, id);
  });

  ipcMain.handle('snapshot:update-tab', async (_e, { tabId, patch }) => {
    snap.updateTabMeta(store, tabId, patch || {});
    return { ok: true };
  });

  ipcMain.handle('snapshot:request-close', async (_e, { id, userConfirmed, ackUnsavedRisk }) => {
    const s = snap.getSnapshot(store, id);
    const gate = core.assertCloseable(s, { userConfirmed, ackUnsavedRisk });
    if (!gate.ok) return { ok: false, error: gate.error, closeable: false };
    if (s.source !== 'extension' || !s.extensionId) {
      return {
        ok: false,
        error: s && s.source === 'session-file'
          ? '会话文件快照不能按 tabId 关闭浏览器里的页签。即使快照或导入的 JSON 带有 id，也不会发出关闭指令。请在浏览器中手动关闭，或使用配对扩展采集后再关闭。'
          : '这份快照不是由已配对的扩展写入的（或来自 JSON 导入），应用不能代为关闭浏览器页签。请在对应浏览器里手动关闭。快照仍然保留。',
        closeable: false,
        needsExtension: s && s.source === 'extension',
        via: 'none',
      };
    }
    const bridge = getBridge && getBridge();
    if (!bridge || !bridge.listeningPort) {
      return {
        ok: false,
        error: '本机桥接未运行。快照已保存，请你手动关闭浏览器窗口（推荐），或打开扩展后重试。应用不会在保存失败时关闭页签。',
        closeable: true,
        needsExtension: true,
      };
    }
    const expectedTabs = core.flattenTabs(s)
      .filter((t) => Number.isFinite(Number(t.tabId)))
      .map((t) => ({ tabId: t.tabId, url: t.url, windowId: t.windowId, title: t.title }));
    if (!expectedTabs.length) {
      return { ok: false, error: '快照里没有可核对的页签 ID，拒绝关闭以免误关。' };
    }
    const audience = { extensionId: s.extensionId, browserId: s.audienceBrowser || s.browserId };
    const payload = { snapshotId: s.id, expectedTabs, audience };
    const cmd = bridge.enqueueCommand('close', payload, audience);
    snap.setCloseStatus(store, s.id, 'pending', '');
    const queued = extSession.describeQueuedCommand({
      kind: 'close',
      recentlySeen: extSession.isRecentlySeen(bridge.lastSeenAt),
      lastExtensionId: bridge.lastExtensionId,
      expectedExtensionId: s.extensionId,
      batchCount: expectedTabs.length,
    });
    return {
      ok: true,
      pending: true,
      commandId: cmd.id,
      tabCount: expectedTabs.length,
      expiresAt: cmd.expiresAt,
      extensionRecentlySeen: queued.recentlySeen,
      extensionMismatch: queued.extensionMismatch,
      message: queued.message,
    };
  });

  ipcMain.handle('snapshot:cancel-close', async (_e, id) => {
    const bridge = getBridge && getBridge();
    if (bridge && typeof bridge.cancelCommandsFor === 'function') bridge.cancelCommandsFor(id, 'close');
    const s = snap.setCloseStatus(store, id, 'cancelled', '用户取消');
    return { ok: true, snapshot: s };
  });

  ipcMain.handle('snapshot:restore-plan', async (_e, { id, group, skipDuplicates, batchSize, offset }) => {
    const s = snap.getSnapshot(store, id);
    if (!s || !s.persisted) return { ok: false, error: '找不到已保存的快照' };
    if (s.source === 'session-file') return sessionFile.sessionFileRestorePlan(s);
    let tabs = core.flattenTabs(s);
    if (group) tabs = tabs.filter((t) => (t.userGroup || t.category) === group);
    const plan = core.batchRestorePlan(tabs, { batchSize, offset, skipDuplicates: !!skipDuplicates });
    return { ok: true, plan, limitation: plan.limitation, snapshotTitle: s.title };
  });

  ipcMain.handle('snapshot:restore-batch', async (_e, { id, group, skipDuplicates, batchSize, offset, confirmed, largeConfirmed }) => {
    if (!confirmed) return { ok: false, error: '恢复已取消' };
    const s = snap.getSnapshot(store, id);
    if (!s || !s.persisted) return { ok: false, error: '找不到已保存的快照' };
    let tabs = core.flattenTabs(s);
    if (group) tabs = tabs.filter((t) => (t.userGroup || t.category) === group);
    const plan = core.batchRestorePlan(tabs, { batchSize, offset, skipDuplicates: !!skipDuplicates });
    if (s.source === 'session-file') {
      const r = await sessionFile.restoreSessionFileSnapshot(s, { store, largeConfirmed: !!largeConfirmed });
      return {
        ok: !!r.ok,
        pending: false,
        via: r.via || 'session-file-window-reopen',
        error: r.ok ? undefined : (r.error || r.message),
        message: r.message,
        plan: r.plan || plan,
        limitation: (r.plan && r.plan.limitation) || plan.limitation,
        opened: r.opened,
        failed: r.failed,
        snapshot: r.snapshot,
      };
    }
    const bridge = getBridge && getBridge();
    if (!s.extensionId) {
      return {
        ok: false,
        via: 'none',
        pending: false,
        error: '这份快照没有对应的扩展会话，不能在来源浏览器里按窗口/分组/固定页签恢复。也不会改用系统默认浏览器（以免打开到错误的配置，或在没有默认浏览器时伪造成功）。请用当初保存它的配对扩展重新采集，或仅查看/导出网址。',
        plan,
      };
    }
    if (!bridge || !bridge.listeningPort) {
      return {
        ok: false,
        via: 'none',
        pending: false,
        error: '本机桥接未运行，无法通知配对扩展在来源浏览器中恢复。不会改用系统默认浏览器。请确认 TraceHub 正在运行后重试。',
        plan,
      };
    }
    const byWindow = new Map();
    for (const t of plan.batch) {
      const key = t.windowRowId || String(t.windowIndex || 0);
      if (!byWindow.has(key)) {
        const w = (s.windows || []).find((x) => x.id === t.windowRowId) || {};
        byWindow.set(key, { ...w, tabs: [] });
      }
      byWindow.get(key).tabs.push(t);
    }
    const windows = Array.from(byWindow.values()).map((w) => ({
      ...w,
      tabs: (w.tabs || []).filter((t) => isRestorableUrl(t.url)),
    })).filter((w) => w.tabs.length);
    const audience = { extensionId: s.extensionId, browserId: s.audienceBrowser || s.browserId };
    const cmd = bridge.enqueueCommand('restore', { snapshotId: s.id, windows }, audience);
    for (const tab of plan.batch) {
      if (tab.id) snap.updateTabMeta(store, tab.id, { restoreStatus: 'queued', restoreError: '' });
    }
    const queued = extSession.describeQueuedCommand({
      kind: 'restore',
      recentlySeen: extSession.isRecentlySeen(bridge.lastSeenAt),
      lastExtensionId: bridge.lastExtensionId,
      expectedExtensionId: s.extensionId,
      batchCount: plan.batch.length,
      total: plan.total,
      remaining: plan.remaining,
    });
    return {
      ok: true,
      pending: true,
      via: 'extension',
      commandId: cmd.id,
      plan,
      extensionRecentlySeen: queued.recentlySeen,
      extensionMismatch: queued.extensionMismatch,
      message: queued.message,
    };
  });

  ipcMain.handle('snapshot:ai', async (_e, { id, includeBody }) => {
    const s = snap.getSnapshot(store, id);
    if (!s) return { ok: false, error: '找不到快照' };
    const local = core.flattenTabs(s);
    const cfg = config.get().ai || {};
    snap.setAiStatus(store, id, 'pending', '');
    try {
      if (!ai.hasKey(cfg)) {
        const classified = core.localPreCategorize(local);
        snap.applyTabPatches(store, id, classified);
        snap.setAiStatus(store, id, 'local', '未配置 AI Key，已保留本地域名预分类');
        return { ok: true, usedAI: false, snapshot: snap.getSnapshot(store, id) };
      }
      const payload = core.minimizeAiPayload(local, { includeBody: !!includeBody });
      const allowed = payload.map((p) => p.url);
      const organized = sanitizeAiList(await ai.aiOrganize(cfg, payload), allowed);
      let enriched = [];
      try {
        enriched = sanitizeAiList(await ai.aiEnrich(cfg, payload), allowed);
      } catch (e) {
        enriched = [];
      }
      const combined = (organized || []).map((o) => {
        const en = (enriched || []).find((x) => x.url === o.url) || {};
        return { ...o, summary: en.summary || '', purpose: o.purpose || o.category, tags: o.tags };
      });
      const merged = core.mergeAiResults(core.localPreCategorize(local), combined, { failed: false });
      snap.applyTabPatches(store, id, merged.tabs);
      snap.setAiStatus(store, id, 'done', '');
      return { ok: true, usedAI: true, snapshot: snap.getSnapshot(store, id), sent: { fields: includeBody ? 'url,title,optional-body' : 'url,title' } };
    } catch (e) {
      const merged = core.mergeAiResults(core.localPreCategorize(local), [], { failed: true, error: e.message || String(e) });
      snap.applyTabPatches(store, id, merged.tabs);
      snap.setAiStatus(store, id, 'failed', merged.error);
      return { ok: false, usedAI: true, error: merged.error, snapshot: snap.getSnapshot(store, id) };
    }
  });

  return { notify };
}

function publicSlice(config) {
  const c = config.get();
  return {
    onboardingCompleted: !!c.onboardingCompleted,
    liveTabPermissionPrompted: !!c.liveTabPermissionPrompted,
    enabledProfiles: c.enabledProfiles,
    thumbsEnabled: !!c.thumbsEnabled,
    contentFetchEnabled: !!c.contentFetchEnabled,
    bridgeEnabled: c.bridgeEnabled !== false,
    bridgePort: c.bridgePort || 17862,
    bridgeToken: c.bridgeToken || '',
  };
}

module.exports = { startBridge, registerSnapshotIpc, extensionDir, publicSlice };
