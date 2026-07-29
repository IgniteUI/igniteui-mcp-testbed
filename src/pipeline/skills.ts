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

// Everything `ig new` / `ig ai-config` can write for the "agents" side of the AI config:
// the skill trees plus the instruction files. `--agents none` covers both (its CLI label
// is literally "None (skip skills and instructions)"), so a skills-off run must be free
// of all of them — AGENTS.md is Ignite UI guidance opencode loads unprompted, which would
// contaminate the baseline just as much as a skill would. `.claude/` goes wholesale: in a
// freshly scaffolded project it exists only because ai-config's `claude` agent put its
// skills + CLAUDE.md there, so removing the children would just leave an empty husk.
const GENERATED_AGENT_CONFIG = [
  ['.agents', 'skills'],
  ['AGENTS.md'],
  ['.claude'],
];

// Belt-and-braces for a skills-off run. The scaffold argv passes --agents=none, but the
// CLI owns that default and has changed it before (see the igNew comment in
// src/frameworks.ts) — and a contaminated "no skills" baseline invalidates every matrix
// comparison against it *silently*. So verify rather than trust, and say what was found.
export function stripGeneratedAgentConfig(appDir: string, emit: Emit): void {
  for (const rel of GENERATED_AGENT_CONFIG) {
    const target = path.join(appDir, ...rel);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    emit('log', `skills off: removed generated ${rel.join('/')}`);
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
