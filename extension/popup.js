'use strict';

const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const btnSave = document.getElementById('btnSave');
const btnRefresh = document.getElementById('btnRefresh');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function renderPreview(payload) {
  previewEl.innerHTML = '';
  if (!payload || !payload.windows) return;
  let n = 0;
  for (const [i, w] of payload.windows.entries()) {
    const head = document.createElement('div');
    head.className = 'w';
    head.textContent = `窗口 ${i + 1}${w.focused ? '（当前）' : ''} · ${w.tabs.length} 个页签`;
    previewEl.appendChild(head);
    for (const t of w.tabs) {
      n += 1;
      const row = document.createElement('div');
      row.className = 't';
      row.title = t.url;
      row.innerHTML = `${t.pinned ? '<span class="pin">📌</span>' : ''}<span class="u">${escapeHtml(t.title || t.url)}</span>`;
      previewEl.appendChild(row);
    }
  }
  if (!n) previewEl.textContent = '没有可列出的页签。';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

async function refresh() {
  const health = await send('health');
  const collected = await send('collect');
  if (collected && collected.windows) renderPreview(collected);
  if (!health || !health.ok) {
    setStatus('未连上本机 TraceHub。请先打开应用，并在选项页粘贴配对令牌。', 'warn');
    btnSave.disabled = true;
    return;
  }
  setStatus('已连上本机应用。预览如下，确认后点保存。默认不会关页签。', 'ok');
  btnSave.disabled = false;
}

btnRefresh.addEventListener('click', () => refresh().catch((e) => setStatus(e.message, 'err')));
btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  setStatus('正在保存快照…', '');
  try {
    const r = await send('save');
    if (!r || r.ok === false) throw new Error((r && r.error) || '保存失败');
    setStatus(`已保存 ${r.tabCount} 个页签（编号 ${String(r.snapshotId || '').slice(0, 8)}…）。请到 TraceHub 查看。默认未关闭任何页签。`, 'ok');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
    btnSave.disabled = false;
  }
});

setInterval(() => { send('poll').catch(() => {}); }, 2000);
refresh().catch((e) => setStatus(e.message, 'err'));
