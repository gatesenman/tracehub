'use strict';

// Worker thread that reads browser history files. Loading a multi-hundred-MB
// Chrome/Firefox history copy into sql.js is CPU/alloc heavy; doing it here
// keeps the main process responsive no matter how large the profile is.

const { parentPort } = require('worker_threads');
const { readProfileHistory } = require('./browsers');

parentPort.on('message', async (msg) => {
  try {
    const items = await readProfileHistory(msg.browser, msg.profile, msg.since);
    parentPort.postMessage({ id: msg.id, items });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) });
  }
});
