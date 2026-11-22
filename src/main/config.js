'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Small JSON config store for AI settings and preferences.
class Config {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      ai: { provider: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      reader: { enabled: false, jinaKey: '' },
      syncIntervalMs: 5000,
      blacklist: [],
      weeklyNotify: true,
      autoLaunch: false, // start with the OS
      startMinimized: false, // start hidden in the tray
      closeToTray: true, // closing the window hides to tray instead of quitting
      minimizeToTray: false, // minimize button hides to tray instead of taskbar
      privacyPauses: [], // [{from, to}] — visits inside these windows are never recorded
      thumbsEnabled: false,
      contentFetchEnabled: false,
      onboardingCompleted: false,
      enabledProfiles: null, // null = not chosen yet; [] = none; [{browserId, profile}]
      bridgeEnabled: true,
      bridgePort: 17862,
      bridgeToken: '',
    };
    this.load();
    this._ensureBridgeToken();
  }

  _ensureBridgeToken() {
    if (!this.data.bridgeToken) {
      this.data.bridgeToken = crypto.randomBytes(24).toString('base64url');
      try { this.save(); } catch (e) { /* first boot, dir may not exist yet; save() mkdir */ }
    }
  }

  clearSecrets() {
    if (this.data.ai) this.data.ai.apiKey = '';
    if (this.data.reader) this.data.reader.jinaKey = '';
    this.save();
    return this.data;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = {
          ...this.data,
          ...raw,
          ai: { ...this.data.ai, ...(raw.ai || {}) },
          reader: { ...this.data.reader, ...(raw.reader || {}) },
        };
      }
    } catch (e) {
      /* keep defaults */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  get() {
    return this.data;
  }

  update(patch) {
    if (patch.ai) this.data.ai = { ...this.data.ai, ...patch.ai };
    if (patch.reader) this.data.reader = { ...this.data.reader, ...patch.reader };
    for (const k of Object.keys(patch)) {
      if (k !== 'ai' && k !== 'reader') this.data[k] = patch[k];
    }
    this.save();
    return this.data;
  }
}

module.exports = { Config };
