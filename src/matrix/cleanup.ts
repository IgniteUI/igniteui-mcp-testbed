'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { rmrf } from '../proc/fsutil.ts';
import type { Emit } from '../types.ts';

// Heavy/regenerable dirs pruned from a kept matrix entry after its screenshots are
// saved (those live under ARTIFACT_DIR, not appDir, so they're unaffected).
export const CLEANUP_DIRS = ['node_modules', 'dist', '.angular', '.vite'];
const CLEANUP_ENABLED = process.env.MATRIX_CLEANUP !== '0';

// Reclaim disk from a headless entry's project dir. Best-effort + non-fatal.
export async function cleanupAppDir(appDir: string, emit: Emit): Promise<void> {
  if (!CLEANUP_ENABLED) return;
  for (const d of CLEANUP_DIRS) {
    const target = path.join(appDir, d);
    if (!fs.existsSync(target)) continue;
    try { await rmrf(target); emit('log', `cleanup: removed ${d}/`); }
    catch (e: any) { emit('log', `cleanup: could not remove ${d}/ (${e.message})`); }
  }
}
