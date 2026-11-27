'use strict';

const hub = window.api;

const state = {
  currentDay: null,
  mode: 'timeline', // timeline | search | category | today | bookmarks | report
  browserFilter: '', // '' = all
  browsers: [],
  searchQuery: '',
  currentCategory: null,
  reportDays: 7,
  dragItem: null,
  summaryDay: null,   // day whose AI summary card is currently shown
  summaryText: null,  // cached summary text, kept across background refreshes
};

function showTags() {
  return localStorage.getItem('bhh-show-tags') !== '0';
}

// Daily stats panel is opt-in (off by default) — toggled from Settings.
function showStats() {
  return localStorage.getItem('bhh-show-stats') === '1';
}

// ------------------------- helpers ---------------------------------------
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min >= 60) return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
  if (min >= 1) return `${min} 分钟`;
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

// ---- 自然语言时间词解析："昨天 rust" / "上周 新闻" / "近7天 xx" ----
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseTimeQuery(raw) {
  const q = String(raw || '').trim();
  const now = new Date();
  const today0 = startOfDay(now);
  const DAY = 86400000;
  const rules = [
    { re: /^今天\s*/, range: () => [today0, today0 + DAY], label: '今天' },
    { re: /^昨天\s*/, range: () => [today0 - DAY, today0], label: '昨天' },
    { re: /^前天\s*/, range: () => [today0 - 2 * DAY, today0 - DAY], label: '前天' },
    { re: /^本周\s*/, range: () => { const dow = (now.getDay() + 6) % 7; return [today0 - dow * DAY, today0 + DAY]; }, label: '本周' },
    { re: /^上周\s*/, range: () => { const dow = (now.getDay() + 6) % 7; const mon = today0 - dow * DAY; return [mon - 7 * DAY, mon]; }, label: '上周' },
    { re: /^本月\s*/, range: () => [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), today0 + DAY], label: '本月' },
    { re: /^上月\s*/, range: () => [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()], label: '上月' },
    { re: /^(?:最近|近)\s*(\d+)\s*天\s*/, range: (m) => [today0 - (Number(m[1]) - 1) * DAY, today0 + DAY], label: null },
  ];
  for (const r of rules) {
    const m = q.match(r.re);
    if (m) {
      const [fromMs, toMs] = r.range(m);
      return { fromMs, toMs, label: r.label || `近 ${m[1]} 天`, rest: q.slice(m[0].length).trim() };
    }
  }
  return { fromMs: null, toMs: null, label: null, rest: q };
}

// "site:github.com rust" → { domain: 'github.com', rest: 'rust' }
function parseSiteQuery(raw) {
  const q = String(raw || '');
  const m = q.match(/(?:^|\s)site:([\w.-]+)/i);
  if (!m) return { domain: null, rest: q.trim() };
  return { domain: m[1].toLowerCase(), rest: q.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
}

async function openUrl(url) {
  const r = await hub.openExternal(url);
  if (r && r.ok === false) toast('无法打开链接：' + (r.error || '当前环境可能没有可用的默认浏览器'));
  else if (r === false) toast('无法打开该地址');
}

function thumbUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/');
}

// Title text with the current search query highlighted via <mark>.
function highlightedTitle(text, query) {
  const span = el('span', 'title');
  const t = String(text || '');
  const q = (query || '').trim();
  if (!q) { span.textContent = t; return span; }
  const lower = t.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let pos = lower.indexOf(ql);
  if (pos < 0) { span.textContent = t; return span; }
  while (pos >= 0) {
    if (pos > i) span.appendChild(document.createTextNode(t.slice(i, pos)));
    const m = document.createElement('mark');
    m.textContent = t.slice(pos, pos + q.length);
    span.appendChild(m);
    i = pos + q.length;
    pos = lower.indexOf(ql, i);
  }
  if (i < t.length) span.appendChild(document.createTextNode(t.slice(i)));
  return span;
}

// ------------------------- toast + undo ------------------------------------
let toastTimer = null;
function toast(msg, undoLabel, undoFn) {
  const box = document.getElementById('toast');
  box.innerHTML = '';
  box.appendChild(el('span', null, msg));
  if (undoFn) {
    const u = el('button', 'toast-undo', undoLabel || '撤销');
    u.onclick = () => { box.classList.add('hidden'); undoFn(); };
    box.appendChild(u);
  }
  box.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4000);
}

// ------------------------- context menu ------------------------------------
function closeCtxMenu() {
  document.getElementById('ctxMenu').classList.add('hidden');
}

function showCtxMenu(ev, item) {
  ev.preventDefault();
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  const add = (iconName, label, fn) => {
    const row = el('div', 'ctx-item');
    withIcon(row, iconName, ' ' + label, { size: 14 });
    row.onclick = () => { closeCtxMenu(); fn(); };
    menu.appendChild(row);
  };
  add('external', '打开网页', () => openUrl(item.url));
  add('copy', '复制链接', async () => { await hub.copyText(item.url); toast('链接已复制'); });
  add('book', '查看离线快照', () => openSnapshot(item));
  add('link', '查看访问路径', () => openTrace(item));
  add('star', item.bookmarked ? '取消收藏' : '收藏', async () => {
    if (item.bookmarked) { await removeSaved(item); toast('已取消收藏', '撤销', async () => { await addSaved(item); }); }
    else { await addSaved(item); toast('已收藏', '撤销', async () => { await removeSaved(item); }); }
  });
  add('book', '加入稍后读', async () => { await addToReadLater(item); });
  if (item.domain) {
    add('globe', `站点档案 ${item.domain}`, () => openDomainProfile(item.domain));
  }
  if (item.domain) {
    add('ban', `不再记录 ${item.domain}`, async () => {
      const c = await hub.domainCount(item.domain);
      if (!(await askConfirm(`将停止记录 ${item.domain}，并删除已有的 ${c.count} 条访问记录。此操作不会自动恢复已删记录。`, '拉黑并删除'))) return;
      const r = await hub.blacklistAdd(item.domain);
      toast(`已拉黑 ${item.domain}，删除 ${r.removed} 条记录`);
      if (state.currentDay) selectDay(state.currentDay);
    });
  }
  menu.classList.remove('hidden');
  const mw = 200, mh = menu.offsetHeight || 180;
  menu.style.left = Math.min(ev.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - mh - 8) + 'px';
}

// ------------------------- thumbnail hover preview --------------------------
function attachThumbPreview(shot, item) {
  const pv = document.getElementById('thumbPreview');
  shot.addEventListener('mouseenter', () => {
    pv.innerHTML = '';
    const big = el('img');
    big.src = shot.src;
    pv.appendChild(big);
    pv.appendChild(el('div', 'pv-title', item.title || item.url));
    if (item.summary) pv.appendChild(withIcon(el('div', 'pv-sub'), 'sparkles', ' ' + item.summary, { size: 12 }));
    pv.classList.remove('hidden');
    const r = shot.getBoundingClientRect();
    const w = 420, h = pv.offsetHeight || 300;
    let x = r.right + 12;
    if (x + w > window.innerWidth) x = Math.max(8, r.left - w - 12);
    let y = Math.min(r.top, window.innerHeight - h - 12);
    pv.style.left = x + 'px';
    pv.style.top = Math.max(8, y) + 'px';
  });
  shot.addEventListener('mouseleave', () => pv.classList.add('hidden'));
}

function dayKeyLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// Deterministic hue per domain, used by the letter-avatar fallbacks.
function domainHue(domain) {
  let h = 0;
  const s = String(domain || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

// Letter avatar shown when a favicon can't be loaded.
function letterAvatar(domain, cls) {
  const box = el('span', cls);
  box.textContent = (String(domain || '?').replace(/^www\./, '')[0] || '?').toUpperCase();
  box.style.background = `linear-gradient(135deg, hsl(${domainHue(domain)},45%,38%), hsl(${(domainHue(domain) + 40) % 360},45%,28%))`;
  return box;
}

function faviconEl(item) {
  const img = el('img', 'favicon');
  img.src = item.favicon || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.domain || '')}&sz=64`;
  img.onerror = () => img.replaceWith(letterAvatar(item.domain, 'favicon letter'));
  return img;
}

// Short display names for browser chips; only shown when the library actually
// mixes several browsers.
const BROWSER_SHORT = {
  'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge', 'Mozilla Firefox': 'Firefox',
};
function multiBrowser() {
  return (state.browsers || []).length > 1;
}

// Heuristic noise detection: search result pages, redirects, auth pages.
const NOISE_PATTERNS = [
  /[?&](q|query|search_query|wd|kw)=/i,
  /\/(search|login|signin|sign-in|logout|signup|sign-up|auth|oauth|sso|callback|redirect)([/?#]|$)/i,
  /accounts?\.google\.com|login\.microsoftonline\.com/i,
];

function isNoise(item) {
  const u = item.url || '';
  return NOISE_PATTERNS.some((re) => re.test(u));
}

// 收藏 = 书签 + 未读队列，统一入口
async function addSaved(item) {
  await hub.addBookmark({ url: item.url, title: item.title });
  item.bookmarked = true;
  toast('已收藏，后台正在离线存档 + 自动归类…');
}

async function addToReadLater(item) {
  await hub.addReadLater(item.url, item.title);
  item.readLater = true;
  toast('已加入稍后读');
}

async function removeSaved(item) {
  await hub.removeBookmark(item.url);
  item.bookmarked = false;
}

async function toggleStar(item, starEl) {
  if (item.bookmarked) {
    await removeSaved(item);
    starEl.classList.remove('on');
    toast('已取消收藏', '撤销', async () => { await addSaved(item); starEl.classList.add('on'); });
  } else {
    await addSaved(item);
    starEl.classList.add('on');
    toast('已收藏', '撤销', async () => { await removeSaved(item); starEl.classList.remove('on'); });
  }
}

// Rich entry card: favicon + title + description/summary + keyword chips.
function entryRow(item, { rich = true } = {}) {
  const row = el('div', 'entry');
  row.dataset.url = item.url;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    state.dragItem = item;
    e.dataTransfer.setData('text/plain', item.url);
    e.dataTransfer.effectAllowed = 'copy';
  });
  row.addEventListener('contextmenu', (e) => showCtxMenu(e, item));
  if (rich && item.thumb) {
    const shot = el('img', 'thumb');
    shot.src = thumbUrl(item.thumb);
    shot.title = item.url;
    shot.onclick = () => openUrl(item.url);
    shot.onerror = () => { shot.remove(); row.classList.remove('has-thumb'); };
    attachThumbPreview(shot, item);
    row.appendChild(shot);
    row.classList.add('has-thumb');
  }
  const body = el('div', 'entry-body');
  const main = el('div', 'entry-main');
  main.appendChild(faviconEl(item));
  const title = highlightedTitle(item.title || item.url, state.mode === 'search' ? state.searchQuery : '');
  title.title = item.url;
  title.onclick = () => openUrl(item.url);
  main.appendChild(title);
  if (item.visitCount > 1) {
    const vc = el('span', 'count-badge', `×${item.visitCount}`);
    vc.title = `当日访问 ${item.visitCount} 次，已去重展示`;
    main.appendChild(vc);
  }
  const meta = el('span', 'entry-meta');
  meta.appendChild(el('span', 'time', fmtTime(item.visitTime)));
  const dwell = item.dwellSumMs != null ? item.dwellSumMs : item.dwellMs;
  if (rich && dwell != null) {
    const eng = item.engaged;
    const dw = el('span', 'dwell-tag' + (eng ? ' engaged' : ''), eng ? `真读 ${fmtDuration(dwell)}` : '略过');
    dw.title = eng ? `估算停留 ${fmtDuration(dwell)}，判定为真正读过` : '停留很短，可能只是点开就关';
    meta.appendChild(dw);
  }
  if (item.category) meta.appendChild(el('span', 'cat-tag', item.category));
  if (item.browserName && multiBrowser() && !state.browserFilter) {
    const chip = el('span', 'browser-tag', BROWSER_SHORT[item.browserName] || item.browserName);
    chip.title = `${item.browserName}${item.profile ? ' · ' + item.profile : ''}`;
    meta.appendChild(chip);
  }
  const star = el('span', 'star' + (item.bookmarked ? ' on' : ''));
  star.appendChild(icon('star', { filled: true, size: 14 }));
  star.title = item.bookmarked ? '取消收藏' : '收藏';
  star.onclick = () => toggleStar(item, star);
  meta.appendChild(star);
  main.appendChild(meta);
  body.appendChild(main);

  if (rich && (item.summary || item.description)) {
    const sub = el('div', 'entry-sub');
    if (item.summary) sub.appendChild(withIcon(el('span', 'ai-summary'), 'sparkles', ' ' + item.summary, { size: 12 }));
    else if (item.description) sub.appendChild(el('span', 'desc', item.description.slice(0, 120)));
    body.appendChild(sub);
  }
  if (rich && showTags() && item.keywords && item.keywords.length) {
    const tags = el('div', 'entry-tags');
    for (const kw of item.keywords.slice(0, 20)) tags.appendChild(el('span', 'kw', kw));
    body.appendChild(tags);
  }
  if (rich && item.fromUrl) {
    const from = el('div', 'entry-from');
    let fromLabel = item.fromUrl;
    try { fromLabel = new URL(item.fromUrl).hostname.replace(/^www\./, '') + new URL(item.fromUrl).pathname.slice(0, 40); } catch (e) { /* keep raw */ }
    const link = el('span', 'from-link', `↩ 来自 ${fromLabel}`);
    link.title = item.fromUrl + '（右键菜单可查看完整访问路径）';
    link.onclick = () => openTrace(item);
    from.appendChild(link);
    body.appendChild(from);
  }
  row.appendChild(body);
  return row;
}

// ------------------------- snapshot (时光机) -------------------------------
let snapshotUrl = null;
async function openSnapshot(item) {
  snapshotUrl = item.url;
  const modal = document.getElementById('snapshotModal');
  const body = document.getElementById('snapshotBody');
  const info = document.getElementById('snapshotInfo');
  body.textContent = '正在读取快照…';
  info.textContent = item.title || item.url;
  modal.classList.remove('hidden');
  const snap = await hub.getSnapshot(item.url);
  if (!snap || !snap.content) {
    body.textContent = '还没有这个页面的离线快照。快照在后台自动抓取（新访问的页面优先），稍后再试；若页面已下线且从未抓到，则无法补救。';
    return;
  }
  info.textContent = `${item.title || item.url}　·　快照于 ${new Date(snap.indexedAt).toLocaleString('zh-CN')}`;
  body.textContent = snap.content;
}

// ------------------------- referrer trace ----------------------------------
async function openTrace(item) {
  const modal = document.getElementById('traceModal');
  const body = document.getElementById('traceBody');
  body.textContent = '正在回溯…';
  modal.classList.remove('hidden');
  const chain = await hub.tracePath(item.url);
  body.innerHTML = '';
  if (!chain || chain.length <= 1) {
    body.appendChild(el('div', 'empty', '没有找到来源链（直接打开 / 地址栏输入 / 旧记录未同步来源）'));
    if (chain && chain.length === 1) body.appendChild(traceRow(chain[0], 0, true));
    return;
  }
  // chain[0] 是当前页，倒序展示：最早的来源在最上面
  const list = [...chain].reverse();
  list.forEach((n, i) => body.appendChild(traceRow(n, i, i === list.length - 1)));
}

function traceRow(n, idx, isCurrent) {
  const row = el('div', 'trace-row' + (isCurrent ? ' current' : ''));
  row.appendChild(el('span', 'trace-step', isCurrent ? '◉' : String(idx + 1)));
  const t = el('span', 'title', n.title || n.url);
  t.title = n.url;
  t.onclick = () => openUrl(n.url);
  row.appendChild(t);
  if (n.domain) row.appendChild(el('span', 'browser-tag', n.domain));
  row.appendChild(el('span', 'time', fmtTime(n.visitTime)));
  return row;
}

// ------------------------- domain profile (站点档案) ------------------------
let domainCurrent = null;

async function openDomainProfile(domain) {
  const modal = document.getElementById('domainModal');
  const body = document.getElementById('domainBody');
  document.getElementById('domainInfo').textContent = domain;
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', '加载中…'));
  modal.classList.remove('hidden');
  domainCurrent = domain;
  let p = null;
  try { p = await hub.domainProfile(domain); } catch (e) { /* 按无记录处理 */ }
  if (domainCurrent !== domain) return;
  body.innerHTML = '';
  if (!p) {
    body.appendChild(el('div', 'empty', '没有该站点的记录'));
    return;
  }
  const cards = el('div', 'overview-cards');
  const card = (n, label, hint) => {
    const c = el('div', 'overview-card');
    c.appendChild(el('div', 'overview-n' + (String(n).length > 8 ? ' small' : ''), String(n)));
    c.appendChild(el('div', 'overview-l', label));
    if (hint) c.appendChild(el('div', 'overview-hint', hint));
    return c;
  };
  const dateStr = (ms) => new Date(ms).toLocaleDateString('zh-CN');
  const daysKnown = Math.max(1, Math.round((Date.now() - p.firstVisit) / 86400000));
  cards.appendChild(card(p.visits, '总访问'));
  cards.appendChild(card(p.pages, '不同页面'));
  cards.appendChild(card(dateStr(p.firstVisit), '首次访问', `${daysKnown} 天前认识它`));
  cards.appendChild(card(dateStr(p.lastVisit), '最近访问', fmtTime(p.lastVisit)));
  body.appendChild(cards);

  // 30-day visit trend as a mini bar chart (missing days = 0).
  const trendMap = new Map(p.trend.map((t) => [t.day, t.count]));
  const maxN = Math.max(1, ...p.trend.map((t) => t.count));
  const trendTitle = el('div', 'cfg-section', `近 ${p.trendDays} 天趋势`);
  body.appendChild(trendTitle);
  const chart = el('div', 'trend-chart');
  for (let i = p.trendDays - 1; i >= 0; i--) {
    const day = dayKeyLocal(new Date(Date.now() - i * 86400000));
    const n = trendMap.get(day) || 0;
    const bar = el('div', 'trend-bar' + (n ? '' : ' zero'));
    bar.style.height = `${n ? Math.max(8, Math.round((n / maxN) * 100)) : 4}%`;
    bar.title = `${day}：${n} 次`;
    chart.appendChild(bar);
  }
  body.appendChild(chart);
  const axis = el('div', 'trend-axis');
  axis.appendChild(el('span', null, dayKeyLocal(new Date(Date.now() - (p.trendDays - 1) * 86400000)).slice(5)));
  axis.appendChild(el('span', null, '今天'));
  body.appendChild(axis);

  if (p.topPages.length) {
    body.appendChild(el('div', 'cfg-section', '常看页面 Top'));
    for (const pg of p.topPages) {
      const row = el('div', 'trace-row');
      row.appendChild(el('span', 'count-badge', `${pg.visits} 次`));
      const t = el('span', 'title', pg.title || pg.url);
      t.title = pg.url;
      t.onclick = () => openUrl(pg.url);
      row.appendChild(t);
      row.appendChild(el('span', 'time', dateStr(pg.lastVisit)));
      body.appendChild(row);
      if (pg.summary) body.appendChild(el('div', 'reason', '↳ ' + pg.summary));
    }
  }
}

// ------------------------- privacy pause -----------------------------------
async function refreshPrivacyBtn() {
  const btn = document.getElementById('btnPrivacy');
  try {
    const { pausedUntil } = await hub.privacyStatus();
    const paused = pausedUntil > Date.now();
    btn.classList.toggle('paused', paused);
    btn.title = paused
      ? `已暂停，至 ${fmtTime(pausedUntil)}。期间的访问不会被记录，点击可提前恢复`
      : '暂停：暂停期间的访问不会被记录';
  } catch (e) { /* ignore */ }
}

function showPrivacyMenu() {
  const btn = document.getElementById('btnPrivacy');
  const menu = document.getElementById('privacyMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  menu.innerHTML = '';
  const add = (iconName, label, fn) => {
    const row = el('div', 'ctx-item');
    withIcon(row, iconName, ' ' + label, { size: 14 });
    row.onclick = () => { menu.classList.add('hidden'); fn(); };
    menu.appendChild(row);
  };
  const paused = btn.classList.contains('paused');
  menu.appendChild(el('div', 'ctx-hint', '暂停期间的访问不会被记录'));
  if (paused) {
    add('check-circle', '立即恢复记录', async () => {
      await hub.privacyResume();
      await refreshPrivacyBtn();
      toast('已恢复记录');
    });
  }
  const durLabel = (m) => (m >= 60 ? `${m / 60} 小时` : `${m} 分钟`);
  for (const m of [3, 15, 30, 60, 120]) {
    add('shield', paused ? `改为暂停 ${durLabel(m)}` : `暂停 ${durLabel(m)}`, async () => {
      const r = await hub.privacyPause(m);
      await refreshPrivacyBtn();
      toast(`已暂停，至 ${fmtTime(r.pausedUntil)}，期间的访问不会被记录`);
    });
  }
  menu.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
  menu.style.top = r.bottom + 6 + 'px';
}

// ------------------------- sidebar: days ----------------------------------
async function loadDays() {
  const days = await hub.listDays();
  const list = document.getElementById('daysList');
  list.innerHTML = '';
  if (days.length === 0) {
    list.appendChild(emptyState('clock', '暂无历史记录，正在同步…', '立即同步', () => document.getElementById('btnSync').click()));
    // First-run guidance in the (otherwise blank) content area.
    if (state.mode === 'timeline' && !state.currentDay) {
      const body = document.getElementById('contentBody');
      body.innerHTML = '';
      const box = el('div', 'empty');
      box.appendChild(el('div', null, '正在从你的浏览器汇入历史记录…'));
      box.appendChild(el('div', 'sub', '首次使用请先在引导页勾选要同步的浏览器。默认不会自动截图或抓取正文。'));
      box.appendChild(el('div', 'sub', '小技巧：Ctrl+K 命令面板 · Alt+Space 全局唤起 · 搜索支持「昨天 xx」「site:域名 xx」'));
      body.appendChild(box);
    }
    return;
  }
  const todayKey = dayKeyLocal(new Date());
  const yesterdayKey = dayKeyLocal(new Date(Date.now() - 86400000));
  const maxCount = Math.max(...days.map((d) => d.count), 1);
  let lastMonth = '';
  for (const d of days) {
    const month = d.day.slice(0, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      const [y, m] = month.split('-');
      list.appendChild(el('div', 'month-head', `${y} 年 ${Number(m)} 月`));
    }
    const date = new Date(d.day + 'T00:00:00');
    const item = el('div', 'day-item');
    item.dataset.day = d.day;
    const left = el('div', 'day-left');
    const line1 = el('div', 'day-line1');
    if (d.day === todayKey) line1.appendChild(el('span', 'day-badge today', '今天'));
    else if (d.day === yesterdayKey) line1.appendChild(el('span', 'day-badge', '昨天'));
    line1.appendChild(el('span', 'day-num', `${Number(d.day.slice(8))} 日`));
    line1.appendChild(el('span', 'day-week', WEEKDAYS[date.getDay()]));
    left.appendChild(line1);
    const bar = el('div', 'day-bar');
    const fill = el('div', 'day-bar-fill');
    fill.style.width = `${Math.max(8, Math.round((d.count / maxCount) * 100))}%`;
    bar.appendChild(fill);
    left.appendChild(bar);
    item.appendChild(left);
    item.appendChild(el('span', 'count-badge', String(d.count)));
    item.onclick = () => selectDay(d.day);
    if (d.day === state.currentDay) item.classList.add('active');
    list.appendChild(item);
  }
  if (!state.currentDay && days.length) selectDay(days[0].day);
}

async function selectDay(day) {
  state.currentDay = day;
  state.mode = 'timeline';
  document.querySelectorAll('.day-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.day === day);
  });
  const [tl, stats] = await Promise.all([
    hub.timelineForDay(day, state.browserFilter || null),
    hub.statsForDay(day, state.browserFilter || null),
  ]);
  renderTimeline(day, tl, stats);
}

function renderStats(stats) {
  const box = document.getElementById('statsBox');
  box.innerHTML = '';
  if (!showStats()) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const nums = el('div', 'stats-nums');
  const cell = (n, label) => {
    const c = el('div', 'stat-cell');
    c.appendChild(el('div', 'stat-n', String(n)));
    c.appendChild(el('div', 'stat-l', label));
    return c;
  };
  nums.appendChild(cell(stats.visits, '访问'));
  nums.appendChild(cell(stats.distinctUrls, '网页'));
  nums.appendChild(cell(stats.distinctDomains, '网站'));
  box.appendChild(nums);
  const top = el('div', 'stats-top');
  const max = stats.topDomains.length ? stats.topDomains[0].count : 1;
  for (const t of stats.topDomains) {
    const rowEl = el('div', 'top-row');
    rowEl.appendChild(el('span', 'top-domain', t.domain));
    const bar = el('div', 'top-bar');
    const fill = el('div', 'top-fill');
    fill.style.width = `${Math.max(6, Math.round((t.count / max) * 100))}%`;
    bar.appendChild(fill);
    rowEl.appendChild(bar);
    rowEl.appendChild(el('span', 'top-count', String(t.count)));
    top.appendChild(rowEl);
  }
  box.appendChild(top);
}

async function repairVisibleDay(day) {
  const target = day || (state.mode === 'today' ? todayKey() : state.currentDay);
  if (!target) {
    toast('请先在时间树或今日中选择一天');
    return;
  }
  setStatus(`正在重新同步 ${target}…`);
  try {
    const r = await hub.repairDay(target);
    const n = (r && r.inserted) || 0;
    const msg = r && r.skipped
      ? (r.skipped === 'onboarding' ? '请先完成引导后再重新同步' : '当前无法重新同步这一天')
      : `已重新同步 ${target}，新补入 ${n} 条访问`;
    setStatus(msg);
    toast(msg);
    await loadDays();
    if (state.mode === 'today' && target === todayKey()) await showToday();
    else if (state.currentDay === target) await selectDay(target);
  } catch (e) {
    const msg = '重新同步这一天失败：' + (e && e.message ? e.message : String(e));
    setStatus(msg);
    toast(msg);
  }
}

function renderTimeline(day, tl, stats) {
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), 'calendar', ` ${day}`));
  const dedupNote = tl.distinct != null && tl.distinct < tl.total ? `，去重后 ${tl.distinct} 条` : '';
  header.appendChild(el('span', 'sub', `${tl.total} 条访问${dedupNote}` + (state.browserFilter ? '（已筛选）' : '')));
  const dayRepairBtn = el('button', 'restore-btn', '重新同步这一天');
  dayRepairBtn.title = '从各浏览器现存历史把这一天缺失或异常的访问补进软件。其他日期不受影响，已有记录不会被删掉。';
  dayRepairBtn.onclick = () => repairVisibleDay(day);
  header.appendChild(dayRepairBtn);
  // Day summary / Markdown-log actions live in the topbar; remember what they
  // should act on.
  state.lastTimeline = { day, tl };
  document.getElementById('btnDaySummary').classList.toggle('active', state.summaryDay === day);

  // Keep the summary card alive across background refreshes: only re-render it
  // when it belongs to the day being shown, otherwise hide it.
  if (state.summaryDay === day) renderSummaryCard(day, state.summaryText);
  else document.getElementById('summaryBox').classList.add('hidden');
  if (stats) renderStats(stats);

  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  if (tl.total === 0) {
    const empty = emptyState('calendar', '这一天没有记录', '重新同步这一天', () => repairVisibleDay(day));
    body.appendChild(empty);
    return;
  }
  const renderHour = (h) => {
    const block = el('div', 'hour-block');
    const hourLabel = el('div', 'hour-label');
    const caret = el('span', 'hour-caret', '▾');
    hourLabel.appendChild(caret);
    hourLabel.appendChild(el('span', 'hour-chip', `${String(h.hour).padStart(2, '0')}:00`));
    hourLabel.appendChild(el('span', 'sub', `${h.domains.reduce((n, g) => n + g.count, 0)} 条 · ${h.domains.length} 个站点`));
    const restore = withIcon(el('button', 'restore-btn'), 'refresh', ' 重开本时段', { size: 12 });
    restore.title = '按浏览历史打开此时段访问过的网址，不是恢复当时已打开的页签、窗口或登录状态。';
    restore.onclick = (e) => { e.stopPropagation(); openSessionModal(day, h.hour); };
    hourLabel.appendChild(restore);
    hourLabel.style.cursor = 'pointer';
    hourLabel.title = '点击折叠/展开本时段';
    hourLabel.onclick = () => {
      block.classList.toggle('collapsed');
      caret.textContent = block.classList.contains('collapsed') ? '▸' : '▾';
    };
    block.appendChild(hourLabel);
    for (const g of h.domains) {
      const group = el('div', 'domain-group');
      const head = el('div', 'domain-head');
      const dot = el('span', 'domain-dot');
      dot.style.background = `hsl(${domainHue(g.domain)}, 55%, 52%)`;
      head.appendChild(dot);
      const dn = el('span', 'domain-name clickable', g.domain);
      dn.title = '查看站点档案：总访问 / 首次访问 / 趋势 / 常看页面';
      dn.onclick = () => openDomainProfile(g.domain);
      head.appendChild(dn);
      head.appendChild(el('span', 'count-badge', String(g.count)));
      group.appendChild(head);
      const entries = el('div');
      // fold noise entries (search / redirect / auth pages)
      const noise = g.entries.filter(isNoise);
      const clean = noise.length > 0 ? g.entries.filter((x) => !isNoise(x)) : g.entries;
      // Show entries incrementally so very large groups never freeze the UI.
      const STEP = 6;
      let shownCount = Math.min(STEP, clean.length);
      const more = el('div', 'more-link');
      const renderClean = () => {
        entries.innerHTML = '';
        for (const item of clean.slice(0, shownCount)) entries.appendChild(entryRow(item));
        const left = clean.length - shownCount;
        more.classList.toggle('hidden', left <= 0 && shownCount <= STEP);
        more.textContent = left > 0 ? `展开其余 ${left} 条（每次 ${STEP * 5} 条）` : '收起';
      };
      more.onclick = () => {
        const left = clean.length - shownCount;
        shownCount = left > 0 ? Math.min(clean.length, shownCount + STEP * 5) : Math.min(STEP, clean.length);
        renderClean();
      };
      renderClean();
      group.appendChild(entries);
      if (clean.length > STEP) group.appendChild(more);
      if (noise.length > 0) {
        // Noise rows are built lazily on first expand.
        let shown = false;
        let built = false;
        const fold = el('div', 'more-link', `已折叠 ${noise.length} 条噪音记录（搜索/跳转/登录页），点击展开`);
        const noiseBox = el('div', 'noise-box hidden');
        fold.onclick = () => {
          if (!built) {
            for (const item of noise) noiseBox.appendChild(entryRow(item, { rich: false }));
            built = true;
          }
          shown = !shown;
          noiseBox.classList.toggle('hidden', !shown);
          fold.textContent = shown ? '收起噪音记录' : `已折叠 ${noise.length} 条噪音记录（搜索/跳转/登录页），点击展开`;
        };
        group.appendChild(fold);
        group.appendChild(noiseBox);
      }
      block.appendChild(group);
    }
    return block;
  };
  // Paginate hour blocks so huge days stay responsive.
  const PAGE = 8;
  const first = tl.hours.slice(0, PAGE);
  const rest = tl.hours.slice(PAGE);
  for (const h of first) body.appendChild(renderHour(h));
  if (rest.length) {
    const more = el('div', 'more-link', `加载其余 ${rest.length} 个时段…`);
    more.onclick = () => {
      more.remove();
      for (const h of rest) body.appendChild(renderHour(h));
    };
    body.appendChild(more);
  }
}

// Serialize a day's timeline into a Markdown reading log (for Obsidian etc.).
function buildMarkdownLog(day, tl) {
  const lines = [`# ${day} 阅读日志`, ''];
  const seen = new Set();
  const hours = [...(tl.hours || [])].sort((a, b) => a.hour - b.hour);
  for (const h of hours) {
    const rows = [];
    for (const g of h.domains) {
      for (const item of g.entries) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        let line = `- ${fmtTime(item.visitTime)} [${String(item.title || item.url).replace(/[\[\]]/g, ' ')}](${item.url})`;
        if (item.domain) line += ` · ${item.domain}`;
        rows.push(line);
        if (item.summary) rows.push(`  - ${item.summary}`);
      }
    }
    if (!rows.length) continue;
    lines.push(`## ${String(h.hour).padStart(2, '0')}:00`);
    lines.push(...rows, '');
  }
  return lines.join('\n');
}

