'use strict';

// Runtime registry of loaded ProviderPacks. A pack is either a single `<name>.json`
// file or a `<name>/pack.json` folder under PROVIDERS_DIR (bind-mounted at /providers).
// server.ts calls loadAll() on startup; the Configuration tab calls savePack/deletePack,
// which only ever touch single-file packs — a folder pack is managed on the host.
//
// Two schema versions are accepted. v1 (`configure.mcpServers` + `configure.skills`) is
// upgraded to v2 in memory, so everything past validatePack sees one shape.

import * as fs from 'fs';
import * as path from 'path';
import { PROVIDERS_DIR } from './config.ts';
import { FRAMEWORKS } from './frameworks.ts';
import { bareMcpClass, qualifyMcpClass } from './mcp-class.ts';
import { secretStatus, type SecretStatus } from './secrets.ts';
import type { FrameworkDef, PackMcpClass, PackMcpServer, PackOrigin, PackSecretDecl, PackSkillSource, ProviderPack } from './types.ts';

const packs = new Map<string, ProviderPack>();

const BUILTIN_FRAMEWORK_IDS = new Set(Object.keys(FRAMEWORKS));

// Which pack owns each external framework id, so two packs can't overwrite each other.
const externalFrameworkOwner = new Map<string, string>();

// A Map, not a plain object: user-supplied framework ids are never property keys
// (CodeQL js/remote-property-injection).
const externalFrameworks = new Map<string, FrameworkDef>();

export const PACK_MANIFEST = 'pack.json';

function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

// Letters/digits/hyphens/underscores, starting with a letter or digit, so names like
// __proto__ are rejected too. Applied to every identifier that becomes a path segment
// or a map key.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GITHUB_REPO = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || FORBIDDEN_KEYS.has(value)) {
    throw new Error(
      `${label} "${value}" contains disallowed characters or is a reserved name — ` +
      'only letters/digits/hyphens/underscores are allowed and the name must start with a letter or digit',
    );
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((a) => typeof a === 'string');
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

const contains = (base: string, abs: string): boolean => {
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// A pack-supplied relative path must stay inside its base: no absolute paths, no `..`
// climb. Lexical only — the caller adds a realpath check where the target exists.
export function assertRelativeInside(rel: string, label: string): void {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error(`${label} must be a non-empty relative path`);
  const cleaned = rel.replace(/\\/g, '/');
  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) {
    throw new Error(`${label} "${rel}" must be relative`);
  }
  if (path.posix.normalize(cleaned).split('/').includes('..')) {
    throw new Error(`${label} "${rel}" must not leave its folder`);
  }
}

/** Resolve a path inside a folder pack, refusing anything (incl. a symlink) that escapes it. */
export function resolvePackPath(pack: ProviderPack, rel: string): string {
  if (!pack.dir) throw new Error(`pack "${pack.name}" is not a folder pack — "${rel}" has nothing to resolve against`);
  assertRelativeInside(rel, `path in pack "${pack.name}"`);
  const base = path.resolve(pack.dir);
  const abs = path.resolve(base, rel.replace(/\\/g, '/'));
  if (!contains(base, abs)) throw new Error(`path "${rel}" escapes pack "${pack.name}"`);
  if (fs.existsSync(abs) && !contains(fs.realpathSync(base), fs.realpathSync(abs))) {
    throw new Error(`path "${rel}" in pack "${pack.name}" resolves outside the pack folder`);
  }
  return abs;
}

