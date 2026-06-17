'use strict';

import * as fs from 'fs';
import { LOG_DIR } from '../config.ts';

export function ensureDirs(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// rm -rf with a few retries: the bind mount intermittently reports ENOTEMPTY/EBUSY
// while file handles are still being released. force:true already ignores ENOENT.
export async function rmrf(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e: any) {
      if (i >= 4 || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}