// Render the AI daily-summary card (title + close button). `text === null`
// means "still generating".
function renderSummaryCard(day, text) {
  const box = document.getElementById('summaryBox');
  box.innerHTML = '';
  box.classList.remove('hidden');
  const head = el('div', 'summary-head');
  head.appendChild(withIcon(el('span', 'summary-title'), 'sparkles', ` AI 每日摘要 · ${day}`, { size: 13 }));
  const close = el('button', 'summary-close', '✕');
  close.title = '关闭摘要';
  close.onclick = () => hideSummary();
  head.appendChild(close);
  box.appendChild(head);
  const bodyEl = el('div', 'summary-text', text == null ? '正在生成摘要…' : text);
  if (text == null) bodyEl.classList.add('loading');
  box.appendChild(bodyEl);
}

function hideSummary() {
  state.summaryDay = null;
  state.summaryText = null;
  document.getElementById('summaryBox').classList.add('hidden');
  document.getElementById('btnDaySummary').classList.remove('active');
}

async function loadSummary(day) {
  state.summaryDay = day;
  state.summaryText = null;
  renderSummaryCard(day, null);
  document.getElementById('btnDaySummary').classList.add('active');
  try {
    const text = await hub.daySummary(day);
    // The user may have switched days while it was generating.
    if (state.summaryDay !== day) return;
    state.summaryText = text;
    renderSummaryCard(day, text);
  } catch (e) {
    if (state.summaryDay !== day) return;
    state.summaryText = '生成摘要失败：' + (e.message || e);
    renderSummaryCard(day, state.summaryText);
  }
}

// Actionable empty state with an optional call-to-action button.
function emptyState(iconName, text, btnLabel, onClick) {
  const box = el('div', 'empty-state');
  const ic = el('div', 'empty-icon');
  ic.appendChild(icon(iconName, { size: 36 }));
  box.appendChild(ic);
  box.appendChild(el('div', 'empty-text', text));
  if (btnLabel && onClick) {
    const b = el('button', 'primary', btnLabel);
    b.onclick = onClick;
    box.appendChild(b);
  }
  return box;
}

// ------------------------- search -----------------------------------------
async function runSearch(useAI) {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  state.mode = 'search';
  const tq = parseTimeQuery(q);
  const sq = parseSiteQuery(tq.rest);
  state.searchQuery = sq.rest || q;
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), useAI ? 'sparkles' : 'search', useAI ? ` AI 搜索: ${q}` : ` 搜索: ${q}`));
  if (tq.label) header.appendChild(el('span', 'sub', `⏱ 时间范围：${tq.label}`));
  if (sq.domain) header.appendChild(el('span', 'sub', `🌐 仅限站点：${sq.domain}`));
  document.getElementById('summaryBox').classList.add('hidden');
  document.getElementById('statsBox').classList.add('hidden');
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', '搜索中…'));

  try {
    const results = useAI
      ? await hub.searchAI(sq.rest || q, { fromMs: tq.fromMs, toMs: tq.toMs, domain: sq.domain })
      : await hub.searchBasic(sq.rest, state.browserFilter || null, tq.fromMs, tq.toMs, sq.domain);
    body.innerHTML = '';
    header.appendChild(el('span', 'sub', `${results.length} 条结果`));
    if (results.length === 0) {
      body.appendChild(emptyState('search', `没有找到「${q}」的匹配项`, useAI ? null : '试试 AI 语义搜索', useAI ? null : () => runSearch(true)));
      return;
    }
    for (const item of results) {
      const wrap = el('div');
      wrap.appendChild(entryRow(item));
      if (item.reason) wrap.appendChild(el('div', 'reason', '↳ ' + item.reason));
      body.appendChild(wrap);
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'empty', '搜索失败：' + (e.message || e)));
  }
}

// ------------------------- categories -------------------------------------
// Fuzzy subsequence match: every char of the query appears in order.
function fuzzyMatch(text, query) {
  const t = String(text).toLowerCase();
  const q = String(query).toLowerCase().replace(/\s+/g, '');
  if (!q) return true;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

let allCats = [];
function renderCategories() {
  const list = document.getElementById('catsList');
  const q = document.getElementById('catFilter').value.trim();
  list.innerHTML = '';
  if (allCats.length === 0) {
    list.appendChild(emptyState('tag', '还没有分类', '立即 AI 整理', () => document.getElementById('btnOrganize').click()));
    return;
  }
  const cats = allCats.filter((c) => fuzzyMatch(c.category, q));
  if (cats.length === 0) {
    list.appendChild(emptyState('search', `没有匹配「${q}」的分类`));
    return;
  }
  for (const c of cats) {
    const item = el('div', 'cat-item');
    item.dataset.category = c.category;
    if (c.category === state.currentCategory) item.classList.add('active');
    item.appendChild(el('span', null, c.category));
    item.appendChild(el('span', 'count-badge', String(c.count)));
    item.onclick = () => showCategory(c.category);
    list.appendChild(item);
  }
}

async function loadCategories() {
  allCats = await hub.listCategories();
  renderCategories();
  if (state.currentCategory) showCategory(state.currentCategory);
  else if (allCats.length) showCategory(allCats[0].category);
  else {
    const header = document.getElementById('contentHeader');
    header.innerHTML = '';
    header.appendChild(withIcon(el('span'), 'tag', ' 分类'));
    document.getElementById('summaryBox').classList.add('hidden');
    document.getElementById('statsBox').classList.add('hidden');
    const body = document.getElementById('contentBody');
    body.innerHTML = '';
    body.appendChild(emptyState('tag', '还没有分类：点顶栏「AI 整理」自动分类打标签', '立即 AI 整理', () => document.getElementById('btnOrganize').click()));
  }
}

async function showCategory(category) {
  state.mode = 'category';
  state.currentCategory = category;
  document.querySelectorAll('#catsList .cat-item').forEach((n) =>
    n.classList.toggle('active', n.dataset.category === category));
  const results = await hub.searchBasic('', state.browserFilter || null);
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), 'tag', ` 分类: ${category}`));
  document.getElementById('summaryBox').classList.add('hidden');
  document.getElementById('statsBox').classList.add('hidden');
  const filtered = results.filter((r) => r.category === category);
  header.appendChild(el('span', 'sub', `${filtered.length} 条` + (state.browserFilter ? '（已筛选）' : '')));
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  if (filtered.length === 0) {
    body.appendChild(el('div', 'empty', '该分类暂无记录'));
    return;
  }
  for (const item of filtered) body.appendChild(entryRow(item));
}

// ------------------------- 收藏夹管理（目录 + 卡片） -----------------------
// state.bmFolder: '__all__' | '__unread__' | '__none__' | 文件夹名
let savedCache = { merged: [], rlMap: new Map(), folders: [] };

function bmFolderRow({ iconName, label, count, key, droppable = true, depth = 0 }) {
  const row = el('div', 'bm-folder' + (state.bmFolder === key ? ' active' : ''));
  if (depth) row.style.paddingLeft = `${10 + depth * 16}px`;
  withIcon(row, iconName, ' ' + label, { size: 14 });
  row.appendChild(el('span', 'bm-folder-count', String(count)));
  row.onclick = () => { state.bmFolder = key; showSaved(); };
  if (droppable) {
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const data = e.dataTransfer.getData('text/plain');
      if (!data) return;
      if (data.startsWith('bm-folder:')) {
        // Dropping a folder onto a folder moves it inside as a child.
        const src = data.slice('bm-folder:'.length);
        if (key === '__none__' || key === src || key.startsWith(src + '/')) return;
        const leaf = src.split('/').pop();
        const dest = `${key}/${leaf}`;
        await hub.renameBookmarkFolder(src, dest);
        if (state.bmFolder === src) state.bmFolder = dest;
        toast(`已将「${leaf}」移入「${label}」`);
      } else {
        await hub.setBookmarkFolder(data, key === '__none__' ? null : key);
        toast(key === '__none__' ? '已移出文件夹' : `已移入「${label}」`);
      }
      showSaved();
    });
  }
  return row;
}

// Build a tree out of '/'-separated folder paths, preserving store order.
function bmFolderTree(folders) {
  const byPath = new Map();
  const roots = [];
  for (const f of folders) {
    const node = { name: f.name, label: f.name.split('/').pop(), count: f.count, children: [] };
    byPath.set(f.name, node);
    const slash = f.name.lastIndexOf('/');
    if (slash === -1) roots.push(node);
    else {
      const parent = byPath.get(f.name.slice(0, slash));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  return roots;
}

function renderSavedSidebar() {
  const list = document.getElementById('bmList');
  if (!list) return;
  list.innerHTML = '';
  const { merged, rlMap, folders, uncategorized } = savedCache;
  const unreadN = merged.filter((m) => rlMap.has(m.url) && !m.doneAt).length;

  list.appendChild(bmFolderRow({ iconName: 'star', label: '全部收藏', count: merged.length, key: '__all__', droppable: false }));
  list.appendChild(bmFolderRow({ iconName: 'clock', label: '未读', count: unreadN, key: '__unread__', droppable: false }));
  list.appendChild(bmFolderRow({ iconName: 'tag', label: '未分类', count: uncategorized, key: '__none__' }));

  const sep = el('div', 'bm-folder-sep', '文件夹（拖到这里可移回顶层）');
  sep.addEventListener('dragover', (e) => { e.preventDefault(); sep.classList.add('drop'); });
  sep.addEventListener('dragleave', () => sep.classList.remove('drop'));
  sep.addEventListener('drop', async (e) => {
    e.preventDefault();
    sep.classList.remove('drop');
    const data = e.dataTransfer.getData('text/plain');
    if (!data || !data.startsWith('bm-folder:')) return;
    const src = data.slice('bm-folder:'.length);
    if (!src.includes('/')) return;
    const leaf = src.split('/').pop();
    await hub.renameBookmarkFolder(src, leaf);
    if (state.bmFolder === src) state.bmFolder = leaf;
    showSaved();
  });
  list.appendChild(sep);

  if (!state.bmOpen) state.bmOpen = new Set();
  const subtreeCount = (node) => node.count + node.children.reduce((n, c) => n + subtreeCount(c), 0);
  const renderNode = (node, depth, siblings, idx) => {
    const open = !state.bmOpen.has(node.name); // collapsed set — default open
    const row = bmFolderRow({
      iconName: 'folder',
      label: node.label,
      count: subtreeCount(node),
      key: node.name,
      depth,
    });
    if (node.children.length) {
      const caret = el('span', 'bm-caret', open ? '▾' : '▸');
      caret.onclick = (e) => {
        e.stopPropagation();
        if (open) state.bmOpen.add(node.name); else state.bmOpen.delete(node.name);
        renderSavedSidebar();
      };
      row.insertBefore(caret, row.firstChild);
    }
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'bm-folder:' + node.name);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const entries = [
        ['新建子文件夹', async () => {
          const n = await askText(`在「${node.label}」下新建子文件夹`);
          if (n) { await hub.createBookmarkFolder(`${node.name}/${n}`); state.bmFolder = `${node.name}/${n}`; showSaved(); }
        }],
        ['重命名', async () => {
          const n = await askText('文件夹新名称', node.label);
          if (n && n !== node.label) {
            const parent = node.name.includes('/') ? node.name.slice(0, node.name.lastIndexOf('/') + 1) : '';
            await hub.renameBookmarkFolder(node.name, parent + n);
            if (state.bmFolder === node.name) state.bmFolder = parent + n;
            showSaved();
          }
        }],
      ];
      if (idx > 0) entries.push(['上移', async () => {
        await hub.reorderBookmarkFolder(node.name, siblings[idx - 1].name, false);
        showSaved();
      }]);
      if (idx < siblings.length - 1) entries.push(['下移', async () => {
        await hub.reorderBookmarkFolder(node.name, siblings[idx + 1].name, true);
        showSaved();
      }]);
      entries.push(['删除（含子文件夹；收藏保留，回到未分类）', async () => {
        await hub.deleteBookmarkFolder(node.name);
        if (state.bmFolder === node.name || state.bmFolder.startsWith(node.name + '/')) state.bmFolder = '__all__';
        showSaved();
      }]);
      showMenuAt(e, entries);
    });
    list.appendChild(row);
    if (open) node.children.forEach((c, i) => renderNode(c, depth + 1, node.children, i));
  };
  const roots = bmFolderTree(folders);
  roots.forEach((n, i) => renderNode(n, 0, roots, i));

  const add = withIcon(el('div', 'bm-folder add'), 'plus', ' 新建文件夹', { size: 14 });
  add.onclick = async () => {
    const n = await askText('新建文件夹');
    if (n) { await hub.createBookmarkFolder(n); state.bmFolder = n; showSaved(); }
  };
  list.appendChild(add);
}