function validateFrameworks(list: unknown): ProviderPack['frameworks'] {
  if (!Array.isArray(list) || list.length === 0) throw new Error('frameworks must be a non-empty array');
  const seen = new Set<string>();
  list.forEach((fw: any, i) => {
    if (!fw || typeof fw.id !== 'string') throw new Error(`frameworks[${i}].id is required and must be a string`);
    assertSafeId(fw.id, `frameworks[${i}].id`);
    if (seen.has(fw.id)) throw new Error(`frameworks[${i}].id "${fw.id}" is declared twice`);
    seen.add(fw.id);
    if (!isStr(fw.label)) throw new Error(`frameworks[${i}].label is required`);
    if (!fw.scaffold || typeof fw.scaffold.cmd !== 'string') throw new Error(`frameworks[${i}].scaffold.cmd is required`);
    if (!isStrArray(fw.scaffold.argv)) throw new Error(`frameworks[${i}].scaffold.argv must be an array of strings`);
    validateEnv(fw.scaffold.env, `frameworks[${i}].scaffold.env`);
    if (!fw.dev || typeof fw.dev.cmd !== 'string') throw new Error(`frameworks[${i}].dev.cmd is required`);
    if (!isStrArray(fw.dev.argv)) throw new Error(`frameworks[${i}].dev.argv must be an array of strings`);
    validateEnv(fw.dev.env, `frameworks[${i}].dev.env`);
    // Command lines are logged into history, so a secret may only be passed through env.
    for (const [label, argv] of [['scaffold', fw.scaffold.argv], ['dev', fw.dev.argv]] as const) {
      if (argv.some((a: string) => a.includes('{{secret:'))) {
        throw new Error(`frameworks[${i}].${label}.argv must not reference a secret — pass it through env instead`);
      }
    }
    if (fw.install !== undefined && !isStrArray(fw.install)) throw new Error(`frameworks[${i}].install must be an array of strings`);
    if (fw.prepare !== undefined) {
      if (!isObj(fw.prepare)) throw new Error(`frameworks[${i}].prepare must be an object of { relativePath: contents }`);
      for (const [rel, body] of Object.entries(fw.prepare)) {
        // Keys become paths under the app dir, so they get the same containment rule.
        assertRelativeInside(rel, `frameworks[${i}].prepare key`);
        if (typeof body !== 'string') throw new Error(`frameworks[${i}].prepare["${rel}"] must be a string`);
      }
    }
  });
  return list as ProviderPack['frameworks'];
}

function validateEnv(env: unknown, label: string): void {
  if (env === undefined) return;
  if (!isObj(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    throw new Error(`${label} must be an object of string values`);
  }
}

// Names a secret is exported under in a step's env, so they mustn't clobber the basics.
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH']);

function validateSecrets(list: unknown): PackSecretDecl[] {
  if (!Array.isArray(list)) throw new Error('secrets must be an array');
  const seen = new Set<string>();
  return list.map((s: any, i: number) => {
    const label = `secrets[${i}]`;
    if (!isObj(s) || typeof s.name !== 'string' || !SECRET_NAME.test(s.name)) {
      throw new Error(`${label}.name must be an UPPER_SNAKE_CASE env var name`);
    }
    if (RESERVED_ENV.has(s.name)) throw new Error(`${label}.name "${s.name}" is a reserved env var`);
    if (seen.has(s.name)) throw new Error(`${label}.name "${s.name}" is declared twice`);
    seen.add(s.name);
    for (const k of Object.keys(s)) {
      if (!['name', 'file', 'required', 'description'].includes(k)) throw new Error(`${label}.${k} is not a valid field`);
    }
    if (s.file !== undefined) assertRelativeInside(s.file, `${label}.file`);
    if (s.required !== undefined && typeof s.required !== 'boolean') throw new Error(`${label}.required must be a boolean`);
    if (s.description !== undefined && typeof s.description !== 'string') throw new Error(`${label}.description must be a string`);
    return {
      name: s.name,
      ...(s.file !== undefined ? { file: s.file } : {}),
      ...(s.required !== undefined ? { required: s.required } : {}),
      ...(s.description !== undefined ? { description: s.description } : {}),
    };
  });
}

// Every `{{secret:NAME}}` in a step's env must name a declared secret.
function checkSecretRefs(frameworks: ProviderPack['frameworks'], secrets: PackSecretDecl[]): void {
  const names = new Set(secrets.map((s) => s.name));
  frameworks.forEach((fw, i) => {
    for (const [label, env] of [['scaffold', fw.scaffold.env], ['dev', fw.dev.env]] as const) {
      for (const v of Object.values(env || {})) {
        for (const m of String(v).matchAll(/\{\{secret:([^}]*)\}\}/g)) {
          if (!names.has(m[1])) throw new Error(`frameworks[${i}].${label}.env references undeclared secret "${m[1]}"`);
        }
      }
    }
  });
}

