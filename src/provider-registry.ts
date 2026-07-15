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

// Tracks which external pack "owns" each framework id, so two different packs
// cannot silently overwrite each other's frameworks.
const externalFrameworkOwner = new Map<string, string>();

// External frameworks are stored in a Map (not a plain object) so user-supplied
// framework ids are NEVER used as property keys on any plain object.  This avoids
// the CodeQL js/remote-property-injection rule entirely.
const externalFrameworks = new Map<string, FrameworkDef>();

// Safe identifier — only alphanumerics, hyphens, underscores; must start with a
// letter or digit so names like __proto__ (starts with _) are also rejected.
// Applied to pack.name (used in file paths) and fw.id (used as object keys) to
// prevent path-traversal and prototype-pollution attacks from untrusted JSON.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// Explicitly forbidden even if they somehow pass the regex (defence in depth).
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw new Error(
      `${label} "${value}" contains disallowed characters or is a reserved name — ` +
      'only letters/digits/hyphens/underscores are allowed and the name must start with a letter or digit',
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
  // Reserve the built-in provider name at the registry level so a pack dropped
  // directly into /providers (bypassing the HTTP route check) can't hijack it.
  if (pack.name === 'igniteui') {
    throw new Error('"igniteui" is reserved for the built-in provider');
  }
  // Validate all frameworks BEFORE mutating FRAMEWORKS or packs, so a partially
  // valid pack can't leave the registry in a half-registered state.
  for (const fw of pack.frameworks) {
    assertSafeId(fw.id, `framework id in pack "${pack.name}"`);
    if (BUILTIN_FRAMEWORK_IDS.has(fw.id)) {
      throw new Error(
        `framework id "${fw.id}" in pack "${pack.name}" conflicts with a built-in framework id`,
      );
    }
    // Reject cross-pack framework-id collisions (two different packs with the same id).
    const owner = externalFrameworkOwner.get(fw.id);
    if (owner && owner !== pack.name) {
      throw new Error(
        `framework id "${fw.id}" in pack "${pack.name}" is already registered by pack "${owner}"`,
      );
    }
  }
  // Remove stale framework ids from a previous version of this pack before re-adding.
  unregisterPack(pack.name);
  for (const fw of pack.frameworks) {
    externalFrameworkOwner.set(fw.id, pack.name);
    // Store in a Map — user-supplied fw.id is never used as a plain-object property
    // key, which eliminates the CodeQL js/remote-property-injection finding.
    externalFrameworks.set(fw.id, packFwToDef(fw));
  }
  packs.set(pack.name, pack);
}

/** Remove a pack from memory and from the external-frameworks Map. */
export function unregisterPack(name: string): void {
  const pack = packs.get(name);
  if (!pack) return;
  for (const fw of pack.frameworks) {
    externalFrameworks.delete(fw.id);
    externalFrameworkOwner.delete(fw.id);
  }
  packs.delete(name);
}

/** Look up a framework by id — checks built-ins first, then external packs. */
export function getFramework(id: string): FrameworkDef | undefined {
  return FRAMEWORKS[id] ?? externalFrameworks.get(id);
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
      // Sanitize f and e.message before logging — both could contain newlines that
      // would inject fake log entries (CodeQL js/log-injection).
      const safeF = f.replace(/[\r\n]/g, ' ');
      const safeMsg = String(e?.message ?? e).replace(/[\r\n]/g, ' ');
      console.warn(`provider-registry: failed to load ${safeF}: ${safeMsg}`);
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