// Run a long toolbar action with a visible in-progress state so it can't be
// double-clicked and the user sees something is happening.
async function runBusy(btn, busyLabel, fn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

// Toolbar above the bookmark grid: AI actions and maintenance, grouped.
function bmToolbar() {
  const bar = el('div', 'bm-toolbar');
  const group = (label, defs) => {
    const g = el('div', 'bm-tool-group');
    g.appendChild(el('span', 'bm-tool-label', label));
    for (const [icon, text, title, fn, opts = {}] of defs) {
      const btn = withIcon(el('button', 'mini-btn' + (opts.accent ? ' ai-btn' : '')), icon, ' ' + text, { size: 13 });
      if (opts.badge) btn.appendChild(el('span', 'count-badge', String(opts.badge)));
      btn.title = title;
      if (opts.disabled) {
        btn.disabled = true;
        btn.title = opts.disabledTitle || title;
      } else {
        btn.onclick = () => runBusy(btn, opts.busy || '处理中…', fn);
      }
      g.appendChild(btn);
    }
    bar.appendChild(g);
  };
  const un = savedCache.uncategorized || 0;
  group('AI 助手', [
    ['wand', '整理今日历史', '批量分析今天的浏览历史，AI 挑选值得收藏的页面并归入文件夹，确认后入收藏', () => curateTodayFlow(), { accent: true, busy: '分析中…' }],
    ['wand', '整理未分类', '把所有未分类的收藏批量归入文件夹（预览确认后应用）', () => aiFileFlow('uncategorized'),
      { accent: true, busy: '整理中…', badge: un, disabled: !un, disabledTitle: '没有未分类的收藏' }],
    ['library', '结构建议', '基于全部收藏聚类出一套新的文件夹结构，预览确认后一键应用', () => aiFileFlow('all'), { accent: true, busy: '分析中…' }],
    ['sparkles', '问收藏', '基于收藏的离线正文回答问题，并给出来源', () => askBookmarksModal(), { accent: true }],
  ]);
  group('维护', [
    ['download', '导入书签', '把 Chrome / Edge / Firefox 等的书签连同文件夹结构一起导入（已有的不会覆盖）', async () => {
      const r = await hub.importBrowserBookmarks();
      toast(r.found ? `共发现 ${r.found} 条书签，新导入 ${r.imported} 条（已有的自动跳过）` : '没有在浏览器里发现书签');
      showSaved();
    }, { busy: '导入中…' }],
    ['download', '补齐离线存档', '为还没有离线副本的收藏抓取正文，供全文搜索和 AI 问答', async () => {
      const r = await hub.archiveMissingBookmarks();
      toast(r.done ? `已为 ${r.done} 条收藏补齐离线正文` : '所有收藏都已有离线副本');
      if (state.mode === 'bookmarks') showSaved();
    }, { busy: '抓取中，可能需要几分钟…' }],
    ['repeat', '重复检测', '找出重复或高度相似的收藏，建议合并删除（配置 AI Key 后可识别语义重复）', () => duplicatesFlow(), { busy: '检测中…' }],
    ['x-circle', '失效链接', '逐个访问收藏链接，找出 404/无法访问的失效收藏', () => deadLinksFlow(), { busy: '检测中，可能需要一两分钟…' }],
  ]);
  return bar;
}

// Simple yes/no confirmation dialog.
function askConfirm(msg, okLabel = '确定') {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal');
    const card = el('div', 'modal-card small');
    card.appendChild(el('h3', null, msg));
    const actions = el('div', 'modal-actions');
    const cancel = el('button', null, '取消');
    const ok = el('button', 'primary danger', okLabel);
    const done = (v) => { overlay.remove(); resolve(v); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  });
}

// ---------- AI batch filing (uncategorized → folders / full restructure) -----
async function aiFileFlow(scope) {
  toast(scope === 'all' ? 'AI 正在设计文件夹结构…' : 'AI 正在整理未分类收藏…');
  let r;
  try {
    r = await hub.aiFileBookmarks(scope);
  } catch (e) {
    toast(`整理失败：${String(e.message || e).replace(/^.*Error:\s*/, '')}`);
    return;
  }
  if (!r.items.length) {
    toast(scope === 'all' ? '当前结构已经很合理，没有建议的调整' : '没有未分类的收藏');
    return;
  }
  showAssignPreview(
    scope === 'all' ? 'AI 文件夹结构建议' : 'AI 整理未分类收藏',
    `共 ${r.total} 条收藏，建议调整 ${r.items.length} 条`,
    r.items,
    async (picks) => {
      const res = await hub.aiFileApply(picks);
      toast(`已移动 ${res.moved} 条收藏`);
      showSaved();
    }
  );
}

// Grouped, checkbox-per-item preview shared by both AI filing flows.
function showAssignPreview(title, subtitle, items, apply) {
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  const h = el('h3', null, `${title} `);
  h.appendChild(el('span', 'muted', subtitle));
  card.appendChild(h);
  const listBox = el('div', 'session-list curate-list');
  const byFolder = new Map();
  items.forEach((it, idx) => {
    if (!byFolder.has(it.folder)) byFolder.set(it.folder, []);
    byFolder.get(it.folder).push([idx, it]);
  });
  const boxes = [];
  for (const [folder, arr] of byFolder) {
    const head = el('div', 'dash-title curate-folder');
    head.appendChild(withIcon(el('span'), 'folder', ` ${folder}`, { size: 13 }));
    head.appendChild(el('span', 'count-badge', String(arr.length)));
    listBox.appendChild(head);
    for (const [idx, it] of arr) {
      const row = el('label', 'curate-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.idx = String(idx);
      boxes.push(cb);
      row.appendChild(cb);
      const body = el('div', 'curate-main');
      const t = el('div', 'title', it.title || it.url);
      t.title = it.url;
      body.appendChild(t);
      const sub = el('div', 'entry-sub');
      if (it.oldFolder) sub.appendChild(el('span', 'desc', `${it.oldFolder} → ${it.folder}`));
      else if (it.domain) sub.appendChild(el('span', 'domain-name', it.domain));
      if (it.tags && it.tags.length) sub.appendChild(el('span', 'desc', ' · ' + it.tags.join('、')));
      body.appendChild(sub);
      row.appendChild(body);
      listBox.appendChild(row);
    }
  }
  card.appendChild(listBox);
  const actions = el('div', 'modal-actions');
  const toggle = el('button', null, '全选 / 全不选');
  toggle.onclick = () => {
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !all; });
  };
  const cancel = el('button', null, '取消');
  cancel.onclick = () => overlay.remove();
  const ok = el('button', 'primary', '应用选中项');
  ok.onclick = async () => {
    const picks = boxes.filter((b) => b.checked).map((b) => items[Number(b.dataset.idx)]).filter(Boolean);
    overlay.remove();
    if (!picks.length) { toast('没有勾选任何条目'); return; }
    await apply(picks);
  };
  actions.appendChild(toggle);
  actions.appendChild(cancel);
  actions.appendChild(ok);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---------- duplicate detection ----------------------------------------------