function validateServer(s: any, label: string): void {
  if (!s || typeof s.name !== 'string') throw new Error(`${label}.name is required and must be a string`);
  assertSafeId(s.name, `${label}.name`);
  if (!isStr(s.command)) throw new Error(`${label}.command is required`);
  if (typeof s.class !== 'string') throw new Error(`${label}.class is required and must be a string`);
  assertSafeId(s.class, `${label}.class`);
  if (s.args !== undefined && !isStrArray(s.args)) throw new Error(`${label}.args must be an array of strings when provided`);
}

function validateContainerDeps(cd: unknown): ProviderPack['containerDeps'] {
  if (cd === undefined) return undefined;
  if (!isObj(cd) || (cd.npmGlobal !== undefined && !isStrArray(cd.npmGlobal))) {
    throw new Error('containerDeps.npmGlobal must be an array of strings');
  }
  return cd.npmGlobal ? { npmGlobal: [...cd.npmGlobal] } : {};
}

// A git ref reaches a command line, so: no leading dash (option injection), no `..`,
// nothing outside what branch/tag names and shas use.
const GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;
const SKILL_GLOB = /^[A-Za-z0-9._*-]+$/;

function validateSkillSource(src: any, label: string, origin: PackOrigin): PackSkillSource {
  if (!isObj(src)) throw new Error(`${label} must be an object`);
  const kinds = ['github', 'dir', 'command'].filter((k) => src[k] !== undefined);
  if (kinds.length !== 1) throw new Error(`${label} must have exactly one of "github", "dir" or "command"`);
  const allowed: Record<string, string[]> = {
    github: ['github', 'ref', 'path', 'include'],
    dir: ['dir', 'include'],
    command: ['command'],
  };
  for (const k of Object.keys(src)) {
    if (!allowed[kinds[0]].includes(k)) throw new Error(`${label}.${k} is not valid on a "${kinds[0]}" source`);
  }
  const include = (): Pick<PackSkillSource, 'include'> => {
    if (src.include === undefined) return {};
    if (!isStrArray(src.include) || !src.include.length || !src.include.every((g: string) => SKILL_GLOB.test(g))) {
      throw new Error(`${label}.include must be a non-empty array of skill-name globs (letters, digits, . _ - and *)`);
    }
    return { include: [...src.include] };
  };
  if (kinds[0] === 'github') {
    if (typeof src.github !== 'string' || !GITHUB_REPO.test(src.github)) {
      throw new Error(`${label}.github must be "owner/repo" with only safe characters`);
    }
    if (src.ref !== undefined && (typeof src.ref !== 'string' || !GIT_REF.test(src.ref))) {
      throw new Error(`${label}.ref must be a branch, tag or commit name`);
    }
    if (src.path !== undefined) assertRelativeInside(src.path, `${label}.path`);
    return {
      github: src.github,
      ...(src.ref !== undefined ? { ref: src.ref } : {}),
      ...(src.path !== undefined ? { path: src.path } : {}),
      ...include(),
    };
  }
  if (kinds[0] === 'dir') {
    assertRelativeInside(src.dir, `${label}.dir`);
    // Only a folder pack has somewhere for `dir` to point.
    if (origin !== 'folder') throw new Error(`${label}.dir needs a folder pack (<name>/pack.json)`);
    return { dir: src.dir, ...include() };
  }
  if (!isStrArray(src.command) || !src.command.length) throw new Error(`${label}.command must be a non-empty array of strings`);
  return { command: [...src.command] };
}

