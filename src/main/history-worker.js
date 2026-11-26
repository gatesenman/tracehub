'use strict';

// Worker thread that reads browser history files. Loading a multi-hundred-MB
// Chrome/Firefox history snapshot + query can be CPU/alloc heavy; doing it here
// keeps the main process responsive no matter how large the profile is.

const { parentPort } = require('worker_threads');
const { readProfileHistory, readProfileVisits } = require('./browsers');

parentPort.on('message', async (msg) => {
  try {
    if (msg.cursor !== undefined) {
      const page = await readProfileVisits(msg.browser, msg.profile, msg.cursor || {}, msg.options || {});
      parentPort.postMessage({ id: msg.id, page });
    } else {
      const items = await readProfileHistory(msg.browser, msg.profile, msg.since);
      parentPort.postMessage({ id: msg.id, items });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e) });
  }
});
