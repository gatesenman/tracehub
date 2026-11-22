'use strict';

async function load() {
  const s = await chrome.storage.local.get({ port: 17862, token: '', profileLabel: '', includeIncognito: false });
  document.getElementById('port').value = s.port;
  document.getElementById('token').value = s.token;
  document.getElementById('profileLabel').value = s.profileLabel;
  document.getElementById('includeIncognito').checked = !!s.includeIncognito;
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Math.max(1024, Math.min(65535, Number(document.getElementById('port').value) || 17862));
  const token = document.getElementById('token').value.trim();
  const profileLabel = document.getElementById('profileLabel').value.trim();
  const includeIncognito = document.getElementById('includeIncognito').checked;
  await chrome.storage.local.set({ port, token, profileLabel, includeIncognito });
  document.getElementById('msg').textContent = '已保存。';
});

load();
