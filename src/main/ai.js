'use strict';

// AI layer. Uses any OpenAI-compatible chat completions endpoint.
// Config: { apiKey, baseUrl, model }. When no apiKey is set, the functions
// gracefully fall back to local heuristics so the app is fully usable offline.

const { domainOf } = require('./store');

// Common OpenAI-compatible providers. `id` is stored in config.ai.provider.
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
  { id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '' },
];

function hasKey(config) {
  if (config && config.provider === 'ollama') return true; // local, no key needed
  return !!(config && config.apiKey && config.apiKey.trim());
}

function hasKeyStrict(config) {
  return !!(config && config.apiKey && config.apiKey.trim());
}

async function chat(config, messages, { json = false, temperature = 0.2 } = {}) {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = config.model || 'gpt-4o-mini';
  const apiKey = config.apiKey || 'ollama';
  const body = {
    model,
    messages,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('AI 请求超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// --------------------------- AI search -----------------------------------
// Rank the candidate history items against a natural language query.
async function aiSearch(config, query, candidates) {
  if (!hasKey(config)) {
    return localSearch(query, candidates);
  }
  // Keep the payload small: send index + title + domain.
  const list = candidates.slice(0, 200).map((c, i) => ({
    i,
    t: c.title,
    d: c.domain,
    u: c.url,
  }));
  const messages = [
    {
      role: 'system',
      content:
        '你是浏览器历史搜索助手。根据用户的自然语言意图，从候选网页列表中挑选最相关的条目。' +
        '只返回 JSON：{"results":[{"i":<索引>,"reason":"<简短中文理由>"}]}，按相关性从高到低，最多20条。',
    },
    {
      role: 'user',
      content: `查询：${query}\n候选列表(JSON)：${JSON.stringify(list)}`,
    },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localSearch(query, candidates);
  }
  const results = [];
  for (const r of parsed.results || []) {
    const item = candidates[r.i];
    if (item) results.push({ ...item, reason: r.reason || '' });
  }
  return results;
}

function localSearch(query, candidates) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const scored = candidates
    .map((c) => {
      const hay = `${c.title} ${c.url} ${c.domain}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map((x) => ({ ...x.c, reason: '关键词匹配（未配置 AI Key，使用本地搜索）' }));
  return scored;
}

// --------------------------- AI organize ----------------------------------
// Classify items into categories + tags. Returns [{url, category, tags}].
async function aiOrganize(config, items) {
  if (!hasKey(config)) {
    return localOrganize(items);
  }
  const list = items.slice(0, 120).map((c, i) => ({ i, t: c.title, d: c.domain }));
  const messages = [
    {
      role: 'system',
      content:
        '你是网页整理助手。为每个网页归类到一个简洁的中文分类（如"开发/文档"、"新闻资讯"、"社交媒体"、' +
        '"视频娱乐"、"购物"、"学习"、"工作工具"等），并给出1-3个中文标签。' +
        '只返回 JSON：{"items":[{"i":<索引>,"category":"<分类>","tags":["<标签>"]}]}。',
    },
    { role: 'user', content: JSON.stringify(list) },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localOrganize(items);
  }
  const out = [];
  for (const r of parsed.items || []) {
    const item = items[r.i];
    if (item) out.push({ url: item.url, category: r.category || '未分类', tags: r.tags || [] });
  }
  return out;
}

// Heuristic categorisation by domain when no AI key is available.
const DOMAIN_RULES = [
  [/github\.com|gitlab\.com|stackoverflow\.com|npmjs\.com|developer\.|docs\./, '开发/文档'],
  [/youtube\.com|bilibili\.com|netflix\.com|twitch\.tv|iqiyi\.com|youku\.com/, '视频娱乐'],
  [/twitter\.com|x\.com|facebook\.com|instagram\.com|weibo\.com|reddit\.com|zhihu\.com/, '社交媒体'],
  [/amazon\.|taobao\.com|tmall\.com|jd\.com|ebay\.com|shopping/, '购物'],
  [/news|bbc\.|cnn\.|nytimes\.com|sina\.com|163\.com|sohu\.com/, '新闻资讯'],
  [/mail\.|gmail\.com|outlook\.|notion\.so|slack\.com|office\.com|feishu\.cn/, '工作工具'],
  [/wikipedia\.org|coursera\.org|udemy\.com|edx\.org|khanacademy\.org/, '学习'],
];

function localOrganize(items) {
  return items.map((c) => {
    let category = '其他';
    for (const [re, cat] of DOMAIN_RULES) {
      if (re.test(c.domain || '') || re.test(c.url || '')) {
        category = cat;
        break;
      }
    }
    return { url: c.url, category, tags: c.domain ? [c.domain] : [] };
  });
}

// --------------------------- Daily summary --------------------------------
async function dailySummary(config, day, items) {
  if (!hasKey(config)) {
    const byDomain = {};
    for (const it of items) {
      const d = it.domain || domainOf(it.url);
      byDomain[d] = (byDomain[d] || 0) + 1;
    }
    const top = Object.entries(byDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d, n]) => `${d}(${n})`)
      .join('、');
    return `${day} 共浏览 ${items.length} 条记录。主要站点：${top}。（未配置 AI Key，使用本地统计摘要）`;
  }
  const list = items.slice(0, 150).map((c) => ({ t: c.title, d: c.domain }));
  const messages = [
    {
      role: 'system',
      content: '你是每日阅读助手。用简体中文，用3-5句话总结用户当天的浏览主题、关注点与可能的任务，语气自然。',
    },
    { role: 'user', content: `日期：${day}\n浏览记录(JSON)：${JSON.stringify(list)}` },
  ];
  return chat(config, messages, { temperature: 0.5 });
}

// --------------------------- AI enrichment --------------------------------
// Generate a short Chinese summary + keywords for a batch of pages.
// pages: [{ url, title, description, content? }]
// Returns [{ url, summary, keywords }].
async function aiEnrich(config, pages) {
  if (!hasKey(config) || pages.length === 0) return [];
  const list = pages.map((p, i) => ({
    i,
    t: (p.title || '').slice(0, 120),
    d: (p.description || '').slice(0, 300),
    c: (p.content || '').slice(0, 1500),
    u: p.url.slice(0, 200),
  }));
  const messages = [
    {
      role: 'system',
      content:
        '你是网页理解助手。为每个网页生成：1) 一段中文介绍（60-120字，说清页面主题、主要内容/观点、适合谁看或有什么用）；' +
        '2) 20个中文关键词（覆盖主题、领域、技术/概念、实体、站点类型、用途、受众等不同角度，尽量给满20个）。' +
        '只返回 JSON：{"items":[{"i":<索引>,"summary":"<介绍>","keywords":["<关键词>"]}]}。',
    },
    { role: 'user', content: JSON.stringify(list) },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const r of parsed.items || []) {
    const page = pages[r.i];
    if (page) out.push({ url: page.url, summary: r.summary || '', keywords: r.keywords || [] });
  }
  return out;
}

// --------------------------- Weekly report ---------------------------------
// stats: output of store.rangeStats(). Returns { narrative, ... } text.
async function weeklyReport(config, label, stats) {
  const topD = stats.topDomains.map((t) => `${t.domain}(${t.count})`).join('、');
  if (!hasKey(config)) {
    const busiest = [...stats.days].sort((a, b) => b.count - a.count)[0];
    return (
      `${label}：共 ${stats.totalVisits} 次访问、${stats.distinctUrls} 个网页、${stats.distinctDomains} 个网站。` +
      (busiest ? `最活跃的一天是 ${busiest.day}（${busiest.count} 次）。` : '') +
      `主要站点：${topD}。（未配置 AI Key，使用本地统计报告）`
    );
  }
  const messages = [
    {
      role: 'system',
      content:
        '你是阅读分析助手。根据浏览统计数据，用简体中文写一份简短的阅读报告（4-6句话）：' +
        '总结主要研究/阅读主题、时间分布特点、值得注意的趋势，并给出1条建议。语气自然专业。',
    },
    {
      role: 'user',
      content: `周期：${label}\n统计(JSON)：${JSON.stringify({
        totalVisits: stats.totalVisits,
        distinctUrls: stats.distinctUrls,
        days: stats.days,
        topDomains: stats.topDomains,
        topPages: stats.topPages.map((p) => ({ t: p.title, n: p.count })),
      })}`,
    },
  ];
  return chat(config, messages, { temperature: 0.5 });
}

// --------------------------- Smart collections ------------------------------
// Cluster recent pages into topical collections. Returns [{name, urls:[...]}].
async function aiCollections(config, items) {
  if (!hasKey(config)) {
    return localCollections(items);
  }
  const list = items.slice(0, 150).map((c, i) => ({ i, t: c.title, d: c.domain }));
  const messages = [
    {
      role: 'system',
      content:
        '你是主题聚类助手。把网页按"研究专题"聚类（同一主题的页面归到一起），给每个专题起一个具体的中文名字' +
        '（如"React 性能优化"、"日本旅行攻略"），忽略无法归类的页面。专题数量 3-8 个，每个至少 2 个页面。' +
        '只返回 JSON：{"collections":[{"name":"<专题名>","items":[<索引>]}]}。',
    },
    { role: 'user', content: JSON.stringify(list) },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localCollections(items);
  }
  const out = [];
  for (const c of parsed.collections || []) {
    const urls = (c.items || []).map((i) => items[i]).filter(Boolean);
    if (urls.length >= 2) out.push({ name: c.name || '专题', items: urls });
  }
  return out;
}

// Fallback: cluster by shared keywords, then by domain.
function localCollections(items) {
  const byKey = new Map();
  for (const it of items) {
    const keys = (it.keywords && it.keywords.length ? it.keywords : [it.domain]).filter(Boolean);
    for (const k of keys.slice(0, 2)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
  }
  return Array.from(byKey.entries())
    .filter(([, arr]) => arr.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([name, arr]) => ({
      name: `${name}（本地聚类）`,
      items: Array.from(new Map(arr.map((x) => [x.url, x])).values()),
    }));
}

// --------------------------- Ask your history -------------------------------
// Answer a natural-language question grounded in the user's history items.
async function askHistory(config, question, items, ontology = null) {
  if (!hasKey(config)) {
    throw new Error('历史问答需要配置 AI Key（设置 → AI 大模型），或使用本地 Ollama。');
  }
  const list = items.slice(0, 120).map((c, i) => ({
    i,
    t: c.title,
    d: c.domain,
    s: c.summary || (c.description || '').slice(0, 100),
    time: new Date(c.visitTime).toISOString().slice(0, 16),
  }));
  const messages = [
    {
      role: 'system',
      content:
        '你是浏览历史问答助手。你会得到两部分资料：1) "本体模型"——从用户浏览历史构建的知识画像' +
        '（主题及其关联站点/关键词、常用站点、高频关键词、活跃时段），用它理解用户的兴趣、习惯与主题间的关联；' +
        '2) 具体浏览记录列表。结合两者回答问题，用简体中文，简洁准确。' +
        '引用具体页面时给出其索引，格式 [i]。只返回 JSON：' +
        '{"answer":"<回答>","refs":[<引用的索引>]}。若资料中没有相关信息，如实说明。',
    },
    {
      role: 'user',
      content:
        `问题：${question}\n` +
        (ontology ? `本体模型(JSON)：${JSON.stringify(ontology)}\n` : '') +
        `浏览记录(JSON)：${JSON.stringify(list)}`,
    },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { answer: content, refs: [] };
  }
  const refs = (parsed.refs || []).map((i) => items[i]).filter(Boolean);
  return { answer: parsed.answer || '', refs };
}

// --------------------------- Bookmark auto-file ------------------------------
// Pick a folder (from the user's existing tree, or suggest a new one), tags and
// a short description for a newly saved bookmark. page: {url,title,description,content}.
async function aiBookmarkMeta(config, page, folders) {
  if (!hasKey(config)) {
    const [r] = localOrganize([{ url: page.url, title: page.title, domain: domainOf(page.url) }]);
    return { folder: null, category: r.category, tags: r.tags, description: page.description || '' };
  }
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏夹整理助手。用户刚收藏了一个网页，请：' +
        '1) 从现有文件夹列表中选最合适的一个（多级用 / 分隔）；都不合适时可以建议一个新的简短中文文件夹名；' +
        '2) 给出一个简洁中文分类和 3-6 个中文标签；' +
        '3) 写一段 40-80 字的中文说明（页面主题 + 有什么用）。' +
        '只返回 JSON：{"folder":"<文件夹路径>","category":"<分类>","tags":["<标签>"],"description":"<说明>"}。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        url: page.url.slice(0, 200),
        title: (page.title || '').slice(0, 150),
        description: (page.description || '').slice(0, 300),
        content: (page.content || '').slice(0, 2000),
        folders: (folders || []).slice(0, 80),
      }),
    },
  ];
  const content = await chat(config, messages, { json: true });
  try {
    const p = JSON.parse(content);
    return {
      folder: p.folder ? String(p.folder).trim() : null,
      category: p.category || null,
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 6) : [],
      description: p.description || '',
    };
  } catch (e) {
    const [r] = localOrganize([{ url: page.url, title: page.title, domain: domainOf(page.url) }]);
    return { folder: null, category: r.category, tags: r.tags, description: page.description || '' };
  }
}

// --------------------------- Curate a day into bookmarks --------------------
// Pick the pages from one day's browsing that are worth keeping and file each
// into a folder (existing ones preferred, or a suggested new one).
// items: deduped visits [{url,title,domain,summary,description}].
// Returns [{url,title,domain,folder,tags,reason}].
async function aiCurateDay(config, items, folders) {
  if (!items.length) return [];
  if (!hasKey(config)) return localCurateDay(items);
  const list = items.slice(0, 150).map((c, i) => ({
    i,
    t: (c.title || '').slice(0, 120),
    d: c.domain,
    s: (c.summary || c.description || '').slice(0, 100),
  }));
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏夹整理助手。从用户一天的浏览记录中挑选“值得长期收藏”的网页' +
        '（教程、文档、深度文章、工具、参考资料等），排除搜索页、登录跳转、首页、一次性浏览和重复内容。' +
        '为每个选中页面指定收藏夹：优先从现有文件夹列表里选（多级用 / 分隔），都不合适时建议一个简短的新中文文件夹名；' +
        '并给 1-3 个中文标签和一句简短理由。' +
        '只返回 JSON：{"items":[{"i":<索引>,"folder":"<文件夹>","tags":["<标签>"],"reason":"<理由>"}]}。',
    },
    {
      role: 'user',
      content: JSON.stringify({ folders: (folders || []).slice(0, 80), pages: list }),
    },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localCurateDay(items);
  }
  const out = [];
  const seen = new Set();
  for (const r of parsed.items || []) {
    const item = items[r.i];
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      url: item.url,
      title: item.title || item.url,
      domain: item.domain,
      folder: r.folder ? String(r.folder).trim() : '',
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 3) : [],
      reason: r.reason || '',
    });
  }
  return out;
}

// Fallback: keep pages with a real path (not bare homepages) and file them by
// domain rules. Marked so the UI can explain the local mode.
function localCurateDay(items) {
  const out = [];
  for (const c of items) {
    let pathname = '';
    try { pathname = new URL(c.url).pathname; } catch (e) { continue; }
    if (pathname.length <= 1) continue; // bare homepage — unlikely worth keeping
    const [r] = localOrganize([c]);
    out.push({
      url: c.url,
      title: c.title || c.url,
      domain: c.domain,
      folder: r.category,
      tags: r.tags,
      reason: '本地规则筛选（未配置 AI Key）',
    });
  }
  return out.slice(0, 100);
}

// --------------------------- Batch-file bookmarks ---------------------------
// Assign uncategorized bookmarks to folders (existing preferred, new allowed).
// items: [{url,title,domain}]. Returns [{url,title,domain,folder,tags}].
async function aiOrganizeBookmarks(config, items, folders) {
  if (!items.length) return [];
  if (!hasKey(config)) return localFileBookmarks(items);
  const list = items.slice(0, 200).map((c, i) => ({ i, t: (c.title || '').slice(0, 120), d: c.domain }));
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏夹整理助手。把每个未分类的收藏归入最合适的文件夹：' +
        '优先从现有文件夹列表里选（多级用 / 分隔），都不合适时建议一个简短的新中文文件夹名；并给 1-3 个中文标签。' +
        '只返回 JSON：{"items":[{"i":<索引>,"folder":"<文件夹>","tags":["<标签>"]}]}。',
    },
    { role: 'user', content: JSON.stringify({ folders: (folders || []).slice(0, 80), pages: list }) },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localFileBookmarks(items);
  }
  const out = [];
  for (const r of parsed.items || []) {
    const item = items[r.i];
    if (!item || !r.folder) continue;
    out.push({
      url: item.url,
      title: item.title || item.url,
      domain: item.domain,
      oldFolder: item.folder || '',
      folder: String(r.folder).trim(),
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 3) : [],
    });
  }
  return out;
}

function localFileBookmarks(items) {
  return items.map((c) => {
    const [r] = localOrganize([c]);
    return {
      url: c.url,
      title: c.title || c.url,
      domain: c.domain,
      oldFolder: c.folder || '',
      folder: r.category,
      tags: r.tags,
    };
  });
}

// Propose a whole new folder structure over ALL bookmarks (topic clustering).
// Returns the same assignment shape as aiOrganizeBookmarks.
async function aiFolderStructure(config, items, folders) {
  if (!items.length) return [];
  if (!hasKey(config)) return localFileBookmarks(items);
  const list = items.slice(0, 250).map((c, i) => ({ i, t: (c.title || '').slice(0, 120), d: c.domain, f: c.folder || '' }));
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏夹架构师。基于用户的全部收藏，设计一套清晰的主题文件夹结构（最多两级，用 / 分隔，' +
        '顶层 5-12 个，名字简短具体），并把每个收藏归入其中。可参考但不必沿用现有文件夹。' +
        '只返回 JSON：{"items":[{"i":<索引>,"folder":"<文件夹>"}]}。',
    },
    { role: 'user', content: JSON.stringify({ existingFolders: (folders || []).slice(0, 80), pages: list }) },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return localFileBookmarks(items);
  }
  const out = [];
  for (const r of parsed.items || []) {
    const item = items[r.i];
    if (!item || !r.folder) continue;
    const folder = String(r.folder).trim();
    if (!folder || folder === item.folder) continue; // only report actual moves
    out.push({
      url: item.url,
      title: item.title || item.url,
      domain: item.domain,
      oldFolder: item.folder || '',
      folder,
      tags: [],
    });
  }
  return out;
}

// Detect duplicate / near-duplicate bookmarks. Returns [{reason, items:[{url,title}]}].
async function aiDuplicateBookmarks(config, items) {
  const local = localDuplicateBookmarks(items);
  if (!hasKey(config) || items.length < 2) return local;
  const list = items.slice(0, 200).map((c, i) => ({ i, t: (c.title || '').slice(0, 120), u: c.url.slice(0, 160) }));
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏去重助手。找出内容重复或高度相似的收藏（同一页面的不同 URL、同一文章的转载、内容几乎相同的页面）。' +
        '只报告有把握的重复组，每组至少 2 条。只返回 JSON：{"groups":[{"reason":"<简短说明>","items":[<索引>]}]}。',
    },
    { role: 'user', content: JSON.stringify(list) },
  ];
  let parsed;
  try {
    parsed = JSON.parse(await chat(config, messages, { json: true }));
  } catch (e) {
    return local;
  }
  const seen = new Set(local.flatMap((g) => g.items.map((x) => x.url)));
  const out = [...local];
  for (const g of parsed.groups || []) {
    const members = (g.items || []).map((i) => items[i]).filter((x) => x && !seen.has(x.url));
    if (members.length >= 2) {
      members.forEach((m) => seen.add(m.url));
      out.push({ reason: g.reason || 'AI 判断内容相似', items: members.map((m) => ({ url: m.url, title: m.title || m.url })) });
    }
  }
  return out;
}

// Exact duplicates: same URL ignoring query/hash/trailing slash, or same title.
function localDuplicateBookmarks(items) {
  const groups = new Map();
  const add = (key, it) => {
    if (!key) return;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(it.url, it);
  };
  for (const it of items) {
    add('u:' + it.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase(), it);
    const t = String(it.title || '').trim().toLowerCase();
    if (t.length >= 8) add('t:' + t, it);
  }
  const seen = new Set();
  const out = [];
  for (const [key, map] of groups) {
    if (map.size < 2) continue;
    const members = [...map.values()];
    if (members.every((m) => seen.has(m.url))) continue;
    members.forEach((m) => seen.add(m.url));
    out.push({
      reason: key.startsWith('u:') ? '同一链接（仅参数不同）' : '标题完全相同',
      items: members.map((m) => ({ url: m.url, title: m.title || m.url })),
    });
  }
  return out;
}

// --------------------------- Ask your bookmarks -----------------------------
// Answer a question grounded in offline-archived bookmark contents.
async function askBookmarks(config, question, items) {
  if (!hasKey(config)) {
    throw new Error('收藏问答需要配置 AI Key（设置 → AI 大模型），或使用本地 Ollama。');
  }
  const list = items.slice(0, 60).map((c, i) => ({
    i,
    t: (c.title || '').slice(0, 120),
    u: c.url.slice(0, 160),
    f: c.folder || '',
    c: (c.content || c.summary || c.description || '').slice(0, 1200),
  }));
  const messages = [
    {
      role: 'system',
      content:
        '你是收藏夹问答助手。依据用户收藏网页的离线正文回答问题，用简体中文，准确引用来源。' +
        '引用时给出索引 [i]。只返回 JSON：{"answer":"<回答>","refs":[<索引>]}。资料中没有相关信息时如实说明。',
    },
    { role: 'user', content: `问题：${question}\n收藏资料(JSON)：${JSON.stringify(list)}` },
  ];
  const content = await chat(config, messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { answer: content, refs: [] };
  }
  const refs = (parsed.refs || []).map((i) => items[i]).filter(Boolean);
  return { answer: parsed.answer || '', refs };
}

// Quick connectivity check for the settings dialog.
async function testConnection(config) {
  if (!hasKey(config)) {
    return { ok: false, message: '未配置 API Key（Ollama 除外）' };
  }
  const started = Date.now();
  try {
    const text = await chat(config, [
      { role: 'user', content: '只回复两个字：正常' },
    ], { temperature: 0 });
    return { ok: true, message: `连接成功（${Date.now() - started}ms）：${String(text).slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: `连接失败：${String(e.message || e).slice(0, 200)}` };
  }
}

module.exports = {
  aiSearch, aiOrganize, dailySummary, aiEnrich, hasKey, PROVIDERS,
  weeklyReport, aiCollections, askHistory, testConnection,
  aiBookmarkMeta, askBookmarks, aiCurateDay,
  aiOrganizeBookmarks, aiFolderStructure, aiDuplicateBookmarks,
};