async function duplicatesFlow() {
  toast('正在检测重复收藏…');
  let groups;
  try {
    groups = await hub.bookmarkDuplicates();
  } catch (e) {
    toast(`检测失败：${String(e.message || e).replace(/^.*Error:\s*/, '')}`);
    return;
  }
  if (!groups.length) { toast('没有发现重复收藏'); return; }
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  card.appendChild(el('h3', null, `重复收藏检测：${groups.length} 组`));
  const box = el('div', 'session-list curate-list');
  for (const g of groups) {
    const head = el('div', 'dash-title curate-folder');
    head.appendChild(withIcon(el('span'), 'repeat', ` ${g.reason}`, { size: 13 }));
    head.appendChild(el('span', 'count-badge', String(g.items.length)));
    box.appendChild(head);
    g.items.forEach((it, i) => {
      const row = el('div', 'curate-row');
      const body = el('div', 'curate-main');
      const t = el('div', 'title', (i === 0 ? '★ ' : '') + (it.title || it.url));
      t.title = it.url;
      t.style.cursor = 'pointer';
      t.onclick = () => openUrl(it.url);
      body.appendChild(t);
      body.appendChild(el('div', 'entry-sub')).appendChild(el('span', 'desc', it.url.slice(0, 90)));
      row.appendChild(body);
      if (i > 0) {
        const rm = el('button', 'mini-btn danger', '删除');
        rm.onclick = async () => { await hub.removeBookmark(it.url); await hub.removeReadLater(it.url); row.remove(); toast('已删除'); };
        row.appendChild(rm);
      }
      box.appendChild(row);
    });
  }
  card.appendChild(box);
  card.appendChild(el('div', 'side-hint', '每组第一条（★）为保留建议，其余可按需删除'));
  const actions = el('div', 'modal-actions');
  const rmAll = el('button', 'danger', '删除所有重复项（每组保留第一条）');
  rmAll.onclick = async () => {
    const total = groups.reduce((n, g) => n + g.items.length - 1, 0);
    if (!(await askConfirm(`确定删除 ${total} 条重复收藏（每组保留第一条）？`, '删除'))) return;
    let n = 0;
    for (const g of groups) for (const it of g.items.slice(1)) { await hub.removeBookmark(it.url); await hub.removeReadLater(it.url); n++; }
    overlay.remove();
    toast(`已删除 ${n} 条重复收藏`);
    showSaved();
  };
  const close = el('button', 'primary', '关闭');
  close.onclick = () => { overlay.remove(); showSaved(); };
  actions.appendChild(rmAll);
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---------- dead link check ---------------------------------------------------
async function deadLinksFlow() {
  toast('正在逐个检测收藏链接，可能需要一两分钟…');
  let r;
  try {
    r = await hub.checkBookmarkLinks();
  } catch (e) {
    toast(`检测失败：${String(e.message || e)}`);
    return;
  }
  if (!r.dead.length) { toast(`已检测 ${r.checked} 条收藏，全部可以访问`); return; }
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  card.appendChild(el('h3', null, `失效链接：${r.dead.length} / ${r.checked} 条`));
  const box = el('div', 'session-list curate-list');
  for (const d of r.dead) {
    const row = el('div', 'curate-row');
    const body = el('div', 'curate-main');
    const t = el('div', 'title', d.title || d.url);
    t.title = d.url;
    t.style.cursor = 'pointer';
    t.onclick = () => openUrl(d.url);
    body.appendChild(t);
    const sub = el('div', 'entry-sub');
    sub.appendChild(el('span', 'desc', d.status ? `HTTP ${d.status}` : `无法访问（${d.error || '超时'}）`));
    if (d.folder) sub.appendChild(el('span', 'desc', ' · ' + d.folder));
    body.appendChild(sub);
    row.appendChild(body);
    const rm = el('button', 'mini-btn danger', '删除');
    rm.onclick = async () => { await hub.removeBookmark(d.url); await hub.removeReadLater(d.url); row.remove(); toast('已删除'); };
    row.appendChild(rm);
    box.appendChild(row);
  }
  card.appendChild(box);
  card.appendChild(el('div', 'side-hint', '部分站点会拦截自动请求，删除前可先点标题人工确认'));
  const actions = el('div', 'modal-actions');
  const rmAll = el('button', 'danger', '全部删除');
  rmAll.onclick = async () => {
    if (!(await askConfirm(`确定删除全部 ${r.dead.length} 条失效收藏？`, '删除'))) return;
    for (const d of r.dead) { await hub.removeBookmark(d.url); await hub.removeReadLater(d.url); }
    overlay.remove();
    toast(`已删除 ${r.dead.length} 条失效收藏`);
    showSaved();
  };
  const close = el('button', 'primary', '关闭');
  close.onclick = () => { overlay.remove(); showSaved(); };
  actions.appendChild(rmAll);
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---------- related bookmarks --------------------------------------------------
async function relatedModal(m) {
  const rel = await hub.relatedBookmarks(m.url);
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  card.appendChild(el('h3', null, `相关收藏：${(m.title || m.url).slice(0, 40)}`));
  if (!rel.length) {
    card.appendChild(el('div', 'empty', '暂无相关收藏（关键词还没生成时，可先等后台 AI 摘要跑完或点「AI 整理」）'));
  } else {
    for (const it of rel) {
      const row = el('div', 'mem-row');
      row.appendChild(faviconEl(it));
      const t = el('span', 'title', it.title);
      t.title = it.url;
      t.onclick = () => openUrl(it.url);
      row.appendChild(t);
      if (it.folder) row.appendChild(el('span', 'bm-folder-tag', it.folder));
      card.appendChild(row);
    }
  }
  const actions = el('div', 'modal-actions');
  const close = el('button', 'primary', '关闭');
  close.onclick = () => overlay.remove();
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// -------------- AI curate: today's history → bookmark folders ---------------
let curateItems = [];

async function curateTodayFlow() {
  toast('AI 正在分析今天的浏览记录…');
  let r;
  try {
    r = await hub.curateDay(todayKey());
  } catch (e) {
    toast(`整理失败：${String(e.message || e).replace(/^.*Error:\s*/, '')}`);
    return;
  }
  curateItems = r.items || [];
  if (!curateItems.length) {
    toast('今天没有可收藏的新页面（已收藏或均为噪音记录）');
    return;
  }
  document.getElementById('curateInfo').textContent =
    `从今天 ${r.candidates} 个网页中挑出 ${curateItems.length} 条建议`;
  const list = document.getElementById('curateList');
  list.innerHTML = '';
  const byFolder = new Map();
  curateItems.forEach((it, idx) => {
    const f = it.folder || '未分类';
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push([idx, it]);
  });
  for (const [folder, arr] of byFolder) {
    const head = el('div', 'dash-title curate-folder');
    head.appendChild(withIcon(el('span'), 'folder', ` ${folder}`, { size: 13 }));
    head.appendChild(el('span', 'count-badge', String(arr.length)));
    list.appendChild(head);
    for (const [idx, it] of arr) {
      const row = el('label', 'curate-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.idx = String(idx);
      row.appendChild(cb);
      const body = el('div', 'curate-main');
      const t = el('div', 'title', it.title || it.url);
      t.title = it.url;
      body.appendChild(t);
      const sub = el('div', 'entry-sub');
      if (it.domain) sub.appendChild(el('span', 'domain-name', it.domain));
      if (it.tags && it.tags.length) sub.appendChild(el('span', 'desc', ' · ' + it.tags.join('、')));
      if (it.reason) sub.appendChild(el('span', 'desc', ' · ' + it.reason));
      body.appendChild(sub);
      row.appendChild(body);
      list.appendChild(row);
    }
  }
  document.getElementById('curateModal').classList.remove('hidden');
}

// AI Q&A over offline-archived bookmark contents.
async function askBookmarksModal() {
  const q = await askText('问收藏：例如“我收藏过哪篇讲 SQLite WAL 的文章？”');
  if (!q) return;
  toast('AI 正在阅读你的收藏…');
  let r;
  try {
    r = await hub.askBookmarks(q);
  } catch (e) {
    toast(String(e.message || e).replace(/^.*Error: /, ''));
    return;
  }
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  card.appendChild(el('h3', null, `问收藏：${q}`));
  const bodyBox = el('div', 'bm-ask-answer', r.answer || '（没有答案）');
  card.appendChild(bodyBox);
  if (r.refs && r.refs.length) {
    card.appendChild(el('div', 'dash-title', '来源'));
    for (const ref of r.refs) {
      const row = el('div', 'mem-row');
      row.appendChild(faviconEl(ref));
      const t = el('span', 'title', ref.title || ref.url);
      t.title = ref.url;
      t.onclick = () => openUrl(ref.url);
      row.appendChild(t);
      card.appendChild(row);
    }
  }
  const actions = el('div', 'modal-actions');
  const close = el('button', 'primary', '关闭');
  close.onclick = () => overlay.remove();
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Offline archived copy viewer.
async function openArchiveModal(m) {
  const rec = await hub.bookmarkContent(m.url);
  const overlay = el('div', 'modal');
  const card = el('div', 'modal-card');
  card.appendChild(el('h3', null, m.title || m.url));
  if (rec && rec.content) {
    card.appendChild(el('div', 'sub', `离线存档于 ${new Date(rec.archivedAt).toLocaleString('zh-CN')} · ${rec.content.length} 字`));
    const pre = el('pre', 'bm-archive-text', rec.content);
    card.appendChild(pre);
  } else {
    card.appendChild(el('div', 'empty', '还没有离线副本，点左侧「补齐离线存档」或稍后再试'));
  }
  const actions = el('div', 'modal-actions');
  if (rec && rec.content) {
    const copy = el('button', null, '复制全文');
    copy.onclick = async () => { await hub.copyText(rec.content); toast('已复制离线正文'); };
    actions.appendChild(copy);
  }
  const close = el('button', 'primary', '关闭');
  close.onclick = () => overlay.remove();
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Async text prompt (window.prompt is not available in Electron renderers).
function askText(label, def = '', allowEmpty = false) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal');
    const card = el('div', 'modal-card small');
    card.appendChild(el('h3', null, label));
    const input = el('input');
    input.type = 'text';
    input.value = def;
    card.appendChild(input);
    const actions = el('div', 'modal-actions');
    const cancel = el('button', null, '取消');
    const ok = el('button', 'primary', '确定');
    const done = (v) => { overlay.remove(); resolve(v); };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(input.value.trim() || (allowEmpty ? '' : null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.onclick();
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

// Minimal ad-hoc context menu reusing #ctxMenu styles.
function showMenuAt(e, entries) {
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';
  for (const [label, fn] of entries) {
    const it = el('div', 'ctx-item', label);
    it.onclick = () => { menu.classList.add('hidden'); fn(); };
    menu.appendChild(it);
  }
  menu.classList.remove('hidden');
  menu.style.left = Math.min(e.clientX, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - entries.length * 34 - 10) + 'px';
}

const BM_FOLDER_LABELS = { __all__: '全部收藏', __unread__: '未读', __none__: '未分类' };

async function showSaved() {
  state.mode = 'bookmarks';
  if (!state.bmFolder) state.bmFolder = '__all__';
  if (!state.bmSelected) state.bmSelected = new Set();
  const [bms, rls, fold] = await Promise.all([
    hub.listBookmarks(), hub.listReadLater(true), hub.bookmarkFolders(),
  ]);
  const rlMap = new Map(rls.map((r) => [r.url, r]));
  const merged = [];
  const seen = new Set();
  for (const b of bms) {
    merged.push({ ...(rlMap.get(b.url) || {}), ...b });
    seen.add(b.url);
  }
  for (const r of rls) if (!seen.has(r.url)) merged.push(r);

  savedCache = { merged, rlMap, folders: fold.folders, uncategorized: fold.uncategorized };
  renderSavedSidebar();

  const q = document.getElementById('bmFilter').value.trim();
  let items = merged;
  if (state.bmFolder === '__unread__') items = items.filter((m) => rlMap.has(m.url) && !m.doneAt);
  else if (state.bmFolder === '__none__') items = items.filter((m) => !m.folder);
  else if (state.bmFolder !== '__all__') {
    // A folder shows its whole subtree.
    items = items.filter((m) => m.folder === state.bmFolder || (m.folder || '').startsWith(state.bmFolder + '/'));
  }
  if (q) {
    // Full-text: title/url fuzzy OR a hit inside the offline archived copy.
    const deep = await hub.searchBookmarks(q);
    const deepMap = new Map(deep.map((d) => [d.url, d.snippet]));
    items = items.filter((m) => fuzzyMatch((m.title || '') + ' ' + m.url, q) || deepMap.has(m.url));
    for (const m of items) if (deepMap.get(m.url)) m._snippet = deepMap.get(m.url);
  }

  const sort = state.bmSort || 'recent';
  items = [...items];
  if (sort === 'title') items.sort((a, b) => String(a.title || a.url).localeCompare(String(b.title || b.url), 'zh'));
  else if (sort === 'domain') items.sort((a, b) => String(a.domain || '').localeCompare(String(b.domain || '')) || (b.createdAt || 0) - (a.createdAt || 0));
  else items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), state.bmFolder in BM_FOLDER_LABELS ? 'star' : 'folder', ` 收藏 · ${BM_FOLDER_LABELS[state.bmFolder] || state.bmFolder}`));
  header.appendChild(el('span', 'sub', `${items.length} 条` + (q ? `（筛选「${q}」）` : '')));

  const tools = el('span', 'bm-tools');
  const sortSel = document.createElement('select');
  sortSel.className = 'bm-sort';
  for (const [v, label] of [['recent', '最近收藏'], ['title', '按标题'], ['domain', '按域名']]) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    sortSel.appendChild(opt);
  }
  sortSel.value = sort;
  sortSel.onchange = () => { state.bmSort = sortSel.value; showSaved(); };
  tools.appendChild(sortSel);
  const batchBtn = el('button', 'mini-btn' + (state.bmSelect ? ' active' : ''), state.bmSelect ? '退出批量' : '批量管理');
  batchBtn.onclick = () => {
    state.bmSelect = !state.bmSelect;
    state.bmSelected = new Set();
    showSaved();
  };
  tools.appendChild(batchBtn);
  if (state.bmSelect) {
    const cnt = el('span', 'sub');
    cnt.id = 'bmBatchCount';
    cnt.textContent = `已选 ${state.bmSelected.size}`;
    tools.appendChild(cnt);
    const selAll = el('button', 'mini-btn', '全选/全不选');
    selAll.onclick = () => {
      const all = items.every((m) => state.bmSelected.has(m.url));
      state.bmSelected = all ? new Set() : new Set(items.map((m) => m.url));
      showSaved();
    };
    tools.appendChild(selAll);
    const withSel = (fn) => async (e) => {
      const urls = [...state.bmSelected];
      if (!urls.length) { toast('先勾选要操作的收藏'); return; }
      await fn(urls, e);
    };
    const mv = el('button', 'mini-btn', '移动到…');
    mv.onclick = withSel(async (urls, e) => {
      const entries = savedCache.folders.map((f) => [
        `移到「${f.name}」`, async () => {
          for (const u of urls) await hub.setBookmarkFolder(u, f.name);
          toast(`已移动 ${urls.length} 条到「${f.name}」`);
          state.bmSelected = new Set();
          showSaved();
        },
      ]);
      entries.push(['移出文件夹', async () => {
        for (const u of urls) await hub.setBookmarkFolder(u, null);
        state.bmSelected = new Set();
        showSaved();
      }]);
      entries.push(['＋ 新建文件夹并移入', async () => {
        const n = await askText('新建文件夹并移入');
        if (!n) return;
        for (const u of urls) await hub.setBookmarkFolder(u, n);
        state.bmSelected = new Set();
        showSaved();
      }]);
      showMenuAt(e, entries);
    });
    tools.appendChild(mv);
    const mkRead = el('button', 'mini-btn', '标记已读');
    mkRead.onclick = withSel(async (urls) => {
      let n = 0;
      for (const u of urls) if (savedCache.rlMap.has(u)) { await hub.markReadLaterDone(u, true); n++; }
      toast(n ? `已标记 ${n} 条为已读` : '选中项里没有待读条目');
      state.bmSelected = new Set();
      showSaved();
    });
    tools.appendChild(mkRead);
    const del = el('button', 'mini-btn danger', '删除');
    del.onclick = withSel(async (urls) => {
      if (!(await askConfirm(`确定删除选中的 ${urls.length} 条收藏？`, '删除'))) return;
      for (const u of urls) { await hub.removeBookmark(u); await hub.removeReadLater(u); }
      toast(`已删除 ${urls.length} 条收藏`);
      state.bmSelected = new Set();
      showSaved();
    });
    tools.appendChild(del);
  }
  header.appendChild(tools);
  document.getElementById('summaryBox').classList.add('hidden');
  document.getElementById('statsBox').classList.add('hidden');
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  body.appendChild(bmToolbar());
  if (merged.length === 0) {
    body.appendChild(emptyState('star', '还没有收藏：点记录右侧星标，或右键记录选「收藏」'));
    return;
  }
  if (items.length === 0) {
    body.appendChild(el('div', 'empty', q ? `没有匹配「${q}」的收藏` : '这个文件夹还是空的：把右侧卡片拖到左侧文件夹即可归类'));
    return;
  }
  const grid = el('div', 'bm-grid');
  for (const m of items) grid.appendChild(bmCard(m));
  body.appendChild(grid);
}

// 收藏卡片：封面（缩略图或首字母渐变）+ 站点 + 标题 + 摘要 + 操作。
function bmCard(m) {
  const card = el('div', 'bm-card');
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', m.url);
    e.dataTransfer.effectAllowed = 'move';
  });

  // Cover: page thumbnail when available, letter-gradient otherwise.
  const cover = el('div', 'bm-cover');
  if (m.thumb) {
    const img = el('img');
    img.src = thumbUrl(m.thumb);
    img.onerror = () => { img.remove(); cover.appendChild(bmLetterCover(m.domain)); };
    cover.appendChild(img);
  } else {
    cover.appendChild(bmLetterCover(m.domain));
  }
  if (savedCache.rlMap.has(m.url) && !m.doneAt) cover.appendChild(el('span', 'bm-badge', '未读'));
  cover.onclick = () => openUrl(m.url);
  if (state.bmSelect) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'bm-check';
    cb.checked = state.bmSelected.has(m.url);
    const toggleSel = () => {
      if (state.bmSelected.has(m.url)) state.bmSelected.delete(m.url);
      else state.bmSelected.add(m.url);
      cb.checked = state.bmSelected.has(m.url);
      card.classList.toggle('selected', cb.checked);
      const c = document.getElementById('bmBatchCount');
      if (c) c.textContent = `已选 ${state.bmSelected.size}`;
    };
    cb.onclick = (e) => { e.stopPropagation(); toggleSel(); };
    cover.appendChild(cb);
    cover.onclick = toggleSel;
    if (cb.checked) card.classList.add('selected');
  }
  card.appendChild(cover);

  const info = el('div', 'bm-info');
  const site = el('div', 'bm-site');
  site.appendChild(faviconEl(m));
  site.appendChild(el('span', 'bm-domain', m.domain || ''));
  if (m.folder) site.appendChild(el('span', 'bm-folder-tag', m.folder));
  info.appendChild(site);

  const t = el('div', 'bm-title' + (m.doneAt ? ' done' : ''), m.title || m.url);
  t.title = m.url;
  t.onclick = () => openUrl(m.url);
  info.appendChild(t);

  const descText = m.summary || m.description || m.note;
  if (descText) info.appendChild(el('div', 'bm-desc', String(descText).slice(0, 90)));
  if (m._snippet) info.appendChild(el('div', 'bm-snippet', `…${m._snippet}…`));
  if (m.tags && m.tags.length) {
    const tags = el('div', 'bm-tags');
    for (const tg of m.tags.slice(0, 5)) tags.appendChild(el('span', 'bm-tag', tg));
    info.appendChild(tags);
  }
  card.appendChild(info);

  const foot = el('div', 'bm-foot');
  const moveBtn = withIcon(el('button', 'mini-btn'), 'folder', ' 移动', { size: 12 });
  moveBtn.onclick = (e) => {
    e.stopPropagation();
    const entries = savedCache.folders.map((f) => [
      `移到「${f.name}」`, async () => { await hub.setBookmarkFolder(m.url, f.name); showSaved(); },
    ]);
    if (m.folder) entries.push(['移出文件夹', async () => { await hub.setBookmarkFolder(m.url, null); showSaved(); }]);
    entries.push(['＋ 新建文件夹并移入', async () => {
      const n = await askText('新建文件夹并移入');
      if (n) { await hub.setBookmarkFolder(m.url, n); showSaved(); }
    }]);
    showMenuAt(e, entries);
  };
  foot.appendChild(moveBtn);
  const arcBtn = withIcon(el('button', 'mini-btn'), 'copy', ' 原文', { size: 12 });
  arcBtn.title = '查看离线存档的正文（断网也能看）';
  arcBtn.onclick = (e) => { e.stopPropagation(); openArchiveModal(m); };
  foot.appendChild(arcBtn);
  const noteBtn = el('button', 'mini-btn', '备注');
  noteBtn.title = m.note ? `备注：${m.note}` : '添加备注';
  noteBtn.onclick = async (e) => {
    e.stopPropagation();
    const v = await askText('编辑备注（清空内容后确定可删除备注）', m.note || '', true);
    if (v === null) return;
    await hub.setBookmarkNote(m.url, v);
    toast(v ? '已保存备注' : '已清空备注');
    showSaved();
  };
  foot.appendChild(noteBtn);
  const relBtn = el('button', 'mini-btn', '相关');
  relBtn.title = '看看库里有哪些相关收藏';
  relBtn.onclick = (e) => { e.stopPropagation(); relatedModal(m); };
  foot.appendChild(relBtn);
  if (savedCache.rlMap.has(m.url)) {
    const doneBtn = el('button', 'mini-btn', m.doneAt ? '恢复未读' : '读完');
    doneBtn.onclick = async (e) => { e.stopPropagation(); await hub.markReadLaterDone(m.url, !m.doneAt); showSaved(); };
    foot.appendChild(doneBtn);
  }
  const rm = el('button', 'mini-btn danger', '删除');
  rm.onclick = async (e) => {
    e.stopPropagation();
    await hub.removeBookmark(m.url);
    await hub.removeReadLater(m.url);
    toast('已删除收藏', '撤销', async () => { await hub.addBookmark({ url: m.url, title: m.title, note: m.note || '' }); if (m.folder) await hub.setBookmarkFolder(m.url, m.folder); showSaved(); });
    showSaved();
  };
  foot.appendChild(rm);
  card.appendChild(foot);
  return card;
}

// Compact saved-item row (used by today dashboard lists).
function savedRow(r, hasReadState, refresh) {
  const row = el('div', 'entry');
  const main = el('div', 'entry-main');
  main.appendChild(faviconEl(r));
  const t = el('span', 'title' + (r.doneAt ? ' done' : ''), r.title || r.url);
  t.title = r.url;
  t.onclick = () => openUrl(r.url);
  main.appendChild(t);
  if (r.category) main.appendChild(el('span', 'cat-tag', r.category));
  if (hasReadState) {
    const doneBtn = r.doneAt ? el('button', 'mini-btn', '恢复未读') : withIcon(el('button', 'mini-btn'), 'check', ' 读完', { size: 12 });
    doneBtn.onclick = async () => { await hub.markReadLaterDone(r.url, !r.doneAt); refresh(); };
    main.appendChild(doneBtn);
  }
  const rm = el('button', 'mini-btn danger', '删除');
  rm.onclick = async () => { await hub.removeBookmark(r.url); await hub.removeReadLater(r.url); refresh(); };
  main.appendChild(rm);
  const body = el('div', 'entry-body');
  body.appendChild(main);
  if (r.summary || r.description) {
    const sub = el('div', 'entry-sub');
    sub.appendChild(r.summary ? withIcon(el('span', 'ai-summary'), 'sparkles', ' ' + r.summary, { size: 12 }) : el('span', 'desc', r.description.slice(0, 120)));
    body.appendChild(sub);
  }
  row.appendChild(body);
  return row;
}

function bmLetterCover(domain) {
  const box = el('div', 'bm-letter');
  box.textContent = (String(domain || '?').replace(/^www\./, '')[0] || '?').toUpperCase();
  const h = domainHue(domain);
  box.style.background = `linear-gradient(135deg, hsl(${h},52%,42%), hsl(${(h + 50) % 360},52%,30%))`;
  return box;
}

// ------------------------- today dashboard ---------------------------------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Flatten a day timeline (hours → domains → entries) into a flat item list.
function flattenTimelineItems(tl) {
  const items = [];
  for (const h of tl.hours || []) {
    for (const g of h.domains) {
      for (const item of g.entries) items.push(item);
    }
  }
  return items;
}

// 今日速览卡片：核心数字、与昨天环比、最活跃时段、最常访问站点。
function buildTodayOverview(stats, yStats, tl) {
  const sec = el('div', 'dash-section');
  sec.appendChild(withIcon(el('div', 'dash-title'), 'sun', ' 今日速览', { size: 14 }));

  // 与昨天访问数环比
  const delta = (cur, prev) => {
    const chip = el('span', 'delta');
    if (!prev) { chip.textContent = '较昨天 —'; chip.classList.add('flat'); return chip; }
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct > 0) { chip.textContent = `较昨天 ↑${pct}%`; chip.classList.add('up'); }
    else if (pct < 0) { chip.textContent = `较昨天 ↓${Math.abs(pct)}%`; chip.classList.add('down'); }
    else { chip.textContent = '较昨天 持平'; chip.classList.add('flat'); }
    return chip;
  };

  const cards = el('div', 'overview-cards');
  const card = (n, label, extra) => {
    const c = el('div', 'overview-card');
    c.appendChild(el('div', 'overview-n', String(n)));
    c.appendChild(el('div', 'overview-l', label));
    if (extra) c.appendChild(extra);
    return c;
  };
  cards.appendChild(card(stats.visits, '访问', delta(stats.visits, yStats && yStats.visits)));
  cards.appendChild(card(stats.distinctUrls, '网页'));
  cards.appendChild(card(stats.distinctDomains, '网站'));

  // 最活跃时段
  let peakHour = -1;
  let peakCount = 0;
  for (const h of tl.hours || []) {
    const c = h.domains.reduce((n, g) => n + g.count, 0);
    if (c > peakCount) { peakCount = c; peakHour = h.hour; }
  }
  const peakLabel = peakHour >= 0 ? `${String(peakHour).padStart(2, '0')}:00` : '—';
  const peak = card(peakLabel, '最活跃时段');
  if (peakHour >= 0) peak.appendChild(el('div', 'overview-hint', `${peakCount} 条`));
  cards.appendChild(peak);

  // 最常访问站点
  const top = stats.topDomains && stats.topDomains[0];
  const topCard = el('div', 'overview-card');
  topCard.appendChild(el('div', 'overview-n small', top ? top.domain : '—'));
  topCard.appendChild(el('div', 'overview-l', '最常访问'));
  if (top) topCard.appendChild(el('div', 'overview-hint', `${top.count} 次`));
  cards.appendChild(topCard);

  sec.appendChild(cards);
  return sec;
}

