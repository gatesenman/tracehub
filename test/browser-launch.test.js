'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  EXTENSIONS_PAGES,
  FORBIDDEN_FLAGS,
  buildExtensionsPageLaunch,
  assertSafeLaunchArgs,
  resolveExecutable,
  openExtensionsManagementPage,
} = require('../src/main/browser-launch');

describe('open official extensions page (legal sideload helper)', () => {
  it('only launches chrome://extensions or edge://extensions with no extra flags', () => {
    const chrome = buildExtensionsPageLaunch('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.equal(chrome.ok, true);
    assert.deepEqual(chrome.args, [EXTENSIONS_PAGES.chrome]);
    assert.equal(chrome.args.length, 1);
    const edge = buildExtensionsPageLaunch('edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    assert.deepEqual(edge.args, [EXTENSIONS_PAGES.edge]);
    assert.equal(buildExtensionsPageLaunch('firefox', '/usr/bin/firefox').ok, false);
  });

  it('rejects debugging or silent-load flags', () => {
    assert.doesNotThrow(() => assertSafeLaunchArgs(['chrome://extensions']));
    for (const flag of FORBIDDEN_FLAGS) {
      assert.throws(() => assertSafeLaunchArgs([flag, 'chrome://extensions']), /拒绝/);
      assert.throws(() => assertSafeLaunchArgs([`${flag}=/tmp/ext`]), /拒绝/);
    }
  });

  it('resolves a known Chrome path when the file exists, and reports a clear error otherwise', async () => {
    const found = resolveExecutable('chrome', {
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      existsFn: (p) => String(p).replace(/\\/g, '/').endsWith('Google/Chrome/Application/chrome.exe'),
    });
    assert.ok(found);
    assert.match(String(found).replace(/\\/g, '/'), /Google\/Chrome\/Application\/chrome\.exe$/);

    const missing = await openExtensionsManagementPage('chrome', {
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\x',
      },
      existsFn: () => false,
      whichFn: () => null,
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /未找到/);
    assert.match(missing.error, /chrome:\/\/extensions/);
  });

  it('spawns the browser with only the official page and never attaches a debugger', async () => {
    const calls = [];
    const r = await openExtensionsManagementPage('edge', {
      platform: 'linux',
      existsFn: () => false,
      whichFn: (cmd) => (cmd === 'microsoft-edge' ? '/usr/bin/microsoft-edge' : null),
      spawnFn: (exe, args, opts) => {
        calls.push({ exe, args, opts });
        return { unref() {} };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.launched, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, '/usr/bin/microsoft-edge');
    assert.deepEqual(calls[0].args, ['edge://extensions']);
    assert.equal(calls[0].opts.detached, true);
    assert.match(r.note, /不会替你静默安装/);
  });
});
