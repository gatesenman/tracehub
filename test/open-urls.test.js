'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openHttpUrlList } = require('../src/shared/open-urls');

describe('openHttpUrlList (default-browser degraded path)', () => {
  it('skips non-http URLs, caps at 30, and records opener failures', async () => {
    const seen = [];
    const r = await openHttpUrlList(
      ['https://example.com/', 'javascript:alert(1)', 'https://example.org/', 'file:///tmp/x'],
      async (url) => {
        seen.push(url);
        if (url.includes('example.org')) return { ok: false, error: 'no default browser' };
        return { ok: true };
      },
    );
    assert.deepEqual(seen, ['https://example.com/', 'https://example.org/']);
    assert.equal(r.opened, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.ok, false);
    assert.equal(r.via, 'system-default-browser');
    assert.match(r.message, /不是扩展按布局恢复/);
    assert.equal(r.failedUrls[0].error, 'no default browser');
  });

  it('reports full success only when every allowed URL opens', async () => {
    const r = await openHttpUrlList(['https://example.com/'], async () => ({ ok: true }));
    assert.equal(r.ok, true);
    assert.equal(r.opened, 1);
    assert.equal(r.failed, 0);
  });
});
