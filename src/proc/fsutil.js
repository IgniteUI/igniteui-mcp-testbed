'use strict';

const fs = require('fs');
const { LOG_DIR } = require('../config');

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rm -rf with a few retries: the bind mount intermittently reports ENOTEMPTY/EBUSY
// while file handles are still being released. force:true already ignores ENOENT.
async function rmrf(dir) {
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) {
      if (i >= 4 || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}

module.exports = { ensureDirs, sleep, rmrf };
