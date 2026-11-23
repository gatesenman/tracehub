'use strict';

function setMessage(text, kind) {
  const el = document.getElementById('msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'hint' + (kind ? ' ' + kind : '');
}

async function load() {
  const s = await chrome.storage.local.get({ port: 17862, token: '', profileLabel: '', includeIncognito: false });
  document.getElementById('port').value = s.port;
  document.getElementById('token').value = s.token;
  document.getElementById('profileLabel').value = s.profileLabel;
  document.getElementById('includeIncognito').checked = !!s.includeIncognito;
  if (s.token) {
    setMessage('正在核对是否已与本机应用配对…');
    const r = await chrome.runtime.sendMessage({ type: 'pair' });
    if (r && r.ok) setMessage(r.message || '已与本机 TraceHub 配对。', 'ok');
    else setMessage('令牌已保存在扩展里，但还没有配对成功：' + ((r && r.error) || '请先打开 TraceHub，再点保存。'), 'warn');
  } else {
    setMessage('请从 TraceHub 设置复制配对令牌，粘贴后点保存。保存时会向本机应用核对，不会假装已经配对。');
  }
}

async function saveAndPair() {
  const port = Math.max(1024, Math.min(65535, Number(document.getElementById('port').value) || 17862));
  const token = document.getElementById('token').value.trim();
  const profileLabel = document.getElementById('profileLabel').value.trim();
  const includeIncognito = document.getElementById('includeIncognito').checked;
  await chrome.storage.local.set({ port, token, profileLabel, includeIncognito });
  if (!token) {
    setMessage('已保存，但还没有令牌，无法配对。请从 TraceHub 设置复制令牌后再保存。', 'warn');
    return { ok: false, code: 'NO_TOKEN' };
  }
  setMessage('正在与本机 TraceHub 核对令牌…');
  const r = await chrome.runtime.sendMessage({ type: 'pair' });
  if (r && r.ok) {
    setMessage(r.message || '已保存，并与本机 TraceHub 配对成功。', 'ok');
  } else {
    setMessage(
      '已写入扩展本机设置，但配对未成功：' +
        ((r && r.error) || '请确认 TraceHub 正在运行，且令牌、端口与设置中一致。') +
        ' 没有配对成功时，不能保存已打开的页签，也不能按布局恢复或关闭。',
      'warn'
    );
  }
  return r || { ok: false };
}

document.getElementById('save').addEventListener('click', () => {
  saveAndPair().catch((e) => setMessage(String(e.message || e), 'err'));
});

load();
