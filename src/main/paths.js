'use strict';

const fs = require('fs');
const path = require('path');

/** History worker must be loaded from asar.unpacked in a packaged build. */
function resolveHistoryWorkerPath() {
  const inside = path.join(__dirname, 'history-worker.js');
  if (__dirname.includes(`${path.sep}app.asar${path.sep}`) && !__dirname.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
    const unpacked = inside.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return inside;
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
    historyWorkerUnpacked: resources
      ? path.join(resources, 'app.asar.unpacked', 'src', 'main', 'history-worker.js')
      : '',
  };
}

module.exports = { resolveHistoryWorkerPath, packagedResourcePaths };
