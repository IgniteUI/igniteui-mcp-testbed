'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Emit } from '../types.ts';

// Remove deselected skill folders (granular skills on/off).
export function pruneSkills(excluded: string[], emit: Emit, appDir: string): void {
  const base = path.join(appDir, '.agents', 'skills');
  if (!fs.existsSync(base)) return;
  for (const name of excluded) {
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      emit('log', `pruned skill: ${name}`);
    }
  }
}

// Overlay host-supplied skills (bind-mounted at srcDir) onto .agents/skills/. Each
// subfolder of srcDir is one skill and must contain a SKILL.md; a same-named generated
// skill is replaced. With replaceAll the generated set is wiped first (local-only);
// otherwise local folders merge on top, winning per-name. No-op if srcDir is absent/empty.
export function overlaySkills(
  srcDir: string, appDir: string, emit: Emit, { replaceAll = false }: { replaceAll?: boolean } = {},
): void {
  const base = path.join(appDir, '.agents', 'skills');
  if (replaceAll) {
    fs.rmSync(base, { recursive: true, force: true });
    emit('log', 'cleared generated skills (local-only)');
  }
  fs.mkdirSync(base, { recursive: true });

  if (!fs.existsSync(srcDir)) {
    emit('log', `no local skills dir at ${srcDir}; nothing to overlay`);
    return;
  }
  const names = fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (!names.length) {
    emit('log', `local skills dir ${srcDir} is empty; nothing to overlay`);
    return;
  }
  let applied = 0;
  for (const name of names) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
      emit('log', `warning: local skill "${name}" has no SKILL.md; skipped`);
      continue;
    }
    const dest = path.join(base, name);
    const existed = fs.existsSync(dest);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    emit('log', `${existed ? 'overrode' : 'added'} skill: ${name}`);
    applied++;
  }
  emit('log', `local skills overlaid: ${applied}`);
}