// 今日分类分布：按今日记录的 AI 分类聚合成条形。
function buildTodayCategories(tl) {
  const counts = new Map();
  const seen = new Set();
  for (const item of flattenTimelineItems(tl)) {
    if (!item.category) continue;
    if (seen.has(item.url)) continue; // 按去重后的网页计数
    seen.add(item.url);
    counts.set(item.category, (counts.get(item.category) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows[0][1] || 1;
  const sec = el('div', 'dash-section');
  sec.appendChild(withIcon(el('div', 'dash-title'), 'tag', ' 今日分类分布', { size: 14 }));
  const wrap = el('div', 'stats-top');
  for (const [cat, n] of rows) {
    const rowEl = el('div', 'top-row');
    rowEl.appendChild(el('span', 'top-domain', cat));
    const bar = el('div', 'top-bar');
    const fill = el('div', 'top-fill');
    fill.style.width = `${Math.max(6, Math.round((n / max) * 100))}%`;
    bar.appendChild(fill);
    rowEl.appendChild(bar);
    rowEl.appendChild(el('span', 'top-count', String(n)));
    wrap.appendChild(rowEl);
  }
  sec.appendChild(wrap);
  return sec;
}

// 今日关键词 Top：聚合今日记录的关键词成词条 chips。
function buildTodayKeywords(tl) {
  const counts = new Map();
  const seen = new Set();
  for (const item of flattenTimelineItems(tl)) {
    if (!item.keywords || !item.keywords.length) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    for (const kw of item.keywords) {
      const k = String(kw).trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const sec = el('div', 'dash-section');
  sec.appendChild(withIcon(el('div', 'dash-title'), 'sparkles', ' 今日关键词', { size: 14 }));
  const cloud = el('div', 'kw-cloud');
  for (const [kw, n] of rows) {
    const chip = el('span', 'kw', n > 1 ? `${kw} ×${n}` : kw);
    cloud.appendChild(chip);
  }
  sec.appendChild(cloud);
  return sec;
}

async function showToday() {
  state.mode = 'today';
  const day = todayKey();
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), 'sun', ` 今日 ${day}`));
  if (state.browserFilter) header.appendChild(el('span', 'sub', '（已按浏览器筛选）'));
  const headerActions = el('div', 'header-actions');
  const reopenToday = el('button', 'restore-btn', '重开今日访问过的页面');
  reopenToday.title = '根据今日浏览历史，用系统默认浏览器打开网址。不是恢复当前已打开的页签。';
  reopenToday.onclick = () => openSessionModal(day, null);
  const saveLive = el('button', 'restore-btn', '保存已打开的页签');
  const sessionUi = sessionFileUi();
  saveLive.title = sessionUi && sessionUi.todaySaveOpenTabsTitle
    ? sessionUi.todaySaveOpenTabsTitle()
    : '已配对扩展时，保存此刻真实已打开的页签。未配对时改为从会话文件读取已写盘的页签，先预览再确认保存。';
  saveLive.onclick = async () => {
    let paired = false;
    try {
      const st = await hub.bridgeStatus();
      const cap = window.TraceHubCapabilities;
      const d = cap ? cap.describeBridge(st) : st;
      paired = !!(d && d.recentlySeen);
    } catch (e) { paired = false; }
    if (paired) {
      switchTab('snapshots');
      return;
    }
    const hint = sessionUi && sessionUi.todaySaveOpenTabsUnpairedHint
      ? sessionUi.todaySaveOpenTabsUnpairedHint()
      : '未配对扩展。改为从会话文件读取已写盘的页签，请先预览再确认保存。';
    toast(hint);
    state.startSessionFileAfterSnapshots = true;
    switchTab('snapshots');
  };
  const curBtnTop = el('button', 'restore-btn ai', 'AI 整理今日历史');
  curBtnTop.onclick = () => curateTodayFlow();
  const repairToday = el('button', 'restore-btn', '重新同步这一天');
  repairToday.title = '从各浏览器现存历史把今天缺失或异常的访问补进软件。其他日期不受影响，已有记录不会被删掉。';
  repairToday.onclick = () => repairVisibleDay(day);
  headerActions.appendChild(reopenToday);
  headerActions.appendChild(saveLive);
  headerActions.appendChild(repairToday);
  headerActions.appendChild(curBtnTop);
  header.appendChild(headerActions);
  document.getElementById('summaryBox').classList.add('hidden');
  const yKey = dayKeyLocal(new Date(Date.now() - 86400000));
  const [stats, yStats, tl, readLater, revisits] = await Promise.all([
    hub.statsForDay(day, state.browserFilter || null),
    hub.statsForDay(yKey, state.browserFilter || null),
    hub.timelineForDay(day, state.browserFilter || null),
    hub.listReadLater(false),
    hub.revisitInsights(),
  ]);
  if (state.mode !== 'today') return;
  state.lastTimeline = { day, tl };
  document.getElementById('btnDaySummary').classList.toggle('active', state.summaryDay === day);
  renderStats(stats);
  const body = document.getElementById('contentBody');
  body.innerHTML = '';

  // 今日速览：核心数字 + 与昨天环比 + 最活跃时段 + 最常访问站点
  body.appendChild(buildTodayOverview(stats, yStats, tl));

  // 24 小时分布：0-23 每个小时都展示，点击有数据的小时查看记录
  const hourSec = el('div', 'dash-section');
  hourSec.appendChild(withIcon(el('div', 'dash-title'), 'clock', ' 今日 24 小时分布（点击柱子查看该时段记录）', { size: 14 }));
  const counts = new Array(24).fill(0);
  const byHour = new Map();
  for (const h of tl.hours || []) {
    counts[h.hour] = h.domains.reduce((n, g) => n + g.count, 0);
    byHour.set(h.hour, h);
  }
  const maxN = Math.max(...counts, 1);
  const nowHour = new Date().getHours();
  const chart = el('div', 'hour-chart');
  const detail = el('div', 'hour-detail');
  let openHour = null;
  const cols = [];
  const sideRows = [];
  const renderDetail = (h, toggle = true) => {
    detail.innerHTML = '';
    cols.forEach((c) => c.classList.remove('active'));
    sideRows.forEach((r) => r.classList.remove('active'));
    if ((toggle && openHour === h) || counts[h] === 0) { openHour = null; return; }
    openHour = h;
    cols[h].classList.add('active');
    if (sideRows[h]) sideRows[h].classList.add('active');
    const detailHead = el('div', 'hour-detail-head');
    detailHead.appendChild(el('div', 'dash-title', `${String(h).padStart(2, '0')}:00 - ${String(h).padStart(2, '0')}:59（${counts[h]} 条）`));
    const reopenHour = withIcon(el('button', 'restore-btn'), 'refresh', ' 重开本时段访问过的网址', { size: 12 });
    reopenHour.title = '按浏览历史用系统默认浏览器打开网址，不是恢复当时已打开的页签、窗口或登录状态。';
    reopenHour.onclick = (e) => { e.stopPropagation(); openSessionModal(day, h); };
    detailHead.appendChild(reopenHour);
    detail.appendChild(detailHead);
    const hb = byHour.get(h);
    const all = [];
    for (const g of hb.domains) for (const item of g.entries) all.push(item);
    // Incremental rendering keeps huge hours responsive.
    let shown = 0;
    const box = el('div');
    const more = el('div', 'more-link');
    const append = () => {
      const next = Math.min(all.length, shown + 50);
      for (const item of all.slice(shown, next)) box.appendChild(entryRow(item));
      shown = next;
      more.classList.toggle('hidden', shown >= all.length);
      more.textContent = `加载更多（还有 ${all.length - shown} 条）`;
    };
    more.onclick = append;
    append();
    detail.appendChild(box);
    detail.appendChild(more);
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 左侧面板：0-23 小时列表
  const hourList = document.getElementById('tdHours');
  hourList.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const row = el('div', 'hour-row' + (counts[h] === 0 ? ' zero' : '') + (h === new Date().getHours() ? ' now' : ''));
    row.appendChild(el('span', 'hour-row-label', `${String(h).padStart(2, '0')}:00`));
    const gauge = el('div', 'hour-row-gauge');
    const fill = el('div', 'hour-row-fill');
    gauge.appendChild(fill);
    row.appendChild(gauge);
    row.appendChild(el('span', 'hour-row-count', counts[h] ? String(counts[h]) : ''));
    if (counts[h]) {
      const reopen = el('button', 'mini-btn hour-reopen', '重开');
      reopen.title = '按浏览历史打开此时段访问过的网址，不是恢复当时已打开的页签。';
      reopen.onclick = (e) => { e.stopPropagation(); openSessionModal(day, h); };
      row.appendChild(reopen);
    }
    row.onclick = () => renderDetail(h, false);
    sideRows.push(row);
    hourList.appendChild(row);
    requestAnimationFrame(() => { fill.style.width = `${counts[h] ? Math.max(6, Math.round((counts[h] / Math.max(...counts, 1)) * 100)) : 0}%`; });
  }
  for (let h = 0; h < 24; h++) {
    const col = el('div', 'hour-col' + (counts[h] === 0 ? ' zero' : '') + (h === nowHour ? ' now' : ''));
    col.title = `${String(h).padStart(2, '0')}:00 - ${String(h).padStart(2, '0')}:59　${counts[h]} 条`;
    const bar = el('div', 'hour-col-bar');
    bar.style.height = `${counts[h] ? Math.max(8, Math.round((counts[h] / maxN) * 64)) : 2}px`;
    col.appendChild(el('div', 'hour-col-count', counts[h] ? String(counts[h]) : ''));
    col.appendChild(bar);
    col.appendChild(el('div', 'hour-col-label', String(h)));
    col.onclick = () => renderDetail(h);
    cols.push(col);
    chart.appendChild(col);
  }
  hourSec.appendChild(chart);
  hourSec.appendChild(detail);
  body.appendChild(hourSec);

  // 今日浏览会话：按间隔自动分段；「重开本段」按历史打开网址，不是恢复当时窗口
  const sessSec = buildTodaySessions(day, tl);
  if (sessSec) body.appendChild(sessSec);

  // 今日分类分布 + 今日关键词（基于今日时间树聚合，无需额外后端）
  const catSec = buildTodayCategories(tl);
  if (catSec) body.appendChild(catSec);
  const kwSec = buildTodayKeywords(tl);
  if (kwSec) body.appendChild(kwSec);

  // 继续阅读
  const rlSec = el('div', 'dash-section');
  rlSec.appendChild(withIcon(el('div', 'dash-title'), 'book', ` 继续阅读（${readLater.length} 篇未读）`, { size: 14 }));
  if (readLater.length === 0) {
    rlSec.appendChild(el('div', 'empty', '没有未读文章，在记录上右键选择「稍后读」即可加入'));
  } else {
    for (const r of readLater.slice(0, 6)) rlSec.appendChild(savedRow(r, true, () => showToday()));
    if (readLater.length > 6) {
      const more = el('div', 'more-link', `查看全部 ${readLater.length} 篇 → 收藏`);
      more.onclick = () => switchTab('bookmarks');
      rlSec.appendChild(more);
    }
  }
  body.appendChild(rlSec);

  // 回访提示
  const rvSec = el('div', 'dash-section');
  rvSec.appendChild(withIcon(el('div', 'dash-title'), 'repeat', ' 本周高频回访但未收藏', { size: 14 }));
  if (revisits.length === 0) {
    rvSec.appendChild(el('div', 'empty', '暂无提示'));
  } else {
    for (const r of revisits) {
      const row = el('div', 'entry');
      const main = el('div', 'entry-main');
      main.appendChild(faviconEl(r));
      const t = el('span', 'title', r.title || r.url);
      t.title = r.url;
      t.onclick = () => openUrl(r.url);
      main.appendChild(t);
      main.appendChild(el('span', 'browser-tag', `${r.visits} 次回访`));
      const star = el('span', 'star');
      star.appendChild(icon('star', { filled: true, size: 14 }));
      star.title = '收藏';
      star.onclick = async () => { await addSaved(r); showToday(); };
      main.appendChild(star);
      const eb = el('div', 'entry-body');
      eb.appendChild(main);
      if (r.summary) {
        const sub = el('div', 'entry-sub');
        sub.appendChild(withIcon(el('span', 'ai-summary'), 'sparkles', ' ' + r.summary, { size: 12 }));
        eb.appendChild(sub);
      }
      row.appendChild(eb);
      rvSec.appendChild(row);
    }
  }
  body.appendChild(rvSec);

  // 未读积压提醒（超过 7 天未读）
  const stale = await hub.staleUnread(7);
  if (stale.length) {
    const stSec = el('div', 'dash-section stale-notice');
    stSec.appendChild(withIcon(el('div', 'dash-title'), 'bell', ` 未读积压提醒：${stale.length} 篇收藏超过 7 天还没读`, { size: 14 }));
    for (const r of stale.slice(0, 5)) stSec.appendChild(savedRow(r, true, () => showToday()));
    const act = el('div', 'side-actions');
    const goBtn = el('button', null, '去收藏页处理');
    goBtn.onclick = () => switchTab('bookmarks');
    act.appendChild(goBtn);
    stSec.appendChild(act);
    body.appendChild(stSec);
  }

  // 时间黑洞：今日各站估算停留时长
  const day0 = new Date(`${day}T00:00:00`).getTime();
  const [dwells, cfgNow] = await Promise.all([
    hub.dwellDomains(day0, day0 + 86400000, state.browserFilter || null),
    hub.getConfig(),
  ]);
  const bhSec = el('div', 'dash-section');
  bhSec.appendChild(withIcon(el('div', 'dash-title'), 'clock', ' 今日时间黑洞（估算停留时长 Top 8）', { size: 14 }));
  if (!dwells.length) {
    bhSec.appendChild(el('div', 'empty', '今天还没有浏览记录'));
  } else {
    const thresholdMs = (cfgNow.blackholeMinutes || 0) * 60000;
    const maxD = dwells[0].dwellMs || 1;
    for (const d of dwells.slice(0, 8)) {
      const over = thresholdMs > 0 && d.dwellMs >= thresholdMs;
      const rowEl = el('div', 'top-row' + (over ? ' blackhole' : ''));
      rowEl.appendChild(el('span', 'top-domain', (over ? '⚠ ' : '') + d.domain));
      const bar = el('div', 'top-bar');
      const fill = el('div', 'top-fill');
      fill.style.width = `${Math.max(6, Math.round((d.dwellMs / maxD) * 100))}%`;
      bar.appendChild(fill);
      rowEl.appendChild(bar);
      rowEl.appendChild(el('span', 'top-count', fmtDuration(d.dwellMs)));
      bhSec.appendChild(rowEl);
    }
    if (thresholdMs > 0) {
      const over = dwells.filter((d) => d.dwellMs >= thresholdMs);
      if (over.length) {
        bhSec.appendChild(el('div', 'side-hint', `⚠ ${over.map((d) => d.domain).join('、')} 今日停留已超过 ${cfgNow.blackholeMinutes} 分钟阈值`));
        maybeBlackholeToast(over, cfgNow.blackholeMinutes);
      }
    } else {
      bhSec.appendChild(el('div', 'side-hint', '提示：在设置里配置阈值后，超时站点会高亮提醒；时长为基于访问间隔的估算值'));
    }
  }
  body.appendChild(bhSec);

  // 记忆重现：一个月前 / 三个月前 / 一年前的今天 + 收藏吃灰榜
  const memSec = await buildMemoryLane();
  if (memSec && state.mode === 'today') body.appendChild(memSec);

}

// 把一天的访问按间隔（>25 分钟）自动切成“浏览会话”，每段可整段重开。
function buildTodaySessions(day, tl) {
  const items = flattenTimelineItems(tl).sort((a, b) => a.visitTime - b.visitTime);
  if (items.length < 3) return null;
  const GAP = 25 * 60000;
  const sessions = [];
  let cur = null;
  for (const it of items) {
    if (!cur || it.visitTime - cur.to > GAP) {
      cur = { from: it.visitTime, to: it.visitTime, items: [] };
      sessions.push(cur);
    }
    cur.to = it.visitTime;
    cur.items.push(it);
  }
  const real = sessions.filter((s) => s.items.length >= 3);
  if (!real.length) return null;

  const sec = el('div', 'dash-section');
  sec.appendChild(withIcon(el('div', 'dash-title'), 'repeat', ` 今日浏览会话（自动分段，共 ${real.length} 段）`, { size: 14 }));
  sec.appendChild(el('div', 'side-hint', '按访问间隔自动切段。「重开本段」会用系统默认浏览器打开这段历史里的网址，不是恢复当时的窗口、分组或登录状态。'));
  for (const s of real.slice(-8).reverse()) {
    const row = el('div', 'sess-row');
    row.appendChild(el('span', 'sess-time', `${fmtTime(s.from)} - ${fmtTime(s.to)}`));
    // 主题：本段访问最多的域名
    const byDom = new Map();
    for (const it of s.items) byDom.set(it.domain, (byDom.get(it.domain) || 0) + 1);
    const tops = [...byDom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
    const doms = el('span', 'sess-domains');
    tops.forEach((d, i) => {
      if (i) doms.appendChild(document.createTextNode(' · '));
      const dn = el('span', 'domain-name clickable', d);
      dn.onclick = () => openDomainProfile(d);
      doms.appendChild(dn);
    });
    row.appendChild(doms);
    row.appendChild(el('span', 'count-badge', `${s.items.length} 条`));
    const btn = withIcon(el('button', 'mini-btn'), 'refresh', ' 重开本段', { size: 12 });
    btn.onclick = () => openSessionRange(s.from, s.to + 60000, `${day} ${fmtTime(s.from)} - ${fmtTime(s.to)}`);
    row.appendChild(btn);
    sec.appendChild(row);
  }
  return sec;
}

// 记忆重现：那天的今天看了什么 + 收藏吃灰榜。
async function buildMemoryLane() {
  const lanes = [
    [30, '一个月前的今天'],
    [90, '三个月前的今天'],
    [365, '一年前的今天'],
  ];
  const days = lanes.map(([d]) => dayKeyLocal(new Date(Date.now() - d * 86400000)));
  const [highlights, stale] = await Promise.all([
    Promise.all(days.map((d) => hub.dayHighlights(d, 3))),
    hub.staleBookmarks(90, 5),
  ]);
  const hasLane = highlights.some((h) => h.length);
  if (!hasLane && !stale.length) return null;

  const sec = el('div', 'dash-section');
  sec.appendChild(withIcon(el('div', 'dash-title'), 'moon', ' 记忆重现', { size: 14 }));
  lanes.forEach(([, label], i) => {
    if (!highlights[i].length) return;
    const box = el('div', 'mem-lane');
    const head = el('div', 'mem-head');
    head.appendChild(el('span', 'mem-label', label));
    const dayLink = el('span', 'mem-day clickable', days[i]);
    dayLink.title = '在时间树中打开这一天';
    dayLink.onclick = () => { switchTab('timeline'); selectDay(days[i]); };
    head.appendChild(dayLink);
    box.appendChild(head);
    for (const p of highlights[i]) {
      const row = el('div', 'mem-row');
      row.appendChild(faviconEl(p));
      const t = el('span', 'title', p.title);
      t.title = p.url;
      t.onclick = () => openUrl(p.url);
      row.appendChild(t);
      row.appendChild(el('span', 'count-badge', `${p.count} 次`));
      box.appendChild(row);
    }
    sec.appendChild(box);
  });
  if (stale.length) {
    const box = el('div', 'mem-lane');
    const head = el('div', 'mem-head');
    head.appendChild(el('span', 'mem-label', '收藏吃灰榜：收藏了却一直没打开'));
    box.appendChild(head);
    for (const b of stale) {
      const row = el('div', 'mem-row');
      row.appendChild(faviconEl(b));
      const t = el('span', 'title', b.title);
      t.title = b.url;
      t.onclick = () => openUrl(b.url);
      row.appendChild(t);
      row.appendChild(el('span', 'mem-ago', b.lastVisit ? `${Math.round((Date.now() - b.lastVisit) / 86400000)} 天没看` : '从未打开'));
      const rm = el('button', 'mini-btn danger', '移除');
      rm.onclick = async () => { await hub.removeBookmark(b.url); await hub.removeReadLater(b.url); showToday(); };
      row.appendChild(rm);
      box.appendChild(row);
    }
    sec.appendChild(box);
  }
  return sec;
}

let blackholeToastDay = null;
function maybeBlackholeToast(over, minutes) {
  const key = todayKey();
  if (blackholeToastDay === key) return;
  blackholeToastDay = key;
  toast(`时间黑洞提醒：${over[0].domain} 今日已停留约 ${fmtDuration(over[0].dwellMs)}（阈值 ${minutes} 分钟）`);
}

// ------------------------- session restore ---------------------------------
let sessionUrls = [];

async function openSessionModal(day, hour) {
  const base = new Date(`${day}T00:00:00`);
  let fromMs, toMs, label;
  if (hour === null || hour === undefined) {
    fromMs = base.getTime();
    toMs = fromMs + 86400000;
    label = `${day} 全天`;
  } else {
    fromMs = base.getTime() + hour * 3600000;
    toMs = fromMs + 3600000;
    label = `${day} ${String(hour).padStart(2, '0')}:00 - ${String(hour).padStart(2, '0')}:59`;
  }
  return openSessionRange(fromMs, toMs, label);
}

async function openSessionRange(fromMs, toMs, label) {
  const pages = await hub.sessionPreview(fromMs, toMs, state.browserFilter || null);
  sessionUrls = pages.map((p) => p.url).filter((u) => /^https?:/i.test(u));
  const disc = (window.TraceHubCapabilities && window.TraceHubCapabilities.historySessionDisclaimer())
    || '这是根据浏览历史打开网址，不是恢复当前已打开的页签。';
  document.getElementById('sessionInfo').textContent =
    `${label} 共 ${sessionUrls.length} 个历史网址（最多打开 30 个）。` + disc;
  const list = document.getElementById('sessionList');
  list.innerHTML = '';
  for (const p of pages.slice(0, 50)) {
    if (!/^https?:/i.test(p.url)) continue;
    list.appendChild(el('div', 'session-item', p.title || p.url));
  }
  document.getElementById('sessionModal').classList.remove('hidden');
}

// ------------------------- command palette ---------------------------------
const PALETTE_ACTIONS = [
  { label: '立即同步所有浏览器', run: () => document.getElementById('btnSync').click() },
  { label: '重新同步历史', run: () => document.getElementById('cfgCatchUpHistory').click() },
  { label: '重新同步这一天', run: () => repairVisibleDay() },
  { label: 'AI 整理分类', run: () => document.getElementById('btnOrganize').click() },
  { label: '导出历史 (CSV/JSON)', run: () => document.getElementById('btnExport').click() },
  { label: '打开设置', run: () => document.getElementById('btnSettings').click() },
  { label: '查看今日总览', run: () => switchTab('today') },
  { label: '打开收藏', run: () => switchTab('bookmarks') },
  { label: '打开 AI 历史问答', run: () => openAsk() },
  { label: '一键净化历史噪音', run: () => purgeNoiseFlow() },
  { label: '立即备份数据库', run: async () => { await hub.backupNow(); toast('备份完成'); } },
  { label: '页签快照 / 关机前整理', run: () => switchTab('snapshots') },
];

async function purgeNoiseFlow() {
  const { count } = await hub.noiseCount();
  if (!count) { toast('没有检测到噪音记录'); return; }
  const r = await hub.noisePurge();
  toast(`已净化 ${r.hidden} 条噪音记录（搜索页/登录跳转等）`, '恢复', async () => {
    const rr = await hub.noiseRestore();
    toast(`已恢复 ${rr.restored} 条记录`);
    refreshCurrentView();
  });
  refreshCurrentView();
}

function closePalette() {
  document.getElementById('palette').classList.add('hidden');
}

function openPalette() {
  // Never stack the palette on top of an open dialog.
  if (document.querySelector('.modal:not(.hidden)')) return;
  const overlay = document.getElementById('palette');
  const input = document.getElementById('paletteInput');
  overlay.classList.remove('hidden');
  input.value = '';
  renderPaletteResults('');
  input.focus();
}

let paletteItems = []; // current openable rows: {label, run}

function renderPaletteResults(query = '') {
  const box = document.getElementById('paletteResults');
  box.innerHTML = '';
  paletteItems = PALETTE_ACTIONS.filter((a) => fuzzyMatch(a.label, query));
  if (paletteItems.length === 0) {
    box.appendChild(el('div', 'empty', '无匹配命令；搜索历史请用顶部搜索框'));
  }
  paletteItems.forEach((p, idx) => {
    const row = el('div', 'palette-row' + (idx === 0 ? ' active' : ''));
    row.appendChild(el('div', 'palette-label', p.label));
    if (p.sub) row.appendChild(el('div', 'palette-sub', p.sub));
    row.onclick = () => { closePalette(); p.run(); };
    box.appendChild(row);
  });
}

function setupPalette() {
  const input = document.getElementById('paletteInput');
  input.addEventListener('input', () => renderPaletteResults(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePalette();
    if (e.key === 'Enter' && paletteItems.length > 0) {
      closePalette();
      paletteItems[0].run();
    }
  });
  document.getElementById('palette').addEventListener('click', (e) => {
    if (e.target.id === 'palette') closePalette();
  });
}

// ------------------------- tabs -------------------------------------------
function switchTab(which) {
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === which));
  document.querySelector('.sidebar .tabs').classList.toggle('hidden', !['today', 'timeline'].includes(which));
  for (const name of ['today', 'timeline', 'categories', 'bookmarks', 'report', 'snapshots']) {
    const panel = document.getElementById('panel-' + name);
    if (panel) panel.classList.toggle('hidden', name !== which);
  }
  if (which === 'today') showToday();
  if (which === 'categories') loadCategories();
  if (which === 'bookmarks') showSaved();
  if (which === 'report') showReport(state.reportDays || 7);
  if (which === 'snapshots') showSnapshots();
  if (which === 'timeline' && state.currentDay) selectDay(state.currentDay);
}

// Re-query whatever view is on screen (used when the browser filter changes).
function refreshCurrentView() {
  if (state.mode === 'search') runSearch(false);
  else if (state.mode === 'today') showToday();
  else if (state.mode === 'bookmarks') showSaved();
  else if (state.mode === 'category' && state.currentCategory) showCategory(state.currentCategory);
  else if (state.mode === 'report') showReport(state.reportDays || 7);
  else if (state.mode === 'snapshots') showSnapshots();
  else if (state.currentDay) selectDay(state.currentDay);
}

// ------------------------- AI report & collections -------------------------
async function showReport(days) {
  state.mode = 'report';
  state.reportDays = days;
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), 'chart', ' AI 阅读报告'));
  if (state.browserFilter) header.appendChild(el('span', 'sub', '（已按浏览器筛选）'));
  for (const [n, label] of [[7, '近 7 天'], [30, '近 30 天']]) {
    const b = el('button', n === days ? 'ai' : '', label);
    b.onclick = () => showReport(n);
    header.appendChild(b);
  }
  const collBtn = withIcon(el('button', 'ai'), 'sparkles', ' 生成智能合集', { size: 13 });
  collBtn.onclick = () => showCollections();
  header.appendChild(collBtn);

  document.getElementById('statsBox').classList.add('hidden');
  document.getElementById('summaryBox').classList.add('hidden');
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', '正在生成报告…'));

  const r = await hub.rangeReport(days, state.browserFilter || null);
  if (state.mode !== 'report') return;
  body.innerHTML = '';

  const nar = el('div', 'report-narrative');
  nar.appendChild(withIcon(el('div', 'dash-title'), 'sparkles', ` ${r.label}阅读报告`, { size: 14 }));
  nar.appendChild(el('div', null, r.narrative));
  body.appendChild(nar);

  const daysBox = el('div', 'dash-section');
  daysBox.appendChild(el('div', 'dash-title', '每日访问量'));
  const maxDay = Math.max(...r.stats.days.map((d) => d.count), 1);
  for (const d of [...r.stats.days].sort((a, b) => (a.day < b.day ? 1 : -1))) {
    const rowEl = el('div', 'top-row');
    rowEl.appendChild(el('span', 'top-domain', d.day));
    const bar = el('div', 'top-bar');
    const fill = el('div', 'top-fill');
    fill.style.width = `${Math.max(6, Math.round((d.count / maxDay) * 100))}%`;
    bar.appendChild(fill);
    rowEl.appendChild(bar);
    rowEl.appendChild(el('span', 'top-count', String(d.count)));
    daysBox.appendChild(rowEl);
  }
  body.appendChild(daysBox);

  const domBox = el('div', 'dash-section');
  domBox.appendChild(el('div', 'dash-title', 'Top 站点'));
  const maxDom = r.stats.topDomains.length ? r.stats.topDomains[0].count : 1;
  for (const t of r.stats.topDomains) {
    const rowEl = el('div', 'top-row');
    rowEl.appendChild(el('span', 'top-domain', t.domain));
    const bar = el('div', 'top-bar');
    const fill = el('div', 'top-fill');
    fill.style.width = `${Math.max(6, Math.round((t.count / maxDom) * 100))}%`;
    bar.appendChild(fill);
    rowEl.appendChild(bar);
    rowEl.appendChild(el('span', 'top-count', String(t.count)));
    domBox.appendChild(rowEl);
  }
  body.appendChild(domBox);

  const dwellBox = el('div', 'dash-section');
  dwellBox.appendChild(el('div', 'dash-title', '时间黑洞榜（估算停留时长 Top 10）'));
  const dayFrom = Date.now() - days * 86400000;
  const dwellRank = await hub.dwellDomains(dayFrom, Date.now(), state.browserFilter || null);
  if (!dwellRank.length) {
    dwellBox.appendChild(el('div', 'empty', '暂无数据'));
  } else {
    const maxDw = dwellRank[0].dwellMs || 1;
    for (const d of dwellRank.slice(0, 10)) {
      const rowEl = el('div', 'top-row');
      rowEl.appendChild(el('span', 'top-domain', d.domain));
      const bar = el('div', 'top-bar');
      const fill = el('div', 'top-fill');
      fill.style.width = `${Math.max(6, Math.round((d.dwellMs / maxDw) * 100))}%`;
      bar.appendChild(fill);
      rowEl.appendChild(bar);
      rowEl.appendChild(el('span', 'top-count', fmtDuration(d.dwellMs)));
      dwellBox.appendChild(rowEl);
    }
    dwellBox.appendChild(el('div', 'side-hint', '时长为基于相邻访问间隔的估算值，非精确计时'));
  }
  body.appendChild(dwellBox);

  const pgBox = el('div', 'dash-section');
  pgBox.appendChild(el('div', 'dash-title', '回访最多的页面'));
  for (const p of r.stats.topPages) {
    const rowEl = el('div', 'session-item');
    const t = el('span', 'title', `${p.title || p.url}`);
    t.title = p.url;
    t.onclick = () => openUrl(p.url);
    rowEl.appendChild(t);
    rowEl.appendChild(el('span', 'count-badge', `${p.count} 次`));
    pgBox.appendChild(rowEl);
  }
  body.appendChild(pgBox);
}

