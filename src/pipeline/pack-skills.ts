'use strict';

// Installs a provider pack's skills into <app>/.agents/skills/ from its `skills.sources`,
// in order (a later source replaces a same-named skill from an earlier one), and records
// what each source resolved to. The record is the point: a default branch moves and a
// pack folder gets edited, so two runs labelled with the same pack only used the same
// skills if their commits/hashes agree.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { capture } from '../proc/exec.ts';
import { rmrf } from '../proc/fsutil.ts';
import { resolvePackPath } from '../provider-registry.ts';
import type { Emit, PackSkillSource, ProviderPack, SkillSourceRecord } from '../types.ts';

export type RunStepFn = (cmd: string, argv: string[], cwd: string) => Promise<unknown>;

export function describeSkillSource(src: PackSkillSource): string {
  if (src.github) return `github:${src.github}@${src.ref || 'HEAD'}${src.path ? `/${src.path}` : ''}`;
  if (src.dir) return `dir:${src.dir}`;
  return `command:${(src.command || []).join(' ')}`;
}

const globRe = (g: string) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export function matchesInclude(name: string, include?: string[]): boolean {
  return !include || include.some((g) => globRe(g).test(name));
}

const inside = (base: string, abs: string) => {
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// sha256 over every file of the given skill folders: relative path + content, sorted, so
// the same tree hashes the same wherever it was copied.
export function hashSkills(skillsDir: string, names: string[]): string {
  const h = crypto.createHash('sha256');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  for (const n of [...names].sort()) walk(path.join(skillsDir, n));
  for (const f of files.sort()) {
    h.update(path.relative(skillsDir, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// Copy every skill folder (one holding a SKILL.md) under `root` that passes `include`.
export function copySkills(root: string, include: string[] | undefined, skillsDir: string, emit: Emit, rec: SkillSourceRecord): void {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`skills folder not found for ${rec.source}`);
  }
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (!fs.existsSync(path.join(root, e.name, 'SKILL.md'))) continue;
    if (!matchesInclude(e.name, include)) continue;
    const dest = path.join(skillsDir, e.name);
    if (fs.existsSync(dest)) {
      emit('log', `skill "${e.name}" from ${rec.source} replaces an earlier copy`);
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(path.join(root, e.name), dest, { recursive: true });
    rec.skills.push(e.name);
  }
  if (include && !rec.skills.length) emit('log', `warning: no skill in ${rec.source} matches include ${include.join(', ')}`);
  rec.hash = hashSkills(skillsDir, rec.skills);
}

async function fromGithub(src: PackSkillSource, skillsDir: string, emit: Emit, runStep: RunStepFn, rec: SkillSourceRecord): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-clone-'));
  try {
    const repo = src.github as string;
    // Validated as owner/repo at load; re-checked because it reaches a git argument.
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) throw new Error(`invalid skills github value "${repo}"`);
    emit('log', `fetching skills from github.com/${repo} @ ${src.ref || 'HEAD'}`);
    // init + fetch rather than clone --branch, so `ref` may also be a commit sha.
    await runStep('git', ['init', '-q', tmp], tmp);
    await runStep('git', ['-C', tmp, 'fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, src.ref || 'HEAD'], tmp);
    await runStep('git', ['-C', tmp, 'checkout', '-q', 'FETCH_HEAD'], tmp);
    rec.commit = (await capture('git', ['-C', tmp, 'rev-parse', 'HEAD'], tmp)).trim();

    let root: string;
    if (src.path) {
      root = path.resolve(tmp, src.path);
      // `path` is checked lexically at load; the repo itself could still hold a symlink out.
      if (!inside(tmp, root) || (fs.existsSync(root) && !inside(fs.realpathSync(tmp), fs.realpathSync(root)))) {
        throw new Error(`skills path "${src.path}" escapes the repository`);
      }
    } else {
      // Repos that ship more than skills keep them under skills/ (the Agent Skills convention).
      root = fs.existsSync(path.join(tmp, 'skills')) ? path.join(tmp, 'skills') : tmp;
    }
    copySkills(root, src.include, skillsDir, emit, rec);
    emit('log', `installed ${rec.skills.length} skill(s) from github.com/${repo} @ ${rec.commit.slice(0, 12)}`);
  } finally {
    await rmrf(tmp);
  }
}

/** Install every source in order. `records` is filled as it goes, so a caller that
 * catches a failure still has what resolved before it (and the failed source's error). */
export async function installPackSkills(
  pack: ProviderPack, skillsDir: string, emit: Emit, runStep: RunStepFn, records: SkillSourceRecord[],
): Promise<void> {
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const src of pack.skills?.sources || []) {
    const rec: SkillSourceRecord = { source: describeSkillSource(src), skills: [] };
    records.push(rec);
    try {
      if (src.github) {
        await fromGithub(src, skillsDir, emit, runStep, rec);
      } else if (src.dir) {
        copySkills(resolvePackPath(pack, src.dir), src.include, skillsDir, emit, rec);
        emit('log', `installed ${rec.skills.length} skill(s) from pack folder ${src.dir} (${rec.hash})`);
      } else if (src.command?.length) {
        const [cmd, ...args] = src.command;
        emit('log', `installing skills: ${src.command.join(' ')}`);
        const before = new Set(fs.readdirSync(skillsDir));
        await runStep(cmd, args, skillsDir);
        rec.skills = fs.readdirSync(skillsDir).filter((n) => !before.has(n)).sort();
      }
    } catch (e: any) {
      rec.error = String(e?.message ?? e);
      throw e;
    }
  }
}
