'use strict';

// Runtime registry of loaded ProviderPacks.  Packs are persisted as JSON files
// under PROVIDERS_DIR (bind-mounted at /providers) so they survive container
// restarts.  On startup server.ts calls loadAll(); the wizard calls savePack /
// deletePack in response to user actions in the Configuration tab.

import * as fs from 'fs';
import * as path from 'path';
import { PROVIDERS_DIR } from './config.ts';
import { FRAMEWORKS } from './frameworks.ts';
import type { FrameworkDef, ProviderPack } from './types.ts';

const packs = new Map<string, ProviderPack>();

// Framework ids owned by the built-in IgniteUI provider — never overwriteable.
const BUILTIN_FRAMEWORK_IDS = new Set(Object.keys(FRAMEWORKS));

// Safe identifier — only alphanumerics, hyphens, underscores.
// Applied to pack.name (used in file paths) and fw.id (used as object keys) to
// prevent path-traversal and prototype-pollution attacks from untrusted JSON.
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(
      `${label} "${value}" contains disallowed characters — ` +
      'only letters, digits, hyphens and underscores are allowed',
    );
  }
}

// Convert a ProviderPackFramework into the FrameworkDef that the pipeline expects.
function packFwToDef(fw: ProviderPack['frameworks'][number]): FrameworkDef {
  return {
    scaffold: fw.scaffold,
    install: fw.install,
    configure: 'external',
    // aiFramework is only used by the IgniteUI `ig ai-config --framework` arg.
    // For external providers we use the framework id as a fallback label.
    aiFramework: fw.id,
    dev: fw.dev,
    prepare: fw.prepare,
  };
}

/** Register a pack into the in-memory FRAMEWORKS map. */
export function registerPack(pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name');
  // Remove stale framework ids from a previous version of this pack before re-adding.
  unregisterPack(pack.name);
  for (const fw of pack.frameworks) {
    assertSafeId(fw.id, `framework id in pack "${pack.name}"`);
    if (BUILTIN_FRAMEWORK_IDS.has(fw.id)) {
      throw new Error(
        `framework id "${fw.id}" in pack "${pack.name}" conflicts with a built-in framework id`,
      );
    }
    FRAMEWORKS[fw.id] = packFwToDef(fw);
  }
  packs.set(pack.name, pack);
}

/** Remove a pack from memory and from the FRAMEWORKS map. */
export function unregisterPack(name: string): void {
  const pack = packs.get(name);
  if (!pack) return;
  for (const fw of pack.frameworks) delete FRAMEWORKS[fw.id];
  packs.delete(name);
}

/** Read all *.json files from PROVIDERS_DIR and register them. */
export function loadAll(): void {
  if (!fs.existsSync(PROVIDERS_DIR)) return;
  let loaded = 0;
  for (const f of fs.readdirSync(PROVIDERS_DIR).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(PROVIDERS_DIR, f), 'utf8');
      const pack = JSON.parse(raw) as ProviderPack;
      if (!pack.name || !pack.frameworks?.length) throw new Error('missing required fields');
      registerPack(pack);
      loaded++;
    } catch (e: any) {
      console.warn(`provider-registry: failed to load ${f}: ${e.message}`);
    }
  }
  if (loaded) console.log(`provider-registry: loaded ${loaded} pack(s) from ${PROVIDERS_DIR}`);
}

/** Persist a pack to disk (PROVIDERS_DIR/<name>.json) and register it. */
export function savePack(pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name'); // validate before constructing the file path
  fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROVIDERS_DIR, `${pack.name}.json`), JSON.stringify(pack, null, 2));
  registerPack(pack);
}

/** Remove a pack from disk and memory. */
export function deletePack(name: string): void {
  assertSafeId(name, 'pack name'); // validate before constructing the file path
  unregisterPack(name);
  const f = path.join(PROVIDERS_DIR, `${name}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function listPacks(): ProviderPack[] {
  return [...packs.values()];
}

export function getPack(name: string): ProviderPack | undefined {
  return packs.get(name);
}

export function getPackForFramework(frameworkId: string): ProviderPack | undefined {
  for (const pack of packs.values()) {
    if (pack.frameworks.some((f) => f.id === frameworkId)) return pack;
  }
  return undefined;
}