async function showCollections() {
  state.mode = 'report';
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', '正在聚类生成智能合集…'));
  let colls;
  try {
    colls = await hub.runCollections();
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', 'empty', `合集生成失败：${e.message}`));
    return;
  }
  if (state.mode !== 'report') return;
  body.innerHTML = '';
  if (!colls.length) {
    body.appendChild(el('div', 'empty', '暂无可聚类的主题（记录过少）'));
    return;
  }
  for (const c of colls) {
    const box = el('div', 'dash-section');
    const head = el('div', 'dash-title');
    head.appendChild(withIcon(el('span'), 'library', ` ${c.name}`, { size: 14 }));
    head.appendChild(el('span', 'count-badge', String(c.items.length)));
    box.appendChild(head);
    for (const it of c.items.slice(0, 12)) {
      const rowEl = el('div', 'session-item');
      const t = el('span', 'title', it.title || it.url);
      t.title = it.url;
      t.onclick = () => openUrl(it.url);
      rowEl.appendChild(t);
      if (it.domain) rowEl.appendChild(el('span', 'browser-tag', it.domain));
      box.appendChild(rowEl);
    }
    body.appendChild(box);
  }
}

// ------------------------- ask history (AI chat) ---------------------------
function openAsk() {
  document.getElementById('askModal').classList.remove('hidden');
  document.getElementById('askInput').focus();
  showOntologyBrief();
}

// One-time briefing of the ontology model built from browsing history.
let ontologyShown = false;
async function showOntologyBrief() {
  if (ontologyShown) return;
  ontologyShown = true;
  try {
    const o = await hub.getOntology(30);
    const topics = (o.topics || []).slice(0, 5).map((t) => t.name).join('、');
    const sites = (o.sites || []).slice(0, 5).map((s) => s.domain).join('、');
    appendAskMsg(
      'ai',
      `已基于最近 ${o.periodDays} 天的 ${o.totalVisits} 次访问（${o.distinctUrls} 个网页）构建浏览本体模型。` +
        (topics ? `主题：${topics}。` : '暂无主题（可先点顶栏“AI 整理”生成分类）。') +
        (sites ? `常去站点：${sites}。` : '') +
        '提问时会结合这个模型回答。'
    );
  } catch (e) { /* ignore */ }
}

function appendAskMsg(cls, text) {
  const log = document.getElementById('askLog');
  const m = el('div', 'ask-msg ' + cls, text);
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
  return m;
}

async function sendAsk() {
  const input = document.getElementById('askInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  appendAskMsg('user', q);
  const pending = appendAskMsg('ai', '思考中…');
  try {
    const r = await hub.askHistory(q);
    pending.textContent = r.answer || '（无回答）';
    if (r.refs && r.refs.length) {
      const log = document.getElementById('askLog');
      const refsBox = el('div', 'ask-refs');
      for (const it of r.refs.slice(0, 6)) {
        const link = withIcon(el('div', 'ask-ref'), 'link', ` ${it.title || it.url}`, { size: 12 });
        link.title = it.url;
        link.onclick = () => openUrl(it.url);
        refsBox.appendChild(link);
      }
      log.appendChild(refsBox);
      log.scrollTop = log.scrollHeight;
    }
  } catch (e) {
    pending.textContent = String(e.message || e).replace(/^.*Error:\s*/, '');
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      const which = tab.dataset.tab;
      // Clicking the already-active top-bar page acts as a toggle back to the timeline.
      if (tab.classList.contains('active') && ['categories', 'bookmarks', 'report', 'snapshots'].includes(which)) switchTab('timeline');
      else switchTab(which);
    };
  });
  document.querySelectorAll('.side-back').forEach((b) => { b.onclick = () => switchTab('timeline'); });
}

// ------------------------- browser filter ----------------------------------
async function setupBrowserFilter() {
  const sel = document.getElementById('browserFilter');
  state.browsers = await hub.detectBrowsers();
  sel.innerHTML = '';
  const all = el('option', null, '全部浏览器');
  all.value = '';
  sel.appendChild(all);
  for (const b of state.browsers) {
    const opt = el('option', null, b.name);
    opt.value = b.id;
    sel.appendChild(opt);
  }
  sel.onchange = () => {
    state.browserFilter = sel.value;
    refreshCurrentView();
  };
}

// ------------------------- settings ---------------------------------------
let providers = [];

async function openSettings() {
  const [cfg, provs] = await Promise.all([hub.getConfig(), hub.listProviders()]);
  providers = provs;
  const sel = document.getElementById('cfgProvider');
  sel.innerHTML = '';
  for (const p of provs) {
    const opt = el('option', null, p.name);
    opt.value = p.id;
    sel.appendChild(opt);
  }
  sel.value = cfg.ai.provider || 'custom';
  sel.onchange = () => {
    const p = providers.find((x) => x.id === sel.value);
    if (p && p.baseUrl) {
      document.getElementById('cfgBaseUrl').value = p.baseUrl;
      document.getElementById('cfgModel').value = p.model;
    }
  };
  document.getElementById('cfgBaseUrl').value = cfg.ai.baseUrl || '';
  document.getElementById('cfgModel').value = cfg.ai.model || '';
  document.getElementById('cfgApiKey').value = '';
  document.getElementById('cfgInterval').value = cfg.syncIntervalMs || 5000;
  document.getElementById('keyState').textContent = cfg.ai.hasKey ? '（已配置）' : '（未配置，使用本地模式）';
  document.getElementById('cfgReaderEnabled').checked = !!cfg.reader.enabled;
  document.getElementById('cfgJinaKey').value = '';
  document.getElementById('jinaState').textContent = cfg.reader.hasKey ? '（已配置）' : '';
  document.getElementById('cfgBlacklist').value = (cfg.blacklist || []).join('\n');
  document.getElementById('cfgWeeklyNotify').checked = cfg.weeklyNotify !== false;
  document.getElementById('cfgAutoLaunch').checked = !!cfg.autoLaunch;
  document.getElementById('cfgStartMin').checked = !!cfg.startMinimized;
  document.getElementById('cfgCloseTray').checked = cfg.closeToTray !== false;
  document.getElementById('cfgMinTray').checked = !!cfg.minimizeToTray;
  document.getElementById('cfgShowTags').checked = showTags();
  document.getElementById('cfgShowStats').checked = showStats();
  document.getElementById('cfgBlackhole').value = cfg.blackholeMinutes || 0;
  const box = document.getElementById('cfgProfiles');
  if (box) {
    box.innerHTML = '';
    const selected = new Set((cfg.enabledProfiles || []).map((x) => x.browserId + '\t' + x.profile));
    const browsers = state.browsers || [];
    for (const b of browsers) {
      box.appendChild(el('div', 'onboard-browser', b.name));
      for (const prof of b.profiles) {
        const row = el('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.browserId = b.id;
        cb.dataset.profile = prof;
        cb.checked = cfg.enabledProfiles == null ? prof !== 'Guest Profile' : selected.has(b.id + '\t' + prof);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + prof));
        box.appendChild(row);
      }
    }
    if (!browsers.length) box.appendChild(el('div', 'muted', '未检测到浏览器配置'));
  }
  const thumbs = document.getElementById('cfgThumbs');
  const cfetch = document.getElementById('cfgContentFetch');
  if (thumbs) thumbs.checked = !!cfg.thumbsEnabled;
  if (cfetch) cfetch.checked = !!cfg.contentFetchEnabled;
  const tok = document.getElementById('cfgBridgeToken');
  const port = document.getElementById('cfgBridgePort');
  if (tok) tok.value = cfg.bridgeToken || '';
  if (port) port.value = cfg.bridgePort || 17862;
  const bs = document.getElementById('bridgeState');
  if (bs) {
    hub.bridgeStatus().then((st) => {
      bs.textContent = st.listening ? `本机桥接已在 127.0.0.1:${st.port} 监听` : '桥接未监听（可重启应用或检查端口）';
    }).catch(() => {});
  }
  document.getElementById('testResult').textContent = '';
  refreshNoiseState();
  refreshBackupState();
  document.getElementById('settingsModal').classList.remove('hidden');
}

async function refreshNoiseState() {
  const r = await hub.noiseCount();
  document.getElementById('noiseState').textContent =
    r.count > 0 ? `检测到 ${r.count} 条可净化的噪音记录` : '当前没有待净化的噪音记录';
}

async function refreshBackupState() {
  const list = await hub.backupList();
  document.getElementById('backupState').textContent = list.length
    ? `已有 ${list.length} 份备份，最近：${new Date(list[0].mtime).toLocaleString('zh-CN')}`
    : '还没有备份';
}

async function testAIConnection() {
  const out = document.getElementById('testResult');
  out.textContent = '测试中…';
  // Save the current form first so the test uses what the user typed.
  const patch = {
    ai: {
      provider: document.getElementById('cfgProvider').value,
      baseUrl: document.getElementById('cfgBaseUrl').value.trim(),
      model: document.getElementById('cfgModel').value.trim(),
    },
  };
  const key = document.getElementById('cfgApiKey').value;
  if (key.trim()) patch.ai.apiKey = key.trim();
  await hub.updateConfig(patch);
  const r = await hub.testAI();
  out.textContent = '';
  out.classList.toggle('ok', r.ok);
  out.classList.toggle('err', !r.ok);
  withIcon(out, r.ok ? 'check-circle' : 'x-circle', ' ' + r.message, { size: 13 });
}

