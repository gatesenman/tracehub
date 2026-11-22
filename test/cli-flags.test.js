'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLaunchFlags } = require('../src/main/cli-flags');

describe('parseLaunchFlags', () => {
  it('reads env fallbacks when argv has no flags (portable may drop argv)', () => {
    const f = parseLaunchFlags(['TraceHub.exe'], {
      TRACEHUB_SELFTEST: '1',
      TRACEHUB_USER_DATA: 'E:\\desktop\\tracehub-e2e\\userData',
      TRACEHUB_SELFTEST_REPORT: 'E:\\desktop\\tracehub-e2e\\self-test-report.json',
    });
    assert.equal(f.selfTest, true);
    assert.equal(f.disableSync, true);
    assert.equal(f.userData, 'E:\\desktop\\tracehub-e2e\\userData');
    assert.equal(f.reportPath, 'E:\\desktop\\tracehub-e2e\\self-test-report.json');
    assert.equal(f.argvSelfTestSeen, false);
    assert.equal(f.argvUserDataSeen, false);
  });

  it('parses --self-test and --user-data-dir and --self-test-report', () => {
    const f = parseLaunchFlags([
      'TraceHub.exe',
      '--self-test',
      '--user-data-dir',
      'D:\\tmp\\ud',
      '--self-test-report=D:\\tmp\\r.json',
    ], {});
    assert.equal(f.selfTest, true);
    assert.equal(f.argvSelfTestSeen, true);
    assert.equal(f.argvUserDataSeen, true);
    assert.equal(f.argvReportSeen, true);
    assert.equal(f.userData, 'D:\\tmp\\ud');
    assert.equal(f.reportPath, 'D:\\tmp\\r.json');
    assert.equal(f.disableSync, true);
  });

  it('equals form of --user-data-dir wins over empty env', () => {
    const f = parseLaunchFlags(['app', '--user-data-dir=C:\\iso'], {});
    assert.equal(f.userData, 'C:\\iso');
    assert.equal(f.argvUserDataSeen, true);
    assert.equal(f.selfTest, false);
  });
});
