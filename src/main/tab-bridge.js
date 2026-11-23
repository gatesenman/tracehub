'use strict';

/**
 * Local-only paired bridge between the TraceHub desktop app and the
 * companion Chrome/Edge extension.
 *
 * - Binds exclusively to 127.0.0.1 (never 0.0.0.0)
 * - Every mutating / command endpoint requires the pairing token
 * - Origin must be a browser-extension scheme (or a same-machine file import
 *   is used instead — this server is optional)
 * - No arbitrary URL open, no shell, no eval, no cookie access
 */

const http = require('http');
const crypto = require('crypto');
const { commandExpired, audienceMatches, COMMAND_TTL_MS } = require('../shared/close-guard');

const ALLOWED_ORIGIN = /^(chrome-extension|moz-extension|ms-browser-extension|safari-web-extension):\/\//i;
const MAX_BODY = 5 * 1024 * 1024;
const DEFAULT_PORT = 17862;

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function requestHost(req) {
  const raw = String(req.headers.host || '');
  return raw.split(':')[0].toLowerCase();
}

class TabBridge {
  constructor({
    port = DEFAULT_PORT,
    getToken = () => '',
    onSnapshot = async () => ({ ok: false, error: 'not wired' }),
    onCommandResult = async () => {},
    getPending = () => [],
  } = {}) {
    const n = Number(port);
    this.port = Number.isFinite(n) && n >= 0 ? n : DEFAULT_PORT;

    this.getToken = getToken;
    this.onSnapshot = onSnapshot;
    this.onCommandResult = onCommandResult;
    this.getPending = getPending;
    this.server = null;
    this.paired = new Set(); // extension ids after successful pair
    this.commands = []; // { id, type, payload, createdAt, audience, expiresAt, delivered }
    this.executedIds = new Set(); // idempotency: never re-deliver an acked command
    this.listeningPort = null;
    this.lastSeenAt = null;
    this.lastExtensionId = null;
  }

  noteClient(req, extraId) {
    this.lastSeenAt = Date.now();
    const id = String(extraId || (req && req.headers && req.headers['x-extension-id']) || '').slice(0, 128);
    if (id) this.lastExtensionId = id;
  }

  enqueueCommand(type, payload, audience = {}) {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const cmd = {
      id,
      type,
      payload: payload || {},
      audience: audience || {},
      createdAt,
      expiresAt: createdAt + COMMAND_TTL_MS,
      delivered: false,
    };
    // A new close/restore for the same snapshot replaces an undelivered one.
    const snapId = cmd.payload.snapshotId;
    if (snapId) {
      this.commands = this.commands.filter((c) => !(c.type === type && c.payload && c.payload.snapshotId === snapId && !c.delivered));
    }
    this.commands.push(cmd);
    if (this.commands.length > 20) this.commands.splice(0, this.commands.length - 20);
    return cmd;
  }

  takeCommands(viewer = {}) {
    const now = Date.now();
    const expired = [];
    const ready = [];
    const keep = [];
    const extra = this.getPending() || [];
    for (const cmd of [...this.commands, ...extra]) {
      if (this.executedIds.has(cmd.id)) continue;
      if (commandExpired(cmd.createdAt, now, (cmd.expiresAt && cmd.expiresAt - cmd.createdAt) || COMMAND_TTL_MS)) {
        expired.push(cmd);
        continue;
      }
      if (!audienceMatches(cmd, viewer)) {
        keep.push(cmd);
        continue;
      }
      if (cmd.delivered) {
        // Delivered once; wait for ack. Do not re-send (avoids double close).
        keep.push(cmd);
        continue;
      }
      cmd.delivered = true;
      cmd.deliveredAt = now;
      ready.push(cmd);
      keep.push(cmd);
    }
    this.commands = keep;
    this._lastExpired = expired;
    return { commands: ready, expired };
  }

  ackCommand(commandId) {
    const id = String(commandId || '');
    if (!id) return false;
    this.executedIds.add(id);
    this.commands = this.commands.filter((c) => c.id !== id);
    return true;
  }

  expireStaleCommands(now = Date.now()) {
    const expired = [];
    const keep = [];
    for (const cmd of this.commands) {
      if (commandExpired(cmd.createdAt, now, (cmd.expiresAt && cmd.expiresAt - cmd.createdAt) || COMMAND_TTL_MS)) {
        expired.push(cmd);
        this.executedIds.add(cmd.id);
      } else {
        keep.push(cmd);
      }
    }
    this.commands = keep;
    this._lastExpired = expired;
    return expired;
  }

