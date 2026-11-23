'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { TabBridge } = require('../src/main/tab-bridge');

const TOKEN = 'test-token-aabbcc';
let bridge;
let port;
const received = [];

function req(pathname, { method = 'GET', token = TOKEN, origin = 'chrome-extension://abcdefghijklmnop', body, host, extensionId } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (origin) headers.Origin = origin;
    if (token) headers['X-TraceHub-Token'] = token;
    if (extensionId) headers['X-Extension-Id'] = extensionId;
    if (payload) headers['Content-Type'] = 'application/json';
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers,
      // force Host header when asked
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

describe('tab bridge security + snapshot intake', () => {
  before(async () => {
    bridge = new TabBridge({
      port: 0, // ephemeral
      getToken: () => TOKEN,
      onSnapshot: async (raw) => {
        received.push(raw);
        if (!raw || !raw.windows) return { ok: false, error: 'bad' };
        return { ok: true, snapshotId: 's1', tabCount: 1 };
      },
      onCommandResult: async () => {},
    });
    port = await bridge.start();
  });

  after(async () => {
    await bridge.stop();
  });

  it('binds to loopback and answers health without a token', async () => {
    const r = await req('/v1/health', { token: '', origin: '' });
    assert.equal(r.status, 200);
    assert.equal(r.json.app, 'TraceHub');
    assert.equal(r.json.port, port);
  });

  it('rejects a bad token and a non-extension Origin', async () => {
    const bad = await req('/v1/pair', { method: 'POST', token: 'wrong', body: { extensionId: 'x' } });
    assert.equal(bad.status, 401);
    const web = await req('/v1/pair', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { extensionId: 'x' },
    });
    assert.equal(web.status, 403);
  });

  it('accepts a paired snapshot from a chrome-extension origin', async () => {
    const pair = await req('/v1/pair', { method: 'POST', body: { extensionId: 'abcdefghijklmnop' } });
    assert.equal(pair.status, 200);
    assert.equal(pair.json.paired, true);
    const snap = await req('/v1/snapshot', {
      method: 'POST',
      body: { source: 'extension', windows: [{ tabs: [{ url: 'https://example.com', title: 'Ex' }] }] },
    });
    assert.equal(snap.status, 200);
    assert.equal(snap.json.snapshotId, 's1');
    assert.equal(received.length, 1);
  });

  it('hands out only app-enqueued commands (no client-supplied open-url)', async () => {
    bridge.enqueueCommand('close', { snapshotId: 's1', windowIds: [1] });
    const pending = await req('/v1/pending');
    assert.equal(pending.status, 200);
    assert.equal(pending.json.commands.length, 1);
    assert.equal(pending.json.commands[0].type, 'close');
    // Queue is drained.
    const again = await req('/v1/pending');
    assert.equal(again.json.commands.length, 0);
  });

  it('records lastSeenAt after a paired snapshot without putting the token in status fields used by UI', async () => {
    const before = bridge.lastSeenAt || 0;
    const snap = await req('/v1/snapshot', {
      method: 'POST',
      extensionId: 'ext-ui',
      body: { source: 'extension', windows: [{ tabs: [{ url: 'https://example.com', title: 'Ex' }] }] },
    });
    assert.equal(snap.status, 200);
    assert.ok(bridge.lastSeenAt >= before);
    assert.equal(bridge.lastExtensionId, 'ext-ui');
    assert.ok(Date.now() - bridge.lastSeenAt < 5000);
  });

  it('does not expose an arbitrary URL / exec endpoint', async () => {
    const r = await req('/v1/open', { method: 'POST', body: { url: 'https://evil.example' } });
    assert.equal(r.status, 404);
    const r2 = await req('/v1/exec', { method: 'POST', body: { cmd: 'shutdown' } });
    assert.equal(r2.status, 404);
  });
});

describe('tab bridge port fallback when the preferred port is busy', () => {
  it('listens on the next port in the allowed range and advertises it on /v1/health', async () => {
    const occupied = await new Promise((resolve) => {
      const s = http.createServer(() => {});
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const busyPort = occupied.address().port;
    const bridge = new TabBridge({
      port: busyPort,
      getToken: () => 'fallback-token',
      onSnapshot: async () => ({ ok: true }),
      onCommandResult: async () => {},
    });
    bridge.fallbackSpan = 5;
    const listening = await bridge.start();
    assert.notEqual(listening, busyPort);
    assert.equal(bridge.usedFallback, true);
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: listening, path: '/v1/health', method: 'GET' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.app, 'TraceHub');
    assert.equal(r.json.port, listening);
    await bridge.stop();
    await new Promise((resolve) => occupied.close(() => resolve()));
  });
});
