'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Emit } from '../types.ts';

// Remove deselected skill folders (granular skills on/off).
export function pruneSkills(excluded: string[], emit: Emit, appDir: string): void {
  const base = path.join(appDir, '.claude', 'skills');
  if (!fs.existsSync(base)) return;
  for (const name of excluded) {
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      emit('log', `pruned skill: ${name}`);
    }
  }
}
