'use strict';

// Fetches lightweight page metadata (title / description / keywords / favicon)
// directly from the site, and optionally full readable content through a
// third-party reader service (Jina Reader) for higher-quality AI summaries.

const { domainOf } = require('./store');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function faviconFor(url) {
  const domain = domainOf(url);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function extractMeta(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1]) : null;
  };
  // meta tags may have attributes in either order
  const metaContent = (name) => {
    const re1 = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
      'i'
    );
    return pick(re1) || pick(re2);
  };
  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  const description = metaContent('description') || metaContent('og:description');
  const keywordsRaw = metaContent('keywords');
  const keywords = keywordsRaw
    ? keywordsRaw.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  return { title, description, keywords };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch page HTML and extract metadata. Never throws; returns { ok, ... }.
async function fetchSiteMeta(url) {
  const base = { favicon: faviconFor(url) };
  if (!/^https?:\/\//i.test(url)) return { ok: false, ...base };
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('html')) return { ok: false, ...base };
    // Read only the first chunk(s); meta lives in <head>.
    const text = (await res.text()).slice(0, 200000);
    const meta = extractMeta(text);
    return { ok: true, ...base, ...meta };
  } catch (e) {
    return { ok: false, ...base };
  }
}

// Fetch readable page content via Jina Reader (https://jina.ai/reader).
// Works without a key; an optional key raises rate limits.
async function fetchReadableContent(url, jinaKey = '') {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const headers = { Accept: 'text/plain', 'X-Return-Format': 'text' };
    if (jinaKey && jinaKey.trim()) headers.Authorization = `Bearer ${jinaKey.trim()}`;
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 20000);
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 6000);
  } catch (e) {
    return null;
  }
}

// Local fallback snapshot: fetch the page and strip it to readable text.
// Used when Jina Reader is disabled so every page still gets an offline copy.
async function fetchLocalText(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('html')) return null;
    const html = (await res.text()).slice(0, 500000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
    return decodeEntities(text).slice(0, 12000) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { fetchSiteMeta, fetchReadableContent, fetchLocalText, faviconFor };