async function saveSettings() {
  const patch = {
    ai: {
      provider: document.getElementById('cfgProvider').value,
      baseUrl: document.getElementById('cfgBaseUrl').value.trim(),
      model: document.getElementById('cfgModel').value.trim(),
    },
    reader: {
      enabled: document.getElementById('cfgReaderEnabled').checked,
    },
    syncIntervalMs: Math.max(1000, Number(document.getElementById('cfgInterval').value) || 5000),
  };
  const key = document.getElementById('cfgApiKey').value;
  if (key.trim()) patch.ai.apiKey = key.trim();
  const jkey = document.getElementById('cfgJinaKey').value;
  if (jkey.trim()) patch.reader.jinaKey = jkey.trim();
  patch.blacklist = document.getElementById('cfgBlacklist').value
    .split('\n').map((s) => s.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
  patch.weeklyNotify = document.getElementById('cfgWeeklyNotify').checked;
  patch.autoLaunch = document.getElementById('cfgAutoLaunch').checked;
  patch.startMinimized = document.getElementById('cfgStartMin').checked;
  patch.closeToTray = document.getElementById('cfgCloseTray').checked;
  patch.minimizeToTray = document.getElementById('cfgMinTray').checked;
  patch.blackholeMinutes = Math.max(0, Number(document.getElementById('cfgBlackhole').value) || 0);
  const thumbsEl = document.getElementById('cfgThumbs');
  const cfetchEl = document.getElementById('cfgContentFetch');
  if (thumbsEl) patch.thumbsEnabled = !!thumbsEl.checked;
  if (cfetchEl) patch.contentFetchEnabled = !!cfetchEl.checked;
  const portEl = document.getElementById('cfgBridgePort');
  if (portEl) patch.bridgePort = Math.max(1024, Number(portEl.value) || 17862);
  const pbox = document.getElementById('cfgProfiles');
  if (pbox) {
    patch.enabledProfiles = [...pbox.querySelectorAll('input[type=checkbox]:checked')].map((cb) => ({
      browserId: cb.dataset.browserId, profile: cb.dataset.profile,
    }));
  }
  localStorage.setItem('bhh-show-tags', document.getElementById('cfgShowTags').checked ? '1' : '0');
  localStorage.setItem('bhh-show-stats', document.getElementById('cfgShowStats').checked ? '1' : '0');
  const prevCfg = await hub.getConfig();
  const added = (patch.blacklist || []).filter((d) => !(prevCfg.blacklist || []).includes(d));
  if (added.length) {
    let total = 0;
    for (const d of added) total += (await hub.domainCount(d)).count || 0;
    if (!(await askConfirm(`黑名单新增 ${added.length} 个域名，将删除已有的 ${total} 条访问记录，且不会自动恢复。是否继续？`, '删除并保存'))) return;
  }
  const saved = await hub.updateConfig(patch);
  for (const d of added) await hub.blacklistAdd(d);
  document.getElementById('settingsModal').classList.add('hidden');
  refreshCurrentView();
  if (saved && saved.bridgeError) {
    setStatus('设置已保存，但页签桥未能在新端口监听：' + saved.bridgeError);
  } else if (saved && patch.bridgePort != null && saved.bridgePort && Number(saved.bridgePort) !== Number(patch.bridgePort)) {
    setStatus(`设置已保存。请求的端口 ${patch.bridgePort} 已被占用，页签桥改在 127.0.0.1:${saved.bridgePort} 监听。请把扩展选项中的端口改为 ${saved.bridgePort}。`);
  } else {
    setStatus('设置已保存');
  }
}

// ------------------------- status -----------------------------------------

let bridgeChipPrev = null;

async function copyPairingToken() {
  try {
    const cfg = await hub.getConfig();
    const tok = cfg && cfg.bridgeToken;
    if (!tok) { toast('还没有配对令牌，请先打开设置确认页签桥已开启'); return; }
    await hub.copyText(tok);
    let portNote = '';
    try {
      const st = await hub.bridgeStatus();
      if (st && st.port) portNote = `本机桥正在 127.0.0.1:${st.port} 监听，请把扩展选项里的端口设为同一个值。`;
    } catch (e2) { portNote = ''; }
    toast('配对令牌已复制。请到扩展选项页粘贴并保存，不要发到聊天或截图。' + (portNote ? ' ' + portNote : ''));
  } catch (e) {
    toast('复制令牌失败：' + (e && e.message ? e.message : String(e)));
  }
}

async function openOfficialExtensionsPage(browserId) {
  if (!hub.openExtensionsPage) {
    const page = browserId === 'edge' ? 'edge://extensions' : 'chrome://extensions';
    toast('请在 ' + (browserId === 'edge' ? 'Edge' : 'Chrome') + ' 地址栏手动打开 ' + page + '（该地址不能做成网页链接）');
    return;
  }
  try {
    const r = await hub.openExtensionsPage(browserId);
    if (r && r.ok) toast(r.note || '已请浏览器打开官方扩展管理页。应用不会替你静默安装扩展。');
    else toast((r && r.error) || '未能打开扩展页，请在地址栏手动打开 chrome://extensions 或 edge://extensions');
  } catch (e) {
    toast('未能打开扩展页：' + (e && e.message ? e.message : String(e)));
  }
}

async function updateBridgeChip() {
  const chip = document.getElementById('bridgeChip');
  if (!chip) return;
  const cap = window.TraceHubCapabilities;
  try {
    const st = await hub.bridgeStatus();
    const d = cap ? cap.describeBridge(st) : { listening: !!(st && st.listening), recentlySeen: false };
    if (cap && cap.pairingSucceeded && cap.pairingSucceeded(bridgeChipPrev, d)) {
      toast(cap.pairingSuccessMessage());
    }
    if (d) bridgeChipPrev = { recentlySeen: !!d.recentlySeen };
    chip.textContent = cap ? cap.bridgeChipText(d) : (d.listening ? '页签桥：已监听' : '页签桥：未监听');
    chip.classList.toggle('ok', !!d.recentlySeen);
    chip.classList.toggle('wait', !!(d.listening && !d.recentlySeen));
    chip.classList.toggle('off', !d.listening);
    const portHint = d.port ? ` 当前监听 127.0.0.1:${d.port}。` : '';
    chip.title = d.recentlySeen
      ? '扩展最近在本机桥上有活动。保存已打开页签、按布局恢复和批量关闭都需要通过扩展完成。点击查看快照工作区。' + portHint
      : (d.listening
        ? '本机桥已监听，但还没有检测到已配对的扩展。点击查看安装与配对步骤。不装扩展时仍可查看历史、重开历史网址或导入 JSON。' + portHint
        : '页签桥未监听。可在设置中检查端口；若常用端口被占用，应用会尝试相邻端口。');
  } catch (e) {
    chip.textContent = '页签桥：状态未知';
    chip.classList.remove('ok', 'wait');
    chip.classList.add('off');
  }
}

async function setStatus(msg) {
  if (msg) toast(msg);
}


// ------------------------- tab snapshots (v1.2) ----------------------------
let snapState = { list: [], current: null, restorePlan: null, closeId: null };

async function showSnapshots(selectId) {
  state.mode = 'snapshots';
  const header = document.getElementById('contentHeader');
  header.innerHTML = '';
  header.appendChild(withIcon(el('span'), 'layers', ' 页签快照 / 关机前整理'));
  document.getElementById('statsBox').classList.add('hidden');
  document.getElementById('summaryBox').classList.add('hidden');
  const list = await hub.snapshotList();
  snapState.list = list || [];
  renderSnapSidebar(selectId || (snapState.current && snapState.current.id));
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  let bridgeDesc = null;
  try {
    const st = await hub.bridgeStatus();
    bridgeDesc = window.TraceHubCapabilities ? window.TraceHubCapabilities.describeBridge(st) : st;
  } catch (e) { bridgeDesc = null; }
  body.appendChild(snapIntro(bridgeDesc));
  if (!snapState.list.length) {
    const ui = window.TraceHubSessionFileUi;
    body.appendChild(emptyState('layers', ui ? ui.emptyWorkspaceHint() : '还没有页签快照。可先从会话文件读取（无需扩展），或安装扩展。不会从浏览历史猜测活动标签。', '从会话文件读取', () => startSessionFileCapture()));
    maybeStartPendingSessionFileCapture();
    return;
  }
  const id = selectId || (snapState.current && snapState.current.id) || snapState.list[0].id;
  await openSnapshotDetail(id);
  maybeStartPendingSessionFileCapture();
}

function maybeStartPendingSessionFileCapture() {
  if (!state.startSessionFileAfterSnapshots) return;
  state.startSessionFileAfterSnapshots = false;
  startSessionFileCapture();
}

function sessionFileUi() {
  return window.TraceHubSessionFileUi || null;
}

function startSessionFileCapture() {
  showSessionFileCapture().catch((e) => toast('无法打开会话文件读取：' + (e && e.message ? e.message : String(e))));
}

async function showSessionFileCapture() {
  const ui = sessionFileUi();
  const body = document.getElementById('contentBody');
  const panel = el('div', 'dash-section session-file-panel');
  panel.appendChild(el('div', 'dash-title', ui ? ui.entryTitle() : '从会话文件读取页签（无需扩展）'));
  panel.appendChild(el('p', 'muted', ui ? ui.entryIntro() : ''));
  panel.appendChild(el('p', 'muted', ui ? ui.previewFirstHint() : '请先预览再保存。'));
  const status = el('div', 'muted', '正在列出本机 Chrome / Edge 配置（只读，不会自动保存）…');
  panel.appendChild(status);
  const select = el('select', 'session-file-select');
  panel.appendChild(select);
  const previewBox = el('div', 'session-file-preview');
  panel.appendChild(previewBox);
  const bar = el('div', 'snap-toolbar');
  const scanBtn = el('button', null, '刷新配置列表');
  const prevBtn = el('button', 'primary', '预览');
  const saveBtn = el('button', 'primary', ui ? ui.saveConfirmLabel() : '确认保存这份会话快照');
  saveBtn.disabled = true;
  bar.appendChild(scanBtn); bar.appendChild(prevBtn); bar.appendChild(saveBtn);
  panel.appendChild(bar);
  // Insert at the top of the snapshot view, after the existing intro if present.
  const intro = body.querySelector('.dash-section');
  if (intro && intro.parentNode === body) body.insertBefore(panel, intro.nextSibling);
  else body.insertBefore(panel, body.firstChild);

  let lastPreview = null;
  async function loadProfiles() {
    status.textContent = '正在列出本机 Chrome / Edge 配置（只读）…';
    select.innerHTML = '';
    const r = await hub.sessionFileListProfiles();
    if (!r.ok) {
      status.textContent = r.error || '无法列出配置';
      return;
    }
    const profiles = r.profiles || [];
    const listed = ui && ui.profileListStatus ? ui.profileListStatus(profiles, r.scope) : null;
    if (listed && !listed.canPreview && !profiles.length) {
      status.textContent = listed.text;
      prevBtn.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = `${p.browserName} · ${p.profile}` + (p.hasSessionFiles ? '' : '（未发现会话文件）');
      if (!p.hasSessionFiles) opt.disabled = true;
      select.appendChild(opt);
    }
    if (listed) {
      status.textContent = listed.text;
      prevBtn.disabled = !listed.canPreview;
      if (!listed.canPreview) saveBtn.disabled = true;
    } else {
      status.textContent = r.scope || '请选择配置，先预览再决定是否保存。';
    }
  }
  async function runPreview() {
    lastPreview = null;
    saveBtn.disabled = true;
    previewBox.innerHTML = '';
    const key = select.value;
    if (!key) { toast('请先选择一个配置'); return; }
    const r = await hub.sessionFilePreview(key);
    if (!r.ok) {
      previewBox.appendChild(el('p', 'warn', r.error || '预览失败'));
      if (r.honesty) previewBox.appendChild(el('p', 'muted', r.honesty));
      return;
    }
    lastPreview = r;
    const tone = (ui && ui.previewHonestyTone) ? ui.previewHonestyTone(r.origin, r) : ((r.stale || r.locked) ? 'warn' : 'muted');
    if (r.honesty) previewBox.appendChild(el('p', tone, r.honesty));
    previewBox.appendChild(el('p', null, `${r.browserName || ''} ${r.profile || ''} · ${r.windowCount} 个窗口 · ${r.tabCount} 个 http(s) 页签` + (r.origin && r.origin.sourceFileBase ? ` · 来源文件 ${r.origin.sourceFileBase}` : '') + (r.origin && r.origin.sourceMtime ? ` · 文件时间 ${new Date(r.origin.sourceMtime).toLocaleString('zh-CN')}` : '') + (r.locked ? ' · 已锁定并回退' : '') + (r.stale ? ' · 旧档' : '')));
    for (const w of r.windows || []) {
      const sec = el('div', 'snap-group');
      sec.appendChild(el('h4', null, `窗口 ${Number(w.windowIndex) + 1}（${(w.tabs || []).length}）`));
      for (const tab of w.tabs || []) {
        const row = el('div', 'snap-tab');
        const title = el('div', 'title');
        if (tab.pinned) title.appendChild(el('span', 'pill pin', '固定（仅记录，重开时不能自动固定）'));
        title.appendChild(el('div', null, tab.title || tab.url));
        title.appendChild(el('div', 'muted', tab.url));
        row.appendChild(title);
        sec.appendChild(row);
      }
      previewBox.appendChild(sec);
    }
    saveBtn.disabled = false;
  }
  scanBtn.onclick = () => loadProfiles().catch((e) => { status.textContent = e.message || String(e); });
  prevBtn.onclick = () => runPreview().catch((e) => toast(e.message || String(e)));
  saveBtn.onclick = async () => {
    if (!lastPreview || !lastPreview.previewId) { toast('请先预览'); return; }
    const ok = await askConfirm((lastPreview.honesty || '') + ' 确认把这次预览到的页签保存为本地快照？不会关闭浏览器，也不会自动采集。', ui ? ui.saveConfirmLabel() : '确认保存');
    if (!ok) return;
    const r = await hub.sessionFileSave({ previewId: lastPreview.previewId, confirmed: true });
    if (!r.ok) { toast(r.error || '保存失败'); return; }
    toast(r.message || '已保存会话文件快照');
    showSnapshots(r.snapshot && r.snapshot.id);
  };
  await loadProfiles();
}

function snapIntro(bridgeDesc) {
  const cap = window.TraceHubCapabilities;
  const ui = sessionFileUi();
  const box = el('div', 'dash-section');
  box.appendChild(el('div', 'dash-title', '关机前整理（手动，不接管系统关机）'));
  box.appendChild(el('p', 'muted', '场景：关机前开了很多页签，不敢关。可以先用会话文件读取当时已写盘的页签并保存快照（无需扩展，可能不是此刻页签条）；扩展是可选增强，用于更接近实时的页签、按分组恢复和按 tabId 关闭。默认只保存、不关闭。不能恢复登录状态、未提交表单或滚动位置。Firefox 活动页签本轮不在范围内。'));
  const sessionBar = el('div', 'snap-toolbar');
  const sessionBtn = el('button', 'primary', ui ? ui.entryTitle() : '从会话文件读取页签（无需扩展）');
  sessionBtn.onclick = () => startSessionFileCapture();
  sessionBar.appendChild(sessionBtn);
  box.appendChild(sessionBar);
  if (ui) box.appendChild(el('p', 'muted', ui.entryIntro()));
  const d = bridgeDesc || { listening: false, recentlySeen: false };
  const portLabel = d.port ? `127.0.0.1:${d.port}` : '127.0.0.1';
  if (d.recentlySeen) {
    box.appendChild(el('p', 'muted', `已检测到扩展最近在本机 ${portLabel} 桥上有活动。扩展可作为可选增强：在要整理的窗口用弹出页保存更接近实时的页签。扩展选项里的端口必须与此一致。`));
  } else if (d.listening) {
    box.appendChild(el('p', 'muted', `本机桥已在 ${portLabel} 监听，但还没有检测到已配对的扩展。没有扩展时，仍可用上方的会话文件读取。要按原布局恢复或按页签关闭，请把扩展选项中的端口设为 ${d.port || '与设置中相同'} 并完成配对。`));
  } else {
    box.appendChild(el('p', 'muted', '页签桥当前未监听。会话文件读取不依赖页签桥。若要使用扩展，请在设置中检查端口。'));
  }
  box.appendChild(el('div', 'dash-title', d.recentlySeen ? '扩展已连接（可选增强）' : '可选：安装扩展以获得实时页签、分组恢复和按页签关闭'));
  if (cap) {
    if (!d.recentlySeen) {
      const steps = el('ol', 'setup-steps');
      for (const s of (cap.quickInstallSteps ? cap.quickInstallSteps() : cap.extensionSetupSteps())) {
        steps.appendChild(el('li', null, s));
      }
      box.appendChild(steps);
      if (cap.webStoreFutureNote) box.appendChild(el('p', 'muted', cap.webStoreFutureNote()));
    }
    const lists = cap.withoutExtensionCapabilities();
    box.appendChild(el('div', 'muted', '不装扩展时可以使用：'));
    const ok = el('ul', 'capability-list');
    for (const s of lists.available) ok.appendChild(el('li', null, s));
    box.appendChild(ok);
    box.appendChild(el('div', 'muted', '仍需要扩展才能使用：'));
    const no = el('ul', 'capability-list unavailable');
    for (const s of lists.unavailable) no.appendChild(el('li', null, s));
    box.appendChild(no);
  }
  const bar = el('div', 'snap-toolbar');
  const ext = el('button', null, '打开扩展目录');
  ext.onclick = () => hub.openExtensionDir();
  const chromePage = el('button', null, '打开 Chrome 扩展页');
  chromePage.onclick = () => openOfficialExtensionsPage('chrome');
  const edgePage = el('button', null, '打开 Edge 扩展页');
  edgePage.onclick = () => openOfficialExtensionsPage('edge');
  const pair = el('button', null, '复制配对令牌');
  pair.onclick = () => copyPairingToken();
  const imp = el('button', null, '导入 JSON 快照');
  imp.onclick = () => document.getElementById('snapFile').click();
  bar.appendChild(ext); bar.appendChild(chromePage); bar.appendChild(edgePage); bar.appendChild(pair); bar.appendChild(imp);
  box.appendChild(bar);
  return box;
}

function renderSnapSidebar(activeId) {
  const box = document.getElementById('snapList');
  if (!box) return;
  box.innerHTML = '';
  if (!snapState.list.length) {
    box.appendChild(el('div', 'empty', '暂无快照'));
    return;
  }
  for (const s of snapState.list) {
    const row = el('div', 'snap-card' + (s.id === activeId ? ' active' : ''));
    row.appendChild(el('div', null, s.title || '未命名快照'));
    const ui = sessionFileUi();
    const src = ui ? ui.sourceBadgeText(s) : (s.source || '');
    row.appendChild(el('div', 'meta', `${s.browserName || s.browserId || ''} ${s.profile || ''} · ${src} · ${s.tabCount} 个页签 · ${s.closeStatus && s.closeStatus !== 'none' ? '关闭:' + s.closeStatus : '未关闭'}`));
    row.onclick = () => openSnapshotDetail(s.id);
    box.appendChild(row);
  }
}

async function openSnapshotDetail(id) {
  const s = await hub.snapshotGet(id);
  if (!s) { toast('找不到这份快照'); return; }
  snapState.current = s;
  renderSnapSidebar(id);
  const body = document.getElementById('contentBody');
  body.innerHTML = '';
  let bridgeDesc = null;
  try {
    const st = await hub.bridgeStatus();
    bridgeDesc = window.TraceHubCapabilities ? window.TraceHubCapabilities.describeBridge(st) : st;
  } catch (e) { bridgeDesc = null; }
  body.appendChild(snapIntro(bridgeDesc));
  const head = el('div', 'dash-section');
  head.appendChild(el('div', 'dash-title', s.title));
  const ui = sessionFileUi();
  const sourceText = ui ? ui.sourceBadgeText(s) : (s.source || '');
  head.appendChild(el('div', 'muted', `${s.browserName || ''} ${s.profile || ''} · 来源：${sourceText} · ${s.tabCount} 个页签 · 关闭状态：${({ none: '未关闭', pending: '等待扩展执行', done: '已关闭', partial: '部分关闭', failed: '关闭失败', cancelled: '已取消' })[s.closeStatus || 'none'] || s.closeStatus} · AI：${s.aiStatus || 'none'}`));
  if (s.source === 'session-file' && s.origin) {
    const note = s.origin.note || (ui && ui.restoreHonesty(s)) || '';
    const cls = (ui && ui.previewHonestyTone) ? ui.previewHonestyTone(s.origin, s) : ((s.origin.stale || s.origin.locked) ? 'warn' : 'muted');
    if (note) head.appendChild(el('p', cls, note));
  }
  if (s.closeError) head.appendChild(el('p', 'warn', s.closeError));
  if (s.aiError) head.appendChild(el('p', 'muted', 'AI：' + s.aiError));
  body.appendChild(head);

  const bar = el('div', 'snap-toolbar');
  const addBtn = (label, fn, cls) => { const b = el('button', cls || '', label); b.onclick = fn; bar.appendChild(b); return b; };
  const ui2 = sessionFileUi();
  addBtn(ui2 ? ui2.restoreButtonLabel(s) : (s.source === 'session-file' ? '按窗口重新打开网址…' : '按组恢复…'), () => beginRestore(s, null));
  if (s.source !== 'session-file') addBtn('恢复时跳过重复项…', () => beginRestore(s, null, true));
  addBtn('用默认浏览器打开网址…', () => openSnapshotUrlsInDefaultBrowser(s));
  const closeLabel = (s.closeStatus === 'partial' || s.closeStatus === 'failed') ? '重试关闭这些页签…' : '确认后关闭这些页签…';
  const closeBtn = addBtn(closeLabel, () => beginClose(s), 'danger');
  if (!s.persisted || s.closeStatus === 'done' || !(ui2 ? ui2.canOfferPreciseClose(s) : (s.source === 'extension' && s.extensionId))) {
    closeBtn.disabled = true;
    closeBtn.title = (ui2 && ui2.closeDisabledReason(s)) || '不能远程关闭页签。';
  }
  addBtn('本地域名预分类', async () => { await openSnapshotDetail(s.id); toast('保存时已完成本地预分类，可在下方改分组名'); });
  addBtn('AI 补充网站信息', () => runSnapAI(s, false), 'ai');
  addBtn('导出 JSON', async () => { const r = await hub.snapshotExport(s.id); if (r.ok) toast('已导出 ' + r.filePath); });
  addBtn('删除快照', async () => {
    if (!(await askConfirm('删除这份快照？页签数据会从 TraceHub 移除（不会关闭浏览器）。', '删除'))) return;
    await hub.snapshotDelete(s.id);
    snapState.current = null;
    showSnapshots();
  }, 'danger');
  body.appendChild(bar);
  body.appendChild(el('p', 'muted', 'AI 补充会使用你在设置里保存的接口，默认只发送网址和标题，不会把整页正文发出。失败时保留本地预分类，页签不会丢失。'));

  const groups = new Map();
  for (const w of s.windows || []) {
    for (const t of w.tabs || []) {
      const g = t.userGroup || t.category || '未分组';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
  }
  for (const [name, tabs] of groups) {
    const sec = el('div', 'snap-group');
    const h = el('h4');
    h.appendChild(document.createTextNode(`${name}（${tabs.length}）`));
    const ren = el('button', 'mini-btn', '重命名分组');
    ren.onclick = async () => {
      const n = await askText('新的分组名称', name);
      if (!n || n === name) return;
      await hub.snapshotRenameGroup(s.id, name, n);
      openSnapshotDetail(s.id);
    };
    const rec = el('button', 'mini-btn', '只恢复这一组…');
    rec.onclick = () => beginRestore(s, name);
    h.appendChild(ren); h.appendChild(rec);
    sec.appendChild(h);
    for (const t of tabs) {
      const row = el('div', 'snap-tab' + (t.hiddenDup ? ' dup' : ''));
      const title = el('div', 'title');
      title.appendChild(el('div', null, t.title || t.url));
      const sub = el('div', 'muted', t.url);
      if (t.pinned) title.prepend(el('span', 'pill pin', '固定'));
      if (t.hiddenDup) title.appendChild(el('span', 'pill', '重复'));
      if (!t.restorable) title.appendChild(el('span', 'pill', '不可恢复'));
      if (t.restoreStatus === 'queued') title.appendChild(el('span', 'pill', '等待扩展执行'));
      if (t.restoreStatus === 'failed') title.appendChild(el('span', 'pill fail', '恢复失败'));
      if (t.restoreStatus === 'opened') title.appendChild(el('span', 'pill ok', '已打开'));
      if (t.restoreStatus === 'failed' && t.restoreError) title.appendChild(el('div', 'muted', t.restoreError));
      title.appendChild(sub);
      if (t.summary || t.purpose) title.appendChild(el('div', 'muted', [t.purpose, t.summary].filter(Boolean).join(' · ')));
      title.onclick = () => { if (t.restorable) openUrl(t.url); };
      row.appendChild(title);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
}

async function runSnapAI(s, includeBody) {
  toast('正在用已配置的 AI 补充分类与简介（默认只发送网址和标题）…');
  const r = await hub.snapshotAI(s.id, includeBody);
  if (r.ok) toast(r.usedAI ? 'AI 补充完成' : '未配置 AI，已保留本地预分类');
  else toast('AI 失败，已保留本地预分类与全部页签：' + (r.error || ''));
  await openSnapshotDetail(s.id);
}


async function openSnapshotUrlsInDefaultBrowser(s) {
  const urls = [];
  for (const w of (s.windows || [])) {
    for (const tab of (w.tabs || [])) {
      if (tab && tab.url && /^https?:/i.test(tab.url) && tab.restorable !== false) urls.push(tab.url);
    }
  }
  if (!urls.length) { toast('没有可打开的 http(s) 网址'); return; }
  const cap = window.TraceHubCapabilities;
  const note = cap ? cap.historySessionDisclaimer() : '将用系统默认浏览器打开这些网址，不会恢复窗口、分组或登录状态。';
  const ok = await askConfirm(
    note + ` 快照中共 ${urls.length} 个网址，本次最多打开 30 个。不会把页签标记为“已由扩展恢复”。`,
    '用默认浏览器打开'
  );
  if (!ok) return;
  const r = await hub.sessionRestore(urls);
  toast(r.message || `已请系统默认浏览器打开 ${r.opened || 0} 个网址`);
}

async function beginClose(s) {
  const ui = sessionFileUi();
  if (!(ui ? ui.canOfferPreciseClose(s) : (s.source === 'extension' && s.extensionId))) {
    toast((ui && ui.closeDisabledReason(s)) || '这份快照不能按 tabId 关闭浏览器页签。');
    return;
  }
  snapState.closeId = s.id;
  document.getElementById('snapCloseInfo').textContent =
    `快照「${s.title}」已成功保存 ${s.tabCount} 个页签。只有这份快照落盘成功后才可以关闭。默认不会关闭。` +
    '扩展关闭可能不会弹出网页的“离开此页”提示，不能保护未保存的表单或文档。更稳妥的做法是自己在浏览器里关窗口。';
  const ack = document.getElementById('snapAckRisk');
  ack.checked = false;
  const go = document.getElementById('snapCloseGo');
  go.disabled = true;
  ack.onchange = () => { go.disabled = !ack.checked; };
  document.getElementById('snapCloseModal').classList.remove('hidden');
}

async function confirmClose() {
  const id = snapState.closeId;
  if (!id) return;
  if (!document.getElementById('snapAckRisk').checked) {
    toast('请先勾选风险确认，或点取消只保留快照');
    return;
  }
  document.getElementById('snapCloseGo').disabled = true;
  const r = await hub.snapshotRequestClose(id, true, true);
  document.getElementById('snapCloseModal').classList.add('hidden');
  if (!r.ok) toast(r.error || '无法关闭');
  else {
    const skip = (r.skipped && r.skipped.length) ? `，跳过 ${r.skipped.length} 个地址已变或不存在的页签` : '';
    const fail = (r.failed && r.failed.length) ? `，${r.failed.length} 个关闭失败可重试` : '';
    toast((r.message || '已发出关闭请求') + skip + fail);
  }
  if (id) await openSnapshotDetail(id);
}

async function beginRestore(s, group, skipDuplicates = false) {
  const planWrap = await hub.snapshotRestorePlan({ id: s.id, group, skipDuplicates, batchSize: 8, offset: 0 });
  if (!planWrap.ok) { toast(planWrap.error || '无法准备恢复'); return; }
  const plan = planWrap.plan;
  snapState.restorePlan = { id: s.id, group, skipDuplicates, offset: 0, plan };
  const ui = sessionFileUi();
  let extNote = '';
  if (s.source === 'session-file') {
    extNote = ' ' + ((ui && ui.restoreHonesty(s)) || plan.limitation || '');
  } else {
    try {
      const st = await hub.bridgeStatus();
      const d = window.TraceHubCapabilities ? window.TraceHubCapabilities.describeBridge(st) : st;
      if (!d.recentlySeen) {
        extNote = ' 当前还没有检测到已配对的扩展：「请扩展按布局恢复」会失败。若只想打开网址，请用「用默认浏览器打开网址」（不会恢复窗口和分组，也不会标记为扩展已恢复）。';
      }
    } catch (e) { /* ignore */ }
  }
  const planTotal = plan.total != null ? plan.total : (plan.urlCount || 0);
  document.getElementById('snapRestoreInfo').textContent =
    (s.source === 'session-file'
      ? `将按窗口重新打开「${s.title}」中的网址：共 ${planTotal} 个可恢复网址（${plan.windowCount || 0} 个窗口）。` + (plan.needsSecondConfirm ? ' 数量较多，确认后还会再问一次。' : '')
      : `将恢复「${s.title}」${group ? '中的分组「' + group + '」' : ''}：共 ${planTotal} 个可恢复网址，本批打开 ${(plan.batch && plan.batch.length) || 0} 个（默认每批 8 个，不会一次全部打开）。`) +
    (plan.skipped ? ` 已跳过 ${plan.skipped} 个网址（上限截断 ${plan.skippedLimit || 0} 个）。` : '') +
    (plan.unrestorableSkipped ? `另有 ${plan.unrestorableSkipped} 个内部页无法自动打开。` : '') +
    (s.source === 'session-file' ? '' : (plan.limitation || '')) + extNote;
  document.getElementById('snapRestoreModal').classList.remove('hidden');
}

async function confirmRestore() {
  const ctx = snapState.restorePlan;
  if (!ctx) return;
  const plan = ctx.plan || {};
  const ui = sessionFileUi();
  let largeConfirmed = false;
  if (plan.via === 'session-file-window-reopen' && ui && ui.needsLargeReopenConfirm(plan)) {
    const go = await askConfirm(ui.largeReopenConfirmText(plan), '仍然打开');
    if (!go) { toast('已取消打开'); return; }
    largeConfirmed = true;
  }
  document.getElementById('snapRestoreModal').classList.add('hidden');
  const r = await hub.snapshotRestoreBatch({
    id: ctx.id, group: ctx.group, skipDuplicates: ctx.skipDuplicates,
    batchSize: 8, offset: ctx.offset, confirmed: true, largeConfirmed,
  });
  if (!r.ok) toast(r.error || r.message || '恢复失败');
  else if (r.via === 'session-file-window-reopen') toast(r.message || '已按窗口请目标浏览器重新打开网址。这不是扩展按布局恢复。');
  else toast(r.message || '已向配对扩展发出恢复请求，等待执行。完成前不会标记为已恢复。');
  if (r.ok && r.plan) {
    snapState.restorePlan = {
      ...ctx,
      offset: r.plan.nextOffset,
      plan: r.plan,
      commandId: r.commandId || null,
      waitingAck: !!r.pending,
    };
  }
  if (ctx.id) await openSnapshotDetail(ctx.id);
}

async function maybeContinueRestoreAfterAck(commandResult) {
  const cap = window.TraceHubCapabilities;
  const ctx = snapState.restorePlan;
  if (!ctx || !ctx.plan || !cap || !cap.shouldOfferNextRestoreBatch) return;
  if (commandResult && commandResult.via === 'session-file-window-reopen') return;
  if (!cap.shouldOfferNextRestoreBatch(ctx.plan, commandResult)) return;
  const remaining = ctx.plan.remaining;
  const more = await askConfirm(`上一批已经有了扩展回执。还剩 ${remaining} 个网址，是否继续请扩展打开下一批（最多 8 个）？在扩展再次回执前不会标记为已恢复。`, '打开下一批');
  if (!more) return;
  const r = await hub.snapshotRestoreBatch({
    id: ctx.id, group: ctx.group, skipDuplicates: ctx.skipDuplicates,
    batchSize: 8, offset: ctx.offset, confirmed: true,
  });
  if (!r.ok) { toast(r.error || r.message || '下一批恢复失败'); return; }
  toast(r.message || '已发出下一批恢复请求');
  if (r.plan) {
    snapState.restorePlan = { ...ctx, offset: r.plan.nextOffset, plan: r.plan, commandId: r.commandId || null, waitingAck: !!r.pending };
  }
  if (ctx.id) await openSnapshotDetail(ctx.id);
}

async function handleSnapshotUpdated(payload) {
  const result = payload && payload.commandResult;
  if (result) {
    const cap = window.TraceHubCapabilities;
    const described = cap && cap.describeCommandResult ? cap.describeCommandResult(result) : null;
    if (described && described.text) toast(described.text);
  }
  if (state.mode === 'snapshots') {
    await showSnapshots((payload && payload.id) || (snapState.current && snapState.current.id));
  }
  if (result && result.type === 'restore') {
    await maybeContinueRestoreAfterAck(result);
  }
}

async function setupSnapshots() {
  const rec = (id, fn) => { const n = document.getElementById(id); if (n) n.onclick = fn; };
  rec('snapRefresh', () => showSnapshots(snapState.current && snapState.current.id));
  rec('snapImport', () => document.getElementById('snapFile').click());
  rec('snapCloseCancel', async () => {
    document.getElementById('snapCloseModal').classList.add('hidden');
    if (snapState.closeId) await hub.snapshotCancelClose(snapState.closeId);
    toast('已取消关闭，快照仍保留');
    if (snapState.closeId) openSnapshotDetail(snapState.closeId);
  });
  rec('snapCloseGo', confirmClose);
  rec('snapRestoreCancel', () => document.getElementById('snapRestoreModal').classList.add('hidden'));
  rec('snapRestoreGo', confirmRestore);
  rec('snapRestoreFallback', async () => {
    document.getElementById('snapRestoreModal').classList.add('hidden');
    const ctx = snapState.restorePlan;
    const s = (ctx && ctx.id) ? await hub.snapshotGet(ctx.id) : snapState.current;
    if (!s) { toast('找不到要打开的快照'); return; }
    await openSnapshotUrlsInDefaultBrowser(s);
  });
  const file = document.getElementById('snapFile');
  if (file) file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const r = await hub.snapshotImport(raw);
      if (!r.ok) throw new Error('导入失败');
      toast(`已导入 ${r.snapshot.tabCount} 个页签`);
      showSnapshots(r.snapshot.id);
    } catch (e) {
      toast('导入失败：' + (e.message || e));
    }
  });
  hub.onSnapshotUpdated((payload) => {
    handleSnapshotUpdated(payload).catch((e) => toast('更新快照状态失败：' + (e && e.message ? e.message : String(e))));
  });
}

async function maybeOnboard() {
  const cfg = await hub.getConfig();
  if (cfg.onboardingCompleted) return;
  const browsers = await hub.detectBrowsers();
  const box = document.getElementById('onboardBrowsers');
  box.innerHTML = '';
  if (!browsers.length) {
    box.appendChild(el('div', 'muted', '没有检测到可读取的浏览器配置。你仍可以使用页签快照（需安装扩展）。'));
  }
  for (const b of browsers) {
    box.appendChild(el('div', 'onboard-browser', b.name));
    for (const p of b.profiles) {
      const row = el('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.browserId = b.id;
      cb.dataset.profile = p;
      cb.checked = p !== 'Guest Profile';
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + p + (p === 'Guest Profile' ? '（访客，默认不选）' : '')));
      box.appendChild(row);
    }
  }
  document.getElementById('onboardThumbs').checked = false;
  document.getElementById('onboardContent').checked = false;
  document.getElementById('onboardModal').classList.remove('hidden');
  document.getElementById('onboardLater').onclick = () => {
    document.getElementById('onboardModal').classList.add('hidden');
    toast('尚未开始同步。打开设置或再次启动可继续完成引导。');
  };
  document.getElementById('onboardSave').onclick = async () => {
    const enabledProfiles = [...document.querySelectorAll('#onboardBrowsers input[type=checkbox]:checked')].map((cb) => ({
      browserId: cb.dataset.browserId, profile: cb.dataset.profile,
    }));
    await hub.completeOnboarding({
      enabledProfiles,
      thumbsEnabled: document.getElementById('onboardThumbs').checked,
      contentFetchEnabled: document.getElementById('onboardContent').checked,
    });
    document.getElementById('onboardModal').classList.add('hidden');
    toast(enabledProfiles.length ? '已保存，开始同步所选浏览器' : '已保存。你没有勾选任何浏览器，因此不会导入历史');
    await setupBrowserFilter();
    await loadDays();
    switchTab('today');
  };
}

