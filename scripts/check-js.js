'use strict';

/**
 * Run `node --check` on each JavaScript file individually.
 * `node --check a.js b.js` only checks the first file.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'dist-win', '.git']);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const root = path.join(__dirname, '..');
const files = []
  .concat(walk(path.join(root, 'src')))
  .concat(walk(path.join(root, 'extension')))
  .concat(walk(path.join(root, 'test')))
  .concat(walk(path.join(root, 'scripts')))
  .sort();

if (!files.length) {
  console.error('no JavaScript files found');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.error('CHECK FAIL', path.relative(root, file));
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.stdout) process.stderr.write(r.stdout);
  }
}

if (failed) {
  console.error(`node --check failed for ${failed} of ${files.length} files`);
  process.exit(1);
}
console.log(`node --check ok: ${files.length} files`);