function upgradeV1(body: any, origin: PackOrigin): Omit<ProviderPack, 'origin' | 'dir'> {
  if (!isObj(body.configure) || !Array.isArray(body.configure.mcpServers)) {
    throw new Error('configure.mcpServers must be an array');
  }
  const classes: PackMcpClass[] = [];
  const servers: PackMcpServer[] = [];
  body.configure.mcpServers.forEach((s: any, i: number) => {
    const label = `configure.mcpServers[${i}]`;
    validateServer(s, label);
    if (!isStr(s.label)) throw new Error(`${label}.label is required`);
    // v1 toggled by server class and labelled each server; v2 labels the class.
    // Several servers sharing a class collapse into one class with the first label.
    if (!classes.some((c) => c.id === s.class)) {
      classes.push({ id: s.class, label: s.label, ...(isStr(s.description) ? { description: s.description } : {}) });
    }
    servers.push({ name: s.name, class: s.class, command: s.command, ...(s.args ? { args: [...s.args] } : {}) });
  });
  let skills: ProviderPack['skills'];
  const sk = body.configure.skills;
  if (sk !== undefined) {
    if (!isObj(sk) || !isStr(sk.label)) throw new Error('configure.skills.label is required');
    const sources: PackSkillSource[] = [];
    if (sk.github !== undefined) sources.push(validateSkillSource({ github: sk.github }, 'configure.skills', origin));
    else if (sk.installCommand !== undefined) sources.push(validateSkillSource({ command: sk.installCommand }, 'configure.skills', origin));
    skills = { label: sk.label, sources };
  }
  return {
    schemaVersion: 2,
    name: body.name,
    displayName: body.displayName,
    ...(isStr(body.description) ? { description: body.description } : {}),
    ...(isStr(body.version) ? { version: body.version } : {}),
    frameworks: validateFrameworks(body.frameworks),
    mcp: { classes, servers },
    ...(skills ? { skills } : {}),
    ...(body.containerDeps !== undefined ? { containerDeps: validateContainerDeps(body.containerDeps) } : {}),
  };
}

const V2_KEYS = new Set([
  '$schema', 'schemaVersion', 'name', 'displayName', 'description', 'version',
  'frameworks', 'mcp', 'skills', 'secrets', 'containerDeps',
]);

function parseV2(body: any, origin: PackOrigin): Omit<ProviderPack, 'origin' | 'dir'> {
  for (const k of Object.keys(body)) {
    if (!V2_KEYS.has(k)) throw new Error(`unknown field "${k}"`);
  }
  const classes: PackMcpClass[] = [];
  const servers: PackMcpServer[] = [];
  if (body.mcp !== undefined) {
    if (!isObj(body.mcp)) throw new Error('mcp must be an object');
    const rawClasses = body.mcp.classes ?? [];
    const rawServers = body.mcp.servers ?? [];
    if (!Array.isArray(rawClasses)) throw new Error('mcp.classes must be an array');
    if (!Array.isArray(rawServers)) throw new Error('mcp.servers must be an array');
    rawClasses.forEach((c: any, i: number) => {
      if (!c || typeof c.id !== 'string') throw new Error(`mcp.classes[${i}].id is required and must be a string`);
      assertSafeId(c.id, `mcp.classes[${i}].id`);
      if (c.id === 'custom') throw new Error(`mcp.classes[${i}].id "custom" is reserved for pasted MCP servers`);
      if (classes.some((x) => x.id === c.id)) throw new Error(`mcp.classes[${i}].id "${c.id}" is declared twice`);
      if (!isStr(c.label)) throw new Error(`mcp.classes[${i}].label is required`);
      if (c.default !== undefined && typeof c.default !== 'boolean') throw new Error(`mcp.classes[${i}].default must be a boolean`);
      classes.push({
        id: c.id, label: c.label,
        ...(isStr(c.description) ? { description: c.description } : {}),
        ...(c.default !== undefined ? { default: c.default } : {}),
      });
    });
    const names = new Set<string>();
    rawServers.forEach((s: any, i: number) => {
      const label = `mcp.servers[${i}]`;
      validateServer(s, label);
      if (names.has(s.name)) throw new Error(`${label}.name "${s.name}" is declared twice`);
      names.add(s.name);
      if (!classes.some((c) => c.id === s.class)) throw new Error(`${label}.class "${s.class}" is not declared in mcp.classes`);
      servers.push({ name: s.name, class: s.class, command: s.command, ...(s.args ? { args: [...s.args] } : {}) });
    });
  }
  let skills: ProviderPack['skills'];
  if (body.skills !== undefined) {
    if (!isObj(body.skills) || !isStr(body.skills.label)) throw new Error('skills.label is required');
    if (!Array.isArray(body.skills.sources)) throw new Error('skills.sources must be an array');
    skills = {
      label: body.skills.label,
      sources: body.skills.sources.map((s: any, i: number) => validateSkillSource(s, `skills.sources[${i}]`, origin)),
    };
  }
  return {
    schemaVersion: 2,
    name: body.name,
    displayName: body.displayName,
    ...(isStr(body.description) ? { description: body.description } : {}),
    ...(isStr(body.version) ? { version: body.version } : {}),
    frameworks: validateFrameworks(body.frameworks),
    mcp: { classes, servers },
    ...(skills ? { skills } : {}),
    ...(body.secrets !== undefined ? { secrets: validateSecrets(body.secrets) } : {}),
    ...(body.containerDeps !== undefined ? { containerDeps: validateContainerDeps(body.containerDeps) } : {}),
  };
}

