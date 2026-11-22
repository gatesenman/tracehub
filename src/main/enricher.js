'use strict';

// Background worker that progressively enriches visited URLs with
// site metadata (favicon / description / keywords) and AI summaries.

const { fetchSiteMeta, fetchReadableContent, fetchLocalText, faviconFor } = require('./metadata');
const ai = require('./ai');

const NOISE_RE = /^(chrome|edge|about|devtools|chrome-extension|file):/i;

class Enricher {
  constructor(store, getConfig, { intervalMs = 15000, onUpdate = () => {}, isPaused = () => false } = {}) {
    this.store = store;
    this.getConfig = getConfig;
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.isPaused = isPaused;
    this.timer = null;
    this._busy = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this._busy) return;
    if (this.isPaused && this.isPaused()) return;
    this._busy = true;
    try {
      const cfg = this.getConfig();
      const changedMeta = await this._fetchMetaBatch();
      const changedAI = await this._aiBatch();
      if (cfg && cfg.contentFetchEnabled) await this._textIndexBatch();
      if (changedMeta || changedAI) this.onUpdate();
    } catch (e) {
      // never crash the app from background enrichment
    } finally {
      this._busy = false;
    }
  }

  // Fetch page metadata for a few URLs that don't have it yet.
  async _fetchMetaBatch() {
    const pending = this.store.urlsNeedingFetch(6).filter((p) => !NOISE_RE.test(p.url));
    if (pending.length === 0) return false;
    await Promise.all(
      pending.map(async (p) => {
        const meta = await fetchSiteMeta(p.url);
        this.store.upsertSiteMeta(p.url, {
          favicon: meta.favicon || faviconFor(p.url),
          description: meta.description || null,
          keywords: meta.keywords && meta.keywords.length ? meta.keywords : undefined,
          fetchedAt: Date.now(),
          fetchFailed: !meta.ok,
        });
      })
    );
    return true;
  }

  // Generate AI summaries + keywords for fetched pages lacking them.
  async _aiBatch() {
    const config = this.getConfig();
    if (!ai.hasKey(config.ai)) return false;
    const pending = this.store.urlsNeedingAI(8).filter((p) => !NOISE_RE.test(p.url));
    if (pending.length === 0) return false;

    // Optionally pull readable content via Jina Reader for better summaries.
    const useReader = config.reader && config.reader.enabled;
    const pages = await Promise.all(
      pending.map(async (p) => {
        const content = useReader
          ? await fetchReadableContent(p.url, config.reader.jinaKey || '')
          : null;
        if (content) this.store.setPageText(p.url, content);
        return { ...p, content };
      })
    );

    const results = await ai.aiEnrich(config.ai, pages);
    const now = Date.now();
    const resolved = new Set();
    for (const r of results) {
      this.store.upsertSiteMeta(r.url, {
        summary: r.summary,
        keywords: r.keywords && r.keywords.length ? r.keywords : undefined,
        enrichedAt: now,
      });
      resolved.add(r.url);
    }
    // Mark the rest as attempted so we don't loop on failures forever.
    for (const p of pending) {
      if (!resolved.has(p.url)) {
        this.store.upsertSiteMeta(p.url, { enrichedAt: now });
      }
    }
    return results.length > 0;
  }

  // Build the local full-text snapshot index. Uses Jina Reader when enabled,
  // otherwise a direct fetch + tag-strip fallback so every page still gets an
  // offline copy (时光机).
  async _textIndexBatch() {
    const config = this.getConfig();
    const useReader = config.reader && config.reader.enabled;
    const pending = this.store.urlsNeedingText(3).filter((p) => !NOISE_RE.test(p.url));
    if (pending.length === 0) return false;
    for (const p of pending) {
      const content = useReader
        ? await fetchReadableContent(p.url, config.reader.jinaKey || '')
        : await fetchLocalText(p.url);
      this.store.setPageText(p.url, content || '');
    }
    return true;
  }
}

module.exports = { Enricher };
