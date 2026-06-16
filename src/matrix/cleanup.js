'use strict';

const fs = require('fs');
const path = require('path');
const { rmrf } = require('../proc/fsutil');

// Heavy/regenerable dirs pruned from a kept matrix entry after its screenshots are
// saved (those live under ARTIFACT_DIR, not appDir, so they're unaffected).
const CLEANUP_DIRS = ['node_modules', 'dist', '.angular', '.vite'];
const CLEANUP_ENABLED = process.env.MATRIX_CLEANUP !== '0';

// Reclaim disk from a headless entry's project dir. Best-effort + non-fatal.
async function cleanupAppDir(appDir, emit) {
  if (!CLEANUP_ENABLED) return;
  for (const d of CLEANUP_DIRS) {
    const target = path.join(appDir, d);
    if (!fs.existsSync(target)) continue;
    try { await rmrf(target); emit('log', `cleanup: removed ${d}/`); }
    catch (e) { emit('log', `cleanup: could not remove ${d}/ (${e.message})`); }
  }
}

module.exports = { cleanupAppDir, CLEANUP_DIRS };