export interface PackSource {
  origin?: PackOrigin;
  dir?: string;
}

/** Validate an untrusted pack body (v1 or v2) and return it as a normalized v2 pack,
 * with MCP class ids qualified as `<pack>/<class>`. Throws naming the first problem.
 * Shared by POST /api/providers, loadAll and the matrix config loader. */
export function validatePack(body: any, src: PackSource = {}): ProviderPack {
  if (!isObj(body) || typeof body.name !== 'string' || !body.name.trim()) {
    throw new Error('name is required and must be a non-empty string');
  }
  body = { ...body, name: body.name.trim() };
  assertSafeId(body.name, 'pack name');
  if (!isStr(body.displayName)) throw new Error('displayName is required and must be a non-empty string');

  const origin = src.origin ?? 'inline';
  let parsed: Omit<ProviderPack, 'origin' | 'dir'>;
  if (body.schemaVersion === 2) parsed = parseV2(body, origin);
  else if (body.schemaVersion === undefined || body.schemaVersion === 1) parsed = upgradeV1(body, origin);
  else throw new Error(`unsupported schemaVersion ${JSON.stringify(body.schemaVersion)} (expected 1 or 2)`);

  checkSecretRefs(parsed.frameworks, parsed.secrets || []);
  const q = (c: string) => qualifyMcpClass(parsed.name, c);
  return {
    ...parsed,
    mcp: {
      classes: parsed.mcp.classes.map((c) => ({ ...c, id: q(c.id) })),
      servers: parsed.mcp.servers.map((s) => ({ ...s, class: q(s.class) })),
    },
    origin,
    ...(src.dir ? { dir: path.resolve(src.dir) } : {}),
  };
}

/** The pack as the browser sees it: no container paths, and secret status (set /
 * missing) in place of the declarations. Never a value. */
export function publicPack(p: ProviderPack): Omit<ProviderPack, 'dir' | 'secrets'> & { secrets: SecretStatus[] } {
  const { dir: _dir, secrets: _s, ...rest } = p;
  return { ...rest, secrets: secretStatus(p) };
}

function packFwToDef(fw: ProviderPack['frameworks'][number]): FrameworkDef {
  return {
    scaffold: fw.scaffold,
    install: fw.install,
    configure: 'external',
    aiFramework: fw.id,
    dev: fw.dev,
    prepare: fw.prepare,
  };
}

export function registerPack(pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name');
  // Reserved here too, so a pack dropped straight into /providers can't hijack it.
  if (pack.name === 'igniteui') {
    throw new Error('"igniteui" is reserved for the built-in provider');
  }
  // Validate every framework before mutating anything, so a bad pack can't leave the
  // registry half-registered.
  for (const fw of pack.frameworks) {
    assertSafeId(fw.id, `framework id in pack "${pack.name}"`);
    if (BUILTIN_FRAMEWORK_IDS.has(fw.id)) {
      throw new Error(`framework id "${fw.id}" in pack "${pack.name}" conflicts with a built-in framework id`);
    }
    const owner = externalFrameworkOwner.get(fw.id);
    if (owner && owner !== pack.name) {
      throw new Error(`framework id "${fw.id}" in pack "${pack.name}" is already registered by pack "${owner}"`);
    }
  }
  unregisterPack(pack.name);
  for (const fw of pack.frameworks) {
    externalFrameworkOwner.set(fw.id, pack.name);
    externalFrameworks.set(fw.id, packFwToDef(fw));
  }
  packs.set(pack.name, pack);
}

export function unregisterPack(name: string): void {
  const pack = packs.get(name);
  if (!pack) return;
  for (const fw of pack.frameworks) {
    externalFrameworks.delete(fw.id);
    externalFrameworkOwner.delete(fw.id);
  }
  packs.delete(name);
}

