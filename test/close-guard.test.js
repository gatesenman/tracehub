'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/shared/close-guard');
const extGuard = require('../extension/close-guard.js');

describe('close-guard (shared + extension copy)', () => {
  it('keeps the extension copy in sync with src/shared', () => {
    assert.equal(typeof extGuard.planCloseTargets, 'function');
    assert.equal(extGuard.COMMAND_TTL_MS, guard.COMMAND_TTL_MS);
  });

  it('matches URLs ignoring trailing slash and hash', () => {
    assert.equal(guard.urlsMatch('https://example.com/a', 'https://example.com/a#section'), true);
    assert.equal(guard.urlsMatch('https://example.com/a/', 'https://example.com/a'), true);
    assert.equal(guard.urlsMatch('https://example.com/a', 'https://example.com/b'), false);
  });

  it('refuses to close when the live tab is missing, navigated, or the id was reused', () => {
    const expected = { tabId: 12, url: 'https://example.com/edit' };
    assert.equal(guard.matchTabForClose(expected, null).reason, 'missing');
    assert.equal(guard.matchTabForClose(expected, { id: 12, url: 'https://other.example/' }).reason, 'url-changed');
    assert.equal(guard.matchTabForClose(expected, { id: 99, url: expected.url }).reason, 'id-mismatch');
    assert.equal(guard.matchTabForClose(expected, { id: 12, url: 'https://example.com/edit#x' }).ok, true);
  });

  it('plans a mixed close: only matching tabs are closable', () => {
    const plan = guard.planCloseTargets(
      [
        { tabId: 1, url: 'https://a.example/' },
        { tabId: 2, url: 'https://b.example/' },
        { tabId: 3, url: 'https://c.example/' },
      ],
      [
        { id: 1, url: 'https://a.example/' },
        { id: 2, url: 'https://b.example/changed' },
        // 3 missing; a reused id 3 would have a different url
      ]
    );
    assert.equal(plan.closable.length, 1);
    assert.equal(plan.closable[0].expected.tabId, 1);
    assert.equal(plan.skipped.length, 2);
    assert.ok(plan.skipped.some((s) => s.reason === 'url-changed'));
    assert.ok(plan.skipped.some((s) => s.reason === 'missing'));
  });

  it('expires commands after the 3 minute TTL', () => {
    const created = 1_000_000;
    assert.equal(guard.commandExpired(created, created + 60_000), false);
    assert.equal(guard.commandExpired(created, created + 3 * 60 * 1000 + 1), true);
    assert.equal(guard.commandExpired(0, Date.now()), true);
  });

  it('requires a matching extension/browser when the command is scoped', () => {
    const cmd = { audience: { extensionId: 'ext-a', browserId: 'edge' } };
    assert.equal(guard.audienceMatches(cmd, { extensionId: 'ext-a', browserId: 'edge' }), true);
    assert.equal(guard.audienceMatches(cmd, { extensionId: 'ext-b', browserId: 'edge' }), false);
    assert.equal(guard.audienceMatches(cmd, { extensionId: '', browserId: 'edge' }), false);
    assert.equal(guard.audienceMatches(cmd, { extensionId: 'ext-a', browserId: 'chrome' }), false);
    assert.equal(guard.audienceMatches({ audience: {} }, { extensionId: 'x' }), true);
  });

  it('only restores http(s) and rejects javascript/data/file/about', () => {
    assert.equal(guard.isRestorableUrl('https://ok.example/a'), true);
    assert.equal(guard.isRestorableUrl('http://ok.example/a'), true);
    assert.equal(guard.isRestorableUrl('javascript:alert(1)'), false);
    assert.equal(guard.isRestorableUrl('data:text/html,hi'), false);
    assert.equal(guard.isRestorableUrl('file:///etc/passwd'), false);
    assert.equal(guard.isRestorableUrl('about:blank'), false);
    assert.equal(guard.isUnsafeUrl('vbscript:msg'), true);
  });

  it('does not combine maximized/minimized with window bounds when restoring', () => {
    const urls = ['https://example.com/', 'https://example.org/'];
    const attempts = guard.buildWindowCreateAttempts({
      state: 'maximized', left: 0, top: 0, width: 1920, height: 1159,
    }, urls);
    assert.ok(attempts.length >= 2);
    const first = attempts[0];
    assert.equal(first.state, 'maximized');
    assert.equal(first.left, undefined);
    assert.equal(first.top, undefined);
    assert.equal(first.width, undefined);
    assert.equal(first.height, undefined);
    assert.deepEqual(first.url, urls);
    const lastPlain = attempts.find((a) => !a.state && a.left == null && Array.isArray(a.url) && a.url.length === 2);
    assert.ok(lastPlain, 'must include a bounds-free urls-only fallback');
  });

  it('sanitizes AI items and drops URLs outside the allow-list', () => {
    const items = [
      { url: 'https://ok.example', category: 'x'.repeat(80), summary: 's'.repeat(500), tags: ['a', 'b', 3, '', 'z'.repeat(50)] },
      { url: 'https://evil.example', category: 'nope' },
      'not-an-object',
      null,
    ];
    const out = guard.sanitizeAiList(items, ['https://ok.example']);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://ok.example');
    assert.ok(out[0].category.length <= 40);
    assert.ok(out[0].summary.length <= 400);
    assert.ok(out[0].tags.every((t) => t.length <= 40));
  });
});
