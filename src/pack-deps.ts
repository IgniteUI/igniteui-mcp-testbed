'use strict';

// Installs a pack's `containerDeps.npmGlobal` at runtime, into its own prefix under
// PACK_DEPS_DIR. That prefix's bin/ goes on the PATH of that pack's runs only
// (`packPathEnv`): its steps, the dev server, opencode and the MCP servers it launches.
// Never on the wizard's own PATH, or two packs pinning different versions of one CLI
// would both get whichever installed last. Started when the pack loads, awaited before the pack's first run step, so a
// failed install fails the run up front instead of as a mid-run `command not found`.
//
// Trade-off (decided in docs/plan-provider-packs.md): runs need npm reachable, and an
// unpinned dep can drift between containers. Installed versions are therefore recorded
// in each run's `config.toolVersions` (as `npm:<package>`).

import * as fs from 'fs';
import * as path from 'path';
import { capture } from './proc/exec.ts';
import type { ProviderPack } from './types.ts';

export const PACK_DEPS_DIR = process.env.PACK_DEPS_DIR || '/opt/pack-deps';
const INSTALL_TIMEOUT_MS = Number(process.env.PACK_DEPS_TIMEOUT_MS || 5 * 60_000);

export interface PackDepsStatus {
  /** pending = declared but not started yet (e.g. a pack being validated). */
  state: 'none' | 'pending' | 'installing' | 'ok' | 'failed';
  error?: string;
  /** package → installed version */
  versions?: Record<string, string>;
}

interface Job {
  key: string;
  status: PackDepsStatus;
  promise: Promise<Record<string, string>>;
}

const jobs = new Map<string, Job>();

const depsOf = (pack: ProviderPack): string[] => pack.containerDeps?.npmGlobal || [];

export function packDepsDir(packName: string): string {
  return path.join(PACK_DEPS_DIR, packName);
}

/** PATH for a child of one of this pack's runs; empty when the pack has no deps. */
export function packPathEnv(pack: ProviderPack | undefined): Record<string, string> {
  if (!pack || !depsOf(pack).length) return {};
  const bin = path.join(packDepsDir(pack.name), 'bin');
  return { PATH: [bin, process.env.PATH || ''].filter(Boolean).join(path.delimiter) };
}

async function installedVersions(prefix: string): Promise<Record<string, string>> {
  try {
    const out = await capture('npm', ['ls', '-g', '--prefix', prefix, '--depth=0', '--json'], prefix, null, 60_000);
    const deps = JSON.parse(out).dependencies || {};
    return Object.fromEntries(Object.entries<any>(deps).map(([name, d]) => [name, String(d?.version || '?')]));
  } catch {
    return {};
  }
}

/** Install (once per pack content) and resolve to package → version. Repeated calls for
 * the same pack share one install; a changed pack (new hash) installs again. */
export function ensurePackDeps(pack: ProviderPack): Promise<Record<string, string>> {
  const deps = depsOf(pack);
  if (!deps.length) return Promise.resolve({});
  const key = `${pack.hash}|${deps.join(' ')}`;
  const prior = jobs.get(pack.name);
  if (prior && prior.key === key && prior.status.state !== 'failed') return prior.promise;

  const prefix = packDepsDir(pack.name);
  const status: PackDepsStatus = { state: 'installing' };
  const promise = (async () => {
    try {
      fs.mkdirSync(prefix, { recursive: true });
      await capture('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', ...deps], prefix, null, INSTALL_TIMEOUT_MS);
      status.versions = await installedVersions(prefix);
      status.state = 'ok';
      return status.versions;
    } catch (e: any) {
      status.state = 'failed';
      status.error = String(e?.message ?? e).split('\n').slice(-3).join(' ').slice(0, 400);
      throw new Error(`could not install ${deps.join(', ')} for pack "${pack.name}": ${status.error}`);
    }
  })();
  // Nobody may be awaiting yet (it starts at load); don't let that be an unhandled rejection.
  promise.catch(() => {});
  jobs.set(pack.name, { key, status, promise });
  return promise;
}

/** Start the install in the background and log how it ends. */
export function startPackDeps(pack: ProviderPack): void {
  // Validate-only runs report and exit; they must not start installing.
  if (!depsOf(pack).length || process.env.MATRIX_VALIDATE === '1' || process.env.PACK_VALIDATE) return;
  ensurePackDeps(pack).then(
    (v) => console.log(`pack-deps: ${pack.name} ready (${Object.entries(v).map(([k, x]) => `${k}@${x}`).join(', ') || 'installed'})`),
    (e) => console.warn(`pack-deps: ${e.message}`),
  );
}

export function packDepsStatus(pack: ProviderPack): PackDepsStatus {
  if (!depsOf(pack).length) return { state: 'none' };
  return jobs.get(pack.name)?.status ?? { state: 'pending' };
}