export function getFramework(id: string): FrameworkDef | undefined {
  return FRAMEWORKS[id] ?? externalFrameworks.get(id);
}

export function frameworkIds(): string[] {
  return [...Object.keys(FRAMEWORKS), ...externalFrameworks.keys()];
}

/** Read a pack from a `<name>.json` file or a folder holding `pack.json`. */
export function readPackFrom(p: string): ProviderPack {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const manifest = path.join(abs, PACK_MANIFEST);
    if (!fs.existsSync(manifest)) throw new Error(`folder has no ${PACK_MANIFEST}`);
    const pack = validatePack(JSON.parse(fs.readFileSync(manifest, 'utf8')), { origin: 'folder', dir: abs });
    // The folder name is the pack's identity on disk (deletePack, matrix references),
    // so it must agree with the manifest.
    if (path.basename(abs) !== pack.name) {
      throw new Error(`folder "${path.basename(abs)}" holds pack "${pack.name}" — rename one so they match`);
    }
    return pack;
  }
  return validatePack(JSON.parse(fs.readFileSync(abs, 'utf8')), { origin: 'file' });
}

/** Load every `*.json` file and `<name>/pack.json` folder in PROVIDERS_DIR. */
export function loadAll(): void {
  if (!fs.existsSync(PROVIDERS_DIR)) return;
  const realRoot = fs.realpathSync(PROVIDERS_DIR);
  let loaded = 0;
  for (const e of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(PROVIDERS_DIR, e.name);
    try {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        // A symlinked pack could pull in files from anywhere on the host mount.
        if (!contains(realRoot, fs.realpathSync(full))) throw new Error('symlink points outside the providers folder');
        isDir = fs.statSync(full).isDirectory();
      }
      if (!isDir && !e.name.endsWith('.json')) continue;
      if (isDir && !fs.existsSync(path.join(full, PACK_MANIFEST))) continue;
      const pack = readPackFrom(full);
      const prior = packs.get(pack.name);
      if (prior) throw new Error(`pack "${pack.name}" is already loaded from a ${prior.origin} — skipped`);
      registerPack(pack);
      loaded++;
    } catch (err: any) {
      console.warn(`provider-registry: failed to load ${sanitizeForLog(e.name)}: ${sanitizeForLog(err?.message ?? err)}`);
    }
  }
  if (loaded) console.log(`provider-registry: loaded ${loaded} pack(s) from ${PROVIDERS_DIR}`);
}

/** Persist an uploaded single-file pack as PROVIDERS_DIR/<name>.json and register it.
 * Writes the body as authored, not the normalized form: re-loading normalizes again,
 * and the user's v1 file stays a v1 file. */
export function savePack(raw: unknown, pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name');
  const existing = packs.get(pack.name);
  if (existing?.origin === 'folder') {
    throw new Error(`pack "${pack.name}" is a folder pack — edit ${pack.name}/${PACK_MANIFEST} on the host instead`);
  }
  fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  registerPack({ ...pack, origin: 'file' });
  fs.writeFileSync(path.join(PROVIDERS_DIR, `${pack.name}.json`), JSON.stringify(raw, null, 2));
}

/** Remove a single-file pack from disk and memory. Folder packs are left to the host. */
export function deletePack(name: string): void {
  assertSafeId(name, 'pack name');
  const pack = packs.get(name);
  if (pack?.origin === 'folder') {
    throw new Error(`pack "${name}" is a folder pack — remove the ${name}/ folder on the host instead`);
  }
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

/** Rewrite bare class names to the framework's pack-qualified ids (`angular` →
 * `angular-material/angular`), so a run records the same class the pipeline enables and
 * MCP_CMD_<PACK>_<CLASS> resolves. Built-in frameworks and unknown names pass through. */
export function canonicalMcpClasses(frameworkId: string, classes: string[]): string[] {
  const pack = getPackForFramework(frameworkId);
  if (!pack) return classes.slice();
  return classes.map((c) =>
    pack.mcp.classes.find((k) => bareMcpClass(k.id).toLowerCase() === c.toLowerCase())?.id ?? c);
}