// ------------------------- init -------------------------------------------
// ------------------------- theme & zoom ------------------------------------
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  localStorage.setItem('bhh-theme', theme);
  const btn = document.getElementById('btnTheme');
  btn.innerHTML = '';
  btn.appendChild(icon(theme === 'light' ? 'moon' : 'sun'));
}

function applyZoom(z) {
  const zoom = Math.min(1.6, Math.max(0.7, z));
  document.body.style.zoom = zoom;
  localStorage.setItem('bhh-zoom', String(zoom));
  return zoom;
}

// ------------------------- keyboard navigation ------------------------------
let kbIndex = -1;
function kbRows() {
  return Array.from(document.querySelectorAll('#contentBody .entry'));
}

function kbMove(delta) {
  const rows = kbRows();
  if (!rows.length) return;
  if (kbIndex >= 0 && rows[kbIndex]) rows[kbIndex].classList.remove('kb-active');
  kbIndex = Math.min(rows.length - 1, Math.max(0, kbIndex + delta));
  rows[kbIndex].classList.add('kb-active');
  rows[kbIndex].scrollIntoView({ block: 'nearest' });
}

function kbCurrent() {
  const rows = kbRows();
  return kbIndex >= 0 && rows[kbIndex] ? rows[kbIndex] : null;
}

// All dialogs share one dismiss pattern: Esc closes the topmost open one,
// and clicking the dimmed overlay (outside the card) closes it too.
function setupModalDismiss() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelectorAll('.modal:not(.hidden)');
    if (!open.length) return;
    const top = open[open.length - 1];
    // Static dialogs (with an id) hide; dynamically created overlays are removed.
    if (top.id) top.classList.add('hidden');
    else top.remove();
  });
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('mousedown', (e) => {
      if (e.target === m) m.classList.add('hidden');
    });
  }
}

function setupKeyboardNav() {
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!document.getElementById('palette').classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); kbMove(1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); kbMove(-1); }
    else if (e.key === 'Enter') {
      const row = kbCurrent();
      if (row && row.dataset.url) openUrl(row.dataset.url);
    } else if (e.key === 's') {
      const row = kbCurrent();
      if (row) { const star = row.querySelector('.star'); if (star) star.click(); }
    } else if (e.key === '/') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
  });
}

async function init() {
  setupTabs();
  for (const [id, name] of [
    ['btnAI', 'sparkles'],
    ['btnDaySummary', 'sun'], ['btnCopyMd', 'copy'],
    ['btnOrganize', 'wand'], ['btnSync', 'refresh'], ['btnExport', 'download'],
    ['btnPrivacy', 'shield'], ['btnSettings', 'gear'],
  ]) {
    document.getElementById(id).appendChild(icon(name));
  }
  for (const [tab, name] of [
    ['categories', 'tag'], ['bookmarks', 'star'], ['report', 'chart'], ['snapshots', 'layers'],
  ]) {
    document.querySelector(`.actions .tab[data-tab="${tab}"]`).appendChild(icon(name));
  }
  document.getElementById('backTop').appendChild(icon('arrow-up'));
  document.getElementById('catFilter').addEventListener('input', () => renderCategories());
  document.getElementById('bmFilter').addEventListener('input', () => { if (state.mode === 'bookmarks') showSaved(); });
  document.getElementById('rp7').onclick = () => { switchTab('report'); showReport(7); };
  document.getElementById('rp30').onclick = () => { switchTab('report'); showReport(30); };
  document.getElementById('rpColl').onclick = () => { switchTab('report'); showCollections(); };
  applyTheme(localStorage.getItem('bhh-theme') || 'dark');
  applyZoom(Number(localStorage.getItem('bhh-zoom')) || 1);
  document.getElementById('btnTheme').onclick = () =>
    applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
  // Ctrl+wheel / Ctrl+= / Ctrl+- font scaling
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const cur = Number(localStorage.getItem('bhh-zoom')) || 1;
    applyZoom(cur + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  document.getElementById('btnAI').onclick = () => {
    const q = document.getElementById('searchInput').value.trim();
    if (q) runSearch(true);
    else openAsk();
  };
  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(e.ctrlKey);
    if (e.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        if (state.mode === 'search') {
          const active = document.querySelector('.sidebar .tab.active, .actions .tab.active');
          switchTab(active ? active.dataset.tab : 'timeline');
        }
      }
      searchInput.blur();
    }
  });
  // Live search: debounce while typing (2+ chars).
  let liveTimer = null;
  searchInput.addEventListener('input', () => {
    if (liveTimer) clearTimeout(liveTimer);
    const q = searchInput.value.trim();
    liveTimer = setTimeout(() => {
      if (q.length >= 2) runSearch(false);
      else if (!q && state.mode === 'search') {
        const active = document.querySelector('.sidebar .tab.active, .actions .tab.active');
        switchTab(active ? active.dataset.tab : 'timeline');
      }
    }, 300);
  });

  setupKeyboardNav();
  setupModalDismiss();
  document.addEventListener('click', (e) => {
    closeCtxMenu();
    if (!e.target.closest('#btnPrivacy'))
      document.getElementById('privacyMenu').classList.add('hidden');
  });

  document.getElementById('btnDaySummary').onclick = () => {
    const lt = state.lastTimeline;
    if (!lt) { toast('请先在时间树或今日中选择一天'); return; }
    if (state.summaryDay === lt.day) hideSummary();
    else loadSummary(lt.day);
  };
  document.getElementById('btnCopyMd').onclick = async () => {
    const lt = state.lastTimeline;
    if (!lt || !lt.tl || !lt.tl.total) { toast('当天没有可复制的记录'); return; }
    await hub.copyText(buildMarkdownLog(lt.day, lt.tl));
    toast(`已复制 ${lt.day} 的 Markdown 阅读日志`);
  };

  document.getElementById('btnPrivacy').onclick = (e) => { e.stopPropagation(); showPrivacyMenu(); };
  refreshPrivacyBtn();
  setInterval(refreshPrivacyBtn, 30000);

  document.getElementById('domainClose').onclick = () =>
    document.getElementById('domainModal').classList.add('hidden');
  document.getElementById('domainSearch').onclick = () => {
    document.getElementById('domainModal').classList.add('hidden');
    const input = document.getElementById('searchInput');
    input.value = `site:${domainCurrent} `;
    input.focus();
    runSearch(false);
  };

  // Back to top for long timelines.
  const contentBody = document.getElementById('contentBody');
  const backTop = document.getElementById('backTop');
  contentBody.addEventListener('scroll', () => {
    backTop.classList.toggle('hidden', contentBody.scrollTop < 400);
  });
  backTop.onclick = () => contentBody.scrollTo({ top: 0, behavior: 'smooth' });

  // Drag entries onto the 收藏 tab.
  {
    const tab = document.querySelector('.tab[data-tab="bookmarks"]');
    tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.classList.add('drop-hover'); });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-hover'));
    tab.addEventListener('drop', async (e) => {
      e.preventDefault();
      tab.classList.remove('drop-hover');
      if (state.dragItem) {
        await addSaved(state.dragItem);
        toast(`已收藏：${(state.dragItem.title || state.dragItem.url).slice(0, 40)}`);
        state.dragItem = null;
      }
    });
  }

  hub.onFocusSearch(() => {
    searchInput.focus();
    searchInput.select();
  });
  hub.onOpenReport(() => switchTab('report'));

  // Ctrl+K opens the command palette
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape') closePalette();
  });
  setupPalette();

  document.getElementById('curateCancel').onclick = () =>
    document.getElementById('curateModal').classList.add('hidden');
  document.getElementById('curateToggle').onclick = () => {
    const boxes = document.querySelectorAll('#curateList input[type=checkbox]');
    const all = [...boxes].every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !all; });
  };
  document.getElementById('curateApply').onclick = async () => {
    const picks = [...document.querySelectorAll('#curateList input[type=checkbox]')]
      .filter((b) => b.checked)
      .map((b) => curateItems[Number(b.dataset.idx)])
      .filter(Boolean);
    document.getElementById('curateModal').classList.add('hidden');
    if (!picks.length) { toast('没有勾选任何页面'); return; }
    const r = await hub.curateApply(picks);
    toast(`已收藏 ${r.added} 个页面`);
    switchTab('bookmarks');
  };

  document.getElementById('sessCancel').onclick = () =>
    document.getElementById('sessionModal').classList.add('hidden');
  document.getElementById('sessOpen').onclick = async () => {
    const n = (typeof sessionUrls !== 'undefined' && sessionUrls) ? sessionUrls.length : 0;
    const cap = Math.min(n, 30);
    const msg = (n > 30
      ? `将用系统默认浏览器打开 30 个历史网址（共 ${n} 个，超出上限的不会自动打开）。`
      : `将用系统默认浏览器打开 ${cap} 个历史网址。`)
      + '这不是恢复当前已打开的页签，也不会恢复分组或登录状态。是否继续？';
    if (!(await askConfirm(msg, '打开'))) return;
    document.getElementById('sessionModal').classList.add('hidden');
    setStatus('正在请系统默认浏览器打开网址…');
    const r = await hub.sessionRestore(sessionUrls);
    const extra = n > 30 ? `（已截断，未打开 ${n - 30} 个）` : '';
    const resultMsg = ((r && r.message) ? r.message : `已请系统默认浏览器打开 ${(r && r.opened) || 0} 个网址`) + extra;
    setStatus(resultMsg);
    toast(resultMsg);
  };
  document.getElementById('btnSync').onclick = async () => {
    setStatus('正在同步…');
    const r = await hub.syncNow();
    setStatus(`同步完成，新增 ${r.inserted} 条`);
    await loadDays();
  };
  document.getElementById('cfgCatchUpHistory').onclick = async () => {
    const btn = document.getElementById('cfgCatchUpHistory');
    const state = document.getElementById('catchUpState');
    btn.disabled = true;
    state.textContent = '正在从头补同步…';
    setStatus('正在重新同步历史…');
    try {
      const r = await hub.catchUpHistory();
      const n = (r && r.inserted) || 0;
      const days = (r && r.repairedDays) || [];
      const dayNote = days.length ? `，涉及 ${days.length} 天` : '';
      const msg = r && r.skipped
        ? (r.skipped === 'onboarding' ? '请先完成引导后再重新同步' : '当前无法重新同步')
        : `重新同步完成，新补入 ${n} 条访问${dayNote}`;
      state.textContent = msg;
      setStatus(msg);
      toast(msg);
      await loadDays();
    } catch (e) {
      const msg = '重新同步失败：' + (e && e.message ? e.message : String(e));
      state.textContent = msg;
      setStatus(msg);
      toast(msg);
    } finally {
      btn.disabled = false;
    }
  };
  document.getElementById('btnOrganize').onclick = async () => {
    setStatus('AI 整理中…');
    const r = await hub.organize(150);
    setStatus(`整理完成，处理 ${r.organized} 个网址`);
    loadCategories();
  };
  document.getElementById('btnSettings').onclick = openSettings;
  document.getElementById('askClose').onclick = () =>
    document.getElementById('askModal').classList.add('hidden');
  document.getElementById('askSend').onclick = sendAsk;
  document.getElementById('askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAsk();
  });
  document.getElementById('cfgCancel').onclick = () =>
    document.getElementById('settingsModal').classList.add('hidden');
  document.getElementById('cfgSave').onclick = saveSettings;
  document.getElementById('cfgTest').onclick = testAIConnection;
  document.getElementById('cfgClearKey').onclick = async () => {
    if (!(await askConfirm('清除本机保存的 AI / Jina 密钥？清除后需重新填写。', '清除密钥'))) return;
    await hub.clearSecrets();
    document.getElementById('cfgApiKey').value = '';
    document.getElementById('cfgJinaKey').value = '';
    document.getElementById('keyState').textContent = '（未配置，使用本地模式）';
    document.getElementById('jinaState').textContent = '';
    toast('已清除本机保存的密钥');
  };
  document.getElementById('cfgOpenExt').onclick = () => hub.openExtensionDir();
  const cfgChromeExt = document.getElementById('cfgOpenChromeExt');
  if (cfgChromeExt) cfgChromeExt.onclick = () => openOfficialExtensionsPage('chrome');
  const cfgEdgeExt = document.getElementById('cfgOpenEdgeExt');
  if (cfgEdgeExt) cfgEdgeExt.onclick = () => openOfficialExtensionsPage('edge');

  document.getElementById('cfgCopyToken').onclick = async () => {
    const tok = document.getElementById('cfgBridgeToken').value;
    if (!tok) return;
    await hub.copyText(tok);
    toast('配对令牌已复制');
  };
  document.getElementById('cfgRegenToken').onclick = async () => {
    if (!(await askConfirm('重新生成后，需要在扩展选项里填写新令牌。', '重新生成'))) return;
    const cfg = await hub.regenBridgeToken();
    document.getElementById('cfgBridgeToken').value = cfg.bridgeToken || '';
    toast('已生成新令牌');
  };
  document.getElementById('cfgPurgeNoise').onclick = async () => {
    await purgeNoiseFlow();
    refreshNoiseState();
  };
  document.getElementById('cfgRestoreNoise').onclick = async () => {
    const r = await hub.noiseRestore();
    toast(r.restored ? `已恢复 ${r.restored} 条记录` : '没有可恢复的记录');
    refreshNoiseState();
    refreshCurrentView();
  };
  document.getElementById('cfgBackupNow').onclick = async () => {
    await hub.backupNow();
    toast('备份完成');
    refreshBackupState();
  };
  document.getElementById('cfgBackupRestore').onclick = async () => {
    const r = await hub.backupRestore();
    if (!r.restored) toast(r.error || '已取消恢复');
    else toast('备份已校验并恢复，正在重启');
  };
  document.getElementById('snapshotClose').onclick = () =>
    document.getElementById('snapshotModal').classList.add('hidden');
  document.getElementById('snapshotOpen').onclick = () => {
    if (snapshotUrl) openUrl(snapshotUrl);
  };
  document.getElementById('traceClose').onclick = () =>
    document.getElementById('traceModal').classList.add('hidden');

  document.getElementById('btnExport').onclick = () =>
    document.getElementById('exportModal').classList.remove('hidden');
  document.getElementById('expCancel').onclick = () =>
    document.getElementById('exportModal').classList.add('hidden');
  const doExport = async (fmt) => {
    document.getElementById('exportModal').classList.add('hidden');
    const r = await hub.exportData(fmt);
    if (r.saved) setStatus(`已导出 ${r.count} 条到 ${r.filePath}`);
  };
  document.getElementById('expCsv').onclick = () => doExport('csv');
  document.getElementById('expJson').onclick = () => doExport('json');

  setupSnapshots();
  await maybeOnboard();
  await setupBrowserFilter();

  let refreshTimer = null;
  hub.onHistoryUpdated(() => {
    // debounce UI refresh; keep the current view
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadDays();
      refreshCurrentView();
    }, 800);
  });

  hub.onBookmarkArchived((r) => {
    const bits = [];
    if (r.archived) bits.push('正文已离线存档');
    if (r.folder) bits.push(`归入「${r.folder}」`);
    if (r.tags && r.tags.length) bits.push(`标签：${r.tags.slice(0, 4).join('、')}`);
    if (bits.length) toast(`收藏已就绪：${bits.join(' · ')}`);
    if (state.mode === 'bookmarks') showSaved();
  });

  const chip = document.getElementById('bridgeChip');
  if (chip) chip.onclick = () => switchTab('snapshots');
  await updateBridgeChip();
  setInterval(() => { updateBridgeChip().catch(() => {}); }, 15000);

  await loadDays();
  // Default landing: 今日 (user can switch to 时间树).
  switchTab('today');
}

init();
