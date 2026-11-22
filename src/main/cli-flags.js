'use strict';

/**
 * Parse launch flags from argv and env. Portable wrappers may drop argv,
 * so env vars are the supported fallback. This module has no Electron dependency.
 */
function parseLaunchFlags(argv, env) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const e = env || {};
  const truthy = (v) => v === '1' || String(v).toLowerCase() === 'true';
  const flags = {
    selfTest: truthy(e.TRACEHUB_SELFTEST),
    userData: String(e.TRACEHUB_USER_DATA || '').trim(),
    reportPath: String(e.TRACEHUB_SELFTEST_REPORT || '').trim(),
    disableSync: truthy(e.TRACEHUB_DISABLE_SYNC),
    argvSelfTestSeen: false,
    argvUserDataSeen: false,
    argvReportSeen: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--self-test' || a === '--selftest') {
      flags.selfTest = true;
      flags.argvSelfTestSeen = true;
    } else if (a.startsWith('--user-data-dir=')) {
      flags.userData = a.slice('--user-data-dir='.length).trim();
      flags.argvUserDataSeen = true;
    } else if (a === '--user-data-dir' && args[i + 1] && !String(args[i + 1]).startsWith('-')) {
      i += 1;
      flags.userData = String(args[i]).trim();
      flags.argvUserDataSeen = true;
    } else if (a.startsWith('--self-test-report=')) {
      flags.reportPath = a.slice('--self-test-report='.length).trim();
      flags.argvReportSeen = true;
    } else if (a === '--self-test-report' && args[i + 1] && !String(args[i + 1]).startsWith('-')) {
      i += 1;
      flags.reportPath = String(args[i]).trim();
      flags.argvReportSeen = true;
    }
  }

  if (flags.selfTest) flags.disableSync = true;
  return flags;
}

module.exports = { parseLaunchFlags };