  cancelCommandsFor(snapshotId, type) {
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => {
      if (c.payload && c.payload.snapshotId === snapshotId && (!type || c.type === type) && !this.executedIds.has(c.id)) {
        this.executedIds.add(c.id); // treat as consumed so a late poll cannot run it
        return false;
      }
      return true;
    });
    return before !== this.commands.length;
  }

  hasPendingFor(snapshotId, type) {
    const now = Date.now();
    return this.commands.some((c) =>
      c.type === type &&
      c.payload && c.payload.snapshotId === snapshotId &&
      !this.executedIds.has(c.id) &&
      !commandExpired(c.createdAt, now)
    );
  }

  async _listen(port) {
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        const status = err.status || 500;
        this._send(res, status, { ok: false, error: err.message || 'internal error' }, req);
      });
    });
    this.server = server;
    await new Promise((resolve, reject) => {
      const onErr = (err) => {
        try { server.close(); } catch (e) { /* ignore */ }
        reject(err);
      };
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', (err) => {
        server.off('error', onErr);
        if (err) {
          try { server.close(); } catch (e) { /* ignore */ }
          reject(err);
        } else resolve();
      });
    });
    this.listeningPort = this.server.address().port;
    this.server.on('error', (err) => console.error('[tab-bridge]', err));
    return this.listeningPort;
  }

  async start() {
    if (this.server) return this.listeningPort;
    const preferred = Number(this.port);
    if (!Number.isFinite(preferred) || preferred < 0) {
      const err = new Error('页签桥端口无效');
      err.code = 'EINVAL';
      throw err;
    }
    if (preferred === 0) {
      this.usedFallback = false;
      return this._listen(0);
    }
    const span = this.fallbackSpan == null ? 10 : Number(this.fallbackSpan);
    let lastErr = null;
    for (let p = preferred; p <= preferred + Math.max(0, span); p++) {
      try {
        await this._listen(p);
        this.preferredPort = preferred;
        this.usedFallback = this.listeningPort !== preferred;
        return this.listeningPort;
      } catch (e) {
        this.server = null;
        this.listeningPort = null;
        lastErr = e;
        if (e && e.code !== 'EADDRINUSE') throw e;
      }
    }
    const err = lastErr || new Error('无法在本机监听页签桥端口');
    throw err;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    if (!server) return;
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch (e) { /* ignore */ }
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }

  _cors(req) {
    const origin = String(req.headers.origin || '');
    if (ALLOWED_ORIGIN.test(origin)) return origin;
    return null;
  }

  _send(res, status, body, req) {
    const origin = req ? this._cors(req) : null;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-TraceHub-Token, X-Extension-Id, X-TraceHub-Browser';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  _authorized(req) {
    const host = requestHost(req);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      const err = new Error('只接受本机回环地址');
      err.status = 403;
      throw err;
    }
    const origin = String(req.headers.origin || '');
    // Same-machine tests may omit Origin; a browser "null" origin is not allowed.
    if (origin && !ALLOWED_ORIGIN.test(origin)) {
      const err = new Error('拒绝非扩展来源');
      err.status = 403;
      throw err;
    }
    const expected = String(this.getToken() || '');
    if (!expected) {
      const err = new Error('配对令牌未配置');
      err.status = 401;
      throw err;
    }
    const headerTok = String(req.headers['x-tracehub-token'] || '');
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const token = headerTok || bearer;
    if (!timingSafeEqualStr(token, expected)) {
      const err = new Error('配对令牌无效');
      err.status = 401;
      throw err;
    }
    return true;
  }

  async _handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      if (!this._cors(req) && req.headers.origin) {
        this._send(res, 403, { ok: false, error: '拒绝非扩展来源' }, req);
        return;
      }
      this._send(res, 204, { ok: true }, req);
      return;
    }

    if (req.method === 'GET' && (path === '/v1/health' || path === '/health')) {
      // Unauthenticated liveness only — no token, no commands, no paths.
      this._send(res, 200, { ok: true, app: 'TraceHub', bridge: true, port: this.listeningPort }, req);
      return;
    }

    this._authorized(req);
    this.noteClient(req);

    const parseJson = async () => {
      const raw = await readBody(req);
      if (!raw) return {};
      try { return JSON.parse(raw); }
      catch (e) {
        const err = new Error('畸形 JSON');
        err.status = 400;
        throw err;
      }
    };

    if (req.method === 'POST' && path === '/v1/pair') {
      const body = await parseJson();
      const extId = String(body.extensionId || req.headers['x-extension-id'] || '').slice(0, 128);
      if (extId) this.paired.add(extId);
      this.noteClient(req, extId);
      this._send(res, 200, {
        ok: true,
        app: 'TraceHub',
        port: this.listeningPort,
        paired: true,
        extensionId: extId || null,
        note: '已配对。快照只会保存在本机。',
      }, req);
      return;
    }

    if (req.method === 'POST' && path === '/v1/snapshot') {
      const raw = await parseJson();
      const result = await this.onSnapshot(raw, {
        extensionId: String(req.headers['x-extension-id'] || raw.extensionId || ''),
        browserId: raw.browser && raw.browser.id,
      });
      this._send(res, result.ok ? 200 : 400, result, req);
      return;
    }

    if (req.method === 'GET' && path === '/v1/pending') {
      const viewer = {
        extensionId: String(req.headers['x-extension-id'] || url.searchParams.get('extensionId') || ''),
        browserId: String(req.headers['x-tracehub-browser'] || url.searchParams.get('browserId') || ''),
      };
      const { commands, expired } = this.takeCommands(viewer);
      this._send(res, 200, { ok: true, commands, expired: (expired || []).map((c) => c.id) }, req);
      return;
    }

    if (req.method === 'POST' && path === '/v1/command-result') {
      const body = await parseJson();
      if (body && body.commandId) this.ackCommand(body.commandId);
      await this.onCommandResult(body);
      this._send(res, 200, { ok: true }, req);
      return;
    }

    this._send(res, 404, { ok: false, error: 'unknown endpoint' }, req);
  }
}

module.exports = { TabBridge, DEFAULT_PORT, ALLOWED_ORIGIN, timingSafeEqualStr };
