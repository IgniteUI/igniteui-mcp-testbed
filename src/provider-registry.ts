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

// Normalize dynamic values before writing to plain-text logs to prevent log forging.
// Removes CR/LF and other ASCII control characters that could alter log structure.
function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

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

/** Basic structural validation of an untrusted pack body — required fields present
 * and identifiers safe. Shared by the POST /api/providers route and the matrix
 * config-file loader (`providers` field) so both entry points validate identically. */
export function validatePack(body: any): { pack: ProviderPack } | { error: string } {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return { error: 'name is required and must be a non-empty string' };
  }
  if (!SAFE_ID.test(body.name.trim())) {
    return { error: 'name contains disallowed characters — only letters, digits, hyphens and underscores are allowed' };
  }
  if (!body.displayName || typeof body.displayName !== 'string') {
    return { error: 'displayName is required and must be a non-empty string' };
  }
  if (!Array.isArray(body.frameworks) || body.frameworks.length === 0) {
    return { error: 'frameworks must be a non-empty array' };
  }
  for (let i = 0; i < body.frameworks.length; i++) {
    const fw = body.frameworks[i];
    if (!fw || typeof fw.id !== 'string' || !SAFE_ID.test(fw.id)) {
      return { error: `frameworks[${i}].id is missing or contains disallowed characters` };
    }
    if (typeof fw.label !== 'string' || !fw.label.trim()) {
      return { error: `frameworks[${i}].label is required` };
    }
    if (!fw.scaffold || typeof fw.scaffold.cmd !== 'string') {
      return { error: `frameworks[${i}].scaffold.cmd is required` };
    }
    if (!Array.isArray(fw.scaffold.argv) || !fw.scaffold.argv.every((a: any) => typeof a === 'string')) {
      return { error: `frameworks[${i}].scaffold.argv must be an array of strings` };
    }
    if (!fw.dev || typeof fw.dev.cmd !== 'string') {
      return { error: `frameworks[${i}].dev.cmd is required` };
    }
    if (!Array.isArray(fw.dev.argv) || !fw.dev.argv.every((a: any) => typeof a === 'string')) {
      return { error: `frameworks[${i}].dev.argv must be an array of strings` };
    }
  }
  if (!body.configure || !Array.isArray(body.configure.mcpServers)) {
    return { error: 'configure.mcpServers must be an array' };
  }
  for (let i = 0; i < body.configure.mcpServers.length; i++) {
    const s = body.configure.mcpServers[i];
    if (!s || typeof s.name !== 'string' || !SAFE_ID.test(s.name)) {
      return { error: `configure.mcpServers[${i}].name is missing or contains disallowed characters` };
    }
    if (typeof s.command !== 'string' || !s.command.trim()) {
      return { error: `configure.mcpServers[${i}].command is required` };
    }
    if (typeof s.class !== 'string' || !SAFE_ID.test(s.class)) {
      return { error: `configure.mcpServers[${i}].class is missing or contains disallowed characters` };
    }
    if (typeof s.label !== 'string' || !s.label.trim()) {
      return { error: `configure.mcpServers[${i}].label is required` };
    }
    if (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every((a: any) => typeof a === 'string'))) {
      return { error: `configure.mcpServers[${i}].args must be an array of strings when provided` };
    }
  }
  return { pack: body as ProviderPack };
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
      // Sanitize dynamic values before logging to prevent log injection/forgery.
      const safeF = sanitizeForLog(f);
      const safeMsg = sanitizeForLog(e?.message ?? e);
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
