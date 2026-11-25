'use strict';

const path = require('path');

/**
 * Path of the history worker script.
 *
 * The worker must stay INSIDE app.asar next to browsers.js / sqlengine.js:
 * it `require('./browsers')`, and a copy extracted to app.asar.unpacked has
 * no siblings there, so every read failed with "Cannot find module
 * './browsers'" (1.2.1–1.2.8). Electron's worker_threads load scripts from
 * asar directly; only the native .node and the wasm need unpacking.
 */
function resolveHistoryWorkerPath() {
  return path.join(__dirname, 'history-worker.js');
}

function packagedResourcePaths() {
  const resources = process.resourcesPath || '';
  return {
    resources,
    extensionDir: resources ? path.join(resources, 'extension') : '',
    unpackedRoot: resources ? path.join(resources, 'app.asar.unpacked') : '',
    nativeNode: resources
      ? path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
      : '',
    sqlJsWasm: resources
      ? path.join(resources, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
      : '',
  };
}

module.exports = { resolveHistoryWorkerPath, packagedResourcePaths };
