'use strict';

// Website screenshot worker. Uses a hidden offscreen BrowserWindow to load
// pages in the background and capture thumbnails into userData/thumbs/.
// Fully local — no third-party screenshot service or API key needed.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');

const NOISE_RE = /^(chrome|edge|about|devtools|chrome-extension|file):/i;

class ThumbWorker {
  constructor(store, dir, { onUpdate = () => {}, intervalMs = 9000, isEnabled = () => false, isPaused = () => false } = {}) {
    this.store = store;
    this.dir = dir;
    this.onUpdate = onUpdate;
    this.intervalMs = intervalMs;
    this.isEnabled = isEnabled;
    this.isPaused = isPaused;
    this.timer = null;
    this.win = null;
    this.busy = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._destroyWin();
  }

  _destroyWin() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  _getWin() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 1100,
      height: 690,
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        // contextIsolation must be off so the preload's WebAuthn stub lands in
        // the page's own world before its scripts run (otherwise it cannot
        // override navigator.credentials). nodeIntegration stays off, so pages
        // still get no Node access.
        contextIsolation: false,
        nodeIntegration: false,
        preload: path.join(__dirname, 'thumbs-preload.js'),
        images: true,
        backgroundThrottling: false,
      },
    });
    this.win.webContents.setAudioMuted(true);
    // Never let a background-rendered page spawn visible windows or wander
    // off to non-web protocols.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e, target) => {
      if (!/^https?:\/\//i.test(target)) e.preventDefault();
    });
    // Deny every permission request in this background window (camera, mic,
    // notifications, geolocation, …) — it only ever needs to render a snapshot.
    this.win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // If a page crashes this background renderer, drop the window; the next
    // capture recreates it.
    this.win.webContents.on('render-process-gone', () => this._destroyWin());
    return this.win;
  }

  async tick() {
    if (this.busy) return;
    if (this.isEnabled && !this.isEnabled()) return;
    if (this.isPaused && this.isPaused()) return;
    this.busy = true;
    try {
      const urls = this.store.urlsNeedingThumb(2).filter((u) => !NOISE_RE.test(u));
      if (urls.length === 0) return;
      let changed = false;
      for (const url of urls) {
        const ok = await this.capture(url).catch(() => false);
        if (ok) changed = true;
      }
      if (changed) this.onUpdate();
    } finally {
      this.busy = false;
    }
  }

  async capture(url) {
    const win = this._getWin();
    const wc = win.webContents;
    try {
      await Promise.race([
        wc.loadURL(url),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
      ]);
      // let the page settle (fonts / hero images)
      await new Promise((r) => setTimeout(r, 1200));
      const image = await wc.capturePage();
      if (image.isEmpty()) throw new Error('empty capture');
      const small = image.resize({ width: 420 });
      const buf = small.toJPEG(72);
      const name = crypto.createHash('sha1').update(url).digest('hex') + '.jpg';
      const file = path.join(this.dir, name);
      fs.writeFileSync(file, buf);
      this.store.setThumb(url, file, false);
      return true;
    } catch (e) {
      this.store.setThumb(url, null, true);
      return false;
    }
  }
}

module.exports = { ThumbWorker };
