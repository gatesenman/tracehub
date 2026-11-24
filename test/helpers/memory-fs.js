'use strict';

const path = require('path');

/**
 * In-memory FS for session-file tests. Never touches a real browser profile.
 * `files` maps posix paths to Buffer or { buf, mtime, locked }.
 */
function memoryIO(files, { now = Date.now() } = {}) {
  const store = new Map();
  const written = new Map();
  const reads = [];
  const put = (map, p, v, extra) => {
    const buf = Buffer.isBuffer(v) ? v : (v && v.buf) ? v.buf : Buffer.from(String(v || ''));
    const rec = {
      buf,
      mtime: (v && v.mtime != null) ? v.mtime : (extra && extra.mtime) || now,
      locked: !!(v && v.locked),
      size: buf.length,
    };
    map.set(p, rec);
  };
  for (const [p, v] of Object.entries(files || {})) put(store, p, v);

  const lookup = (p) => store.get(p) || written.get(p);
  const hasPrefix = (p) => {
    const prefix = p.endsWith('/') ? p : p + '/';
    for (const k of [...store.keys(), ...written.keys()]) {
      if (k === p || k.startsWith(prefix)) return true;
    }
    return false;
  };

  return {
    exists: (p) => !!lookup(p) || hasPrefix(p),
    readFile: (p) => {
      reads.push(p);
      const f = lookup(p);
      if (!f) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      if (f.locked) throw Object.assign(new Error('EBUSY: ' + p), { code: 'EBUSY' });
      return Buffer.from(f.buf);
    },
    writeFile: (p, b) => put(written, p, Buffer.from(b)),
    readdir: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const names = new Set();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const name = k.slice(prefix.length).split('/')[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    stat: (p) => {
      const f = lookup(p);
      if (f) return { mtimeMs: f.mtime, mtime: new Date(f.mtime), size: f.size };
      if (hasPrefix(p)) return { mtimeMs: now, mtime: new Date(now), size: 0 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    mkdir: () => {},
    rm: (p) => { written.delete(p); },
    tmpdir: () => '/tmp/tracehub-session-read-test',
    sleep: () => {},
    sig: (p) => {
      const f = lookup(p);
      return f ? `${f.mtime}:${f.size}` : null;
    },
    lock: (p, on) => { const f = store.get(p); if (f) f.locked = !!on; },
    _reads: reads,
    _store: store,
  };
}

function joinProfile(base, profile, rel) {
  return path.posix.join(base, profile, rel);
}

module.exports = { memoryIO, joinProfile };
