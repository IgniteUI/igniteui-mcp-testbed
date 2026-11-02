'use strict';

// Runtime registry of loaded ProviderPacks. Built-in packs (Ignite UI) ship in the image
// under BUILTIN_PACKS_DIR and load first; user packs are a single `<name>.json` file or a
// `<name>/pack.json` folder under PROVIDERS_DIR (bind-mounted at /providers).
// server.ts calls loadBuiltins() + loadAll() on startup; the Configuration tab calls
// savePack/deletePack, which only ever touch single-file packs — a folder pack is managed
// on the host, and a built-in one can't be replaced at all.
//
// Two schema versions are accepted. v1 (`configure.mcpServers` + `configure.skills`) is
// upgraded to v2 in memory, so everything past validatePack sees one shape.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PROVIDERS_DIR, MCP_COMMAND_OVERRIDES } from './config.ts';
import { bareMcpClass, normMcpClass, qualifyMcpClass } from './mcp-class.ts';
import { secretStatus, type SecretStatus } from './secrets.ts';
import { packDepsStatus, type PackDepsStatus } from './pack-deps.ts';
import type {
  FrameworkDef, PackConfigureStep, PackMcpClass, PackMcpServer, PackMcpSource, PackOption, PackOrigin,
  PackSecretDecl, PackSkillSource, PackVersionProbe, ProviderPack,
} from './types.ts';

// Packs that ship with the testbed: the repo's packs/ folder (copied to /app/packs in
// the image). Read-only by design — /providers is the read-write mount savePack uses.
export const BUILTIN_PACKS_DIR = process.env.BUILTIN_PACKS_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs');

const packs = new Map<string, ProviderPack>();

// Names of the built-in packs, reserved so a user pack can never take one over.
const builtinNames = new Set<string>();

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

// A pattern goes into a RegExp run over every poll of the dev-server log, so it must
// compile and stay short.
function validateBuildFailed(v: unknown, label: string): void {
  if (v === undefined) return;
  if (!isStrArray(v) || !v.length) throw new Error(`${label} must be a non-empty array of regex strings`);
  for (const src of v) {
    if (!src || src.length > 200) throw new Error(`${label} entries must be 1–200 characters`);
    try { new RegExp(src, 'i'); } catch (e: any) { throw new Error(`${label} "${src}" is not a valid regex (${e.message})`); }
  }
}

const ROUTE_KINDS = ['route-config', 'razor', 'state-nav', 'static'];

function validateRoutes(r: any, label: string): void {
  if (r === undefined) return;
  if (!isObj(r) || !ROUTE_KINDS.includes(r.kind)) throw new Error(`${label}.kind must be one of ${ROUTE_KINDS.join(', ')}`);
  for (const k of Object.keys(r)) {
    if (!['kind', 'fallback', 'paths'].includes(k)) throw new Error(`${label}.${k} is not a valid field`);
  }
  if (r.fallback !== undefined && r.fallback !== 'state-nav') throw new Error(`${label}.fallback must be "state-nav"`);
  if (r.kind === 'static') {
    if (!isStrArray(r.paths) || !r.paths.length || !r.paths.every((p: string) => /^\/[^\s]*$/.test(p))) {
      throw new Error(`${label}.paths must be a non-empty array of paths starting with "/"`);
    }
  } else if (r.paths !== undefined) {
    throw new Error(`${label}.paths is only valid with kind "static"`);
  }
}

function validateScaffold(sc: any, label: string, origin: PackOrigin): void {
  if (!isObj(sc)) throw new Error(`${label} is required`);
  if (sc.kind === 'template') {
    // Only a folder pack has a template folder to copy.
    if (origin !== 'folder') throw new Error(`${label}.kind "template" needs a folder pack (<name>/pack.json)`);
    assertRelativeInside(sc.from, `${label}.from`);
    for (const k of Object.keys(sc)) {
      if (!['kind', 'from', 'env'].includes(k)) throw new Error(`${label}.${k} is not valid on a template scaffold`);
    }
  } else if (sc.kind === undefined || sc.kind === 'command') {
    if (typeof sc.cmd !== 'string') throw new Error(`${label}.cmd is required`);
    if (!isStrArray(sc.argv)) throw new Error(`${label}.argv must be an array of strings`);
    if (sc.argv.some((a: string) => a.includes('{{secret:'))) {
      throw new Error(`${label}.argv must not reference a secret — pass it through env instead`);
    }
  } else {
    throw new Error(`${label}.kind must be "command" or "template"`);
  }
  validateEnv(sc.env, `${label}.env`);
}

function validateFrameworks(list: unknown, origin: PackOrigin): ProviderPack['frameworks'] {
  if (!Array.isArray(list) || list.length === 0) throw new Error('frameworks must be a non-empty array');
  const seen = new Set<string>();
  list.forEach((fw: any, i) => {
    if (!fw || typeof fw.id !== 'string') throw new Error(`frameworks[${i}].id is required and must be a string`);
    assertSafeId(fw.id, `frameworks[${i}].id`);
    if (seen.has(fw.id)) throw new Error(`frameworks[${i}].id "${fw.id}" is declared twice`);
    seen.add(fw.id);
    if (!isStr(fw.label)) throw new Error(`frameworks[${i}].label is required`);
    validateScaffold(fw.scaffold, `frameworks[${i}].scaffold`, origin);
    if (!fw.dev || typeof fw.dev.cmd !== 'string') throw new Error(`frameworks[${i}].dev.cmd is required`);
    if (!isStrArray(fw.dev.argv)) throw new Error(`frameworks[${i}].dev.argv must be an array of strings`);
    validateEnv(fw.dev.env, `frameworks[${i}].dev.env`);
    // Command lines are logged into history, so a secret may only be passed through env.
    if (fw.dev.argv.some((a: string) => a.includes('{{secret:'))) {
      throw new Error(`frameworks[${i}].dev.argv must not reference a secret — pass it through env instead`);
    }
    validateBuildFailed(fw.buildFailed, `frameworks[${i}].buildFailed`);
    validateRoutes(fw.routes, `frameworks[${i}].routes`);
    validateVars(fw.vars, `frameworks[${i}].vars`);
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

// Framework vars become {{name}} placeholders next to the run's own ones.
function validateVars(v: unknown, label: string): void {
  if (v === undefined) return;
  if (!isObj(v)) throw new Error(`${label} must be an object of string values`);
  for (const [k, val] of Object.entries(v)) {
    if (!OPTION_ID.test(k)) throw new Error(`${label}.${k}: names are letters, digits and underscores`);
    if (RESERVED_OPTION_IDS.has(k)) throw new Error(`${label}.${k} is reserved`);
    if (typeof val !== 'string') throw new Error(`${label}.${k} must be a string`);
    for (const m of val.matchAll(/\{\{env:([^}|]*)/g)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1]) || m[1].startsWith('SECRET_')) {
        throw new Error(`${label}.${k} reads env var "${m[1]}", which isn't allowed (secrets go in "secrets")`);
      }
    }
  }
}

function validateConfigure(list: unknown, frameworkIds: string[]): PackConfigureStep[] {
  if (!Array.isArray(list)) throw new Error('configure must be an array of steps');
  return list.map((c: any, i: number) => {
    const label = `configure[${i}]`;
    if (!isObj(c)) throw new Error(`${label} must be an object`);
    for (const k of Object.keys(c)) {
      if (!['cmd', 'argv', 'frameworks'].includes(k)) throw new Error(`${label}.${k} is not a valid field`);
    }
    if (!isStr(c.cmd)) throw new Error(`${label}.cmd is required`);
    if (!isStrArray(c.argv)) throw new Error(`${label}.argv must be an array of strings`);
    if (c.argv.some((a: string) => a.includes('{{secret:'))) throw new Error(`${label}.argv must not reference a secret`);
    if (c.frameworks !== undefined && (!isStrArray(c.frameworks) || !c.frameworks.every((f: string) => frameworkIds.includes(f)))) {
      throw new Error(`${label}.frameworks must list this pack's framework ids`);
    }
    return { cmd: c.cmd, argv: [...c.argv], ...(c.frameworks ? { frameworks: [...c.frameworks] } : {}) };
  });
}

function validateMcpSource(src: any, classIds: string[]): PackMcpSource {
  if (!isObj(src)) throw new Error('mcp.source must be an object');
  for (const k of Object.keys(src)) {
    if (!['files', 'rules'].includes(k)) throw new Error(`mcp.source.${k} is not a valid field`);
  }
  if (!isStrArray(src.files) || !src.files.length) throw new Error('mcp.source.files must be a non-empty array of paths');
  src.files.forEach((f: string, i: number) => assertRelativeInside(f, `mcp.source.files[${i}]`));
  if (!Array.isArray(src.rules)) throw new Error('mcp.source.rules must be an array');
  const rules = src.rules.map((r: any, i: number) => {
    if (!isObj(r) || !isStr(r.match)) throw new Error(`mcp.source.rules[${i}].match is required`);
    if (typeof r.class !== 'string' || !classIds.includes(r.class)) {
      throw new Error(`mcp.source.rules[${i}].class must be one of mcp.classes`);
    }
    return { match: r.match, class: r.class };
  });
  return { files: [...src.files], rules };
}

function validateMcpCommands(cmds: unknown, classIds: string[]): Record<string, string[]> {
  if (!isObj(cmds)) throw new Error('mcp.commands must be an object of { class: argv }');
  const out: Record<string, string[]> = Object.create(null);
  for (const [cls, argv] of Object.entries(cmds)) {
    if (!classIds.includes(cls)) throw new Error(`mcp.commands.${cls} is not one of mcp.classes`);
    if (!isStrArray(argv) || !argv.length) throw new Error(`mcp.commands.${cls} must be a non-empty array of strings`);
    out[cls] = [...argv];
  }
  return out;
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

function validateVersions(list: unknown, frameworkIds: string[]): PackVersionProbe[] {
  if (!Array.isArray(list)) throw new Error('versions must be an array');
  const seen = new Set<string>();
  return list.map((v: any, i: number) => {
    const label = `versions[${i}]`;
    if (!isObj(v) || !isStr(v.name)) throw new Error(`${label}.name is required`);
    if (seen.has(v.name)) throw new Error(`${label}.name "${v.name}" is declared twice`);
    seen.add(v.name);
    if (!isStr(v.cmd)) throw new Error(`${label}.cmd is required`);
    if (!isStrArray(v.argv)) throw new Error(`${label}.argv must be an array of strings`);
    if (v.argv.some((a: string) => a.includes('{{secret:'))) throw new Error(`${label}.argv must not reference a secret`);
    if (v.frameworks !== undefined) {
      if (!isStrArray(v.frameworks) || !v.frameworks.every((f: string) => frameworkIds.includes(f))) {
        throw new Error(`${label}.frameworks must list this pack's framework ids`);
      }
    }
    for (const k of Object.keys(v)) {
      if (!['name', 'cmd', 'argv', 'frameworks'].includes(k)) throw new Error(`${label}.${k} is not a valid field`);
    }
    return { name: v.name, cmd: v.cmd, argv: [...v.argv], ...(v.frameworks ? { frameworks: [...v.frameworks] } : {}) };
  });
}

// {{id}} placeholders are matched by \w+, and these names are the run's own vars.
const OPTION_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_OPTION_IDS = new Set(['name', 'dir', 'port', 'agents']);
const MAX_OPTION_VALUE = 200;

function validateOptions(list: unknown): PackOption[] {
  if (!Array.isArray(list)) throw new Error('options must be an array');
  const seen = new Set<string>();
  return list.map((o: any, i: number) => {
    const label = `options[${i}]`;
    if (!isObj(o) || typeof o.id !== 'string' || !OPTION_ID.test(o.id)) {
      throw new Error(`${label}.id must be letters, digits and underscores, starting with a letter`);
    }
    if (RESERVED_OPTION_IDS.has(o.id)) throw new Error(`${label}.id "${o.id}" is reserved`);
    if (seen.has(o.id)) throw new Error(`${label}.id "${o.id}" is declared twice`);
    seen.add(o.id);
    for (const k of Object.keys(o)) {
      if (!['id', 'label', 'description', 'placeholder', 'choices', 'default'].includes(k)) throw new Error(`${label}.${k} is not a valid field`);
    }
    if (!isStr(o.label)) throw new Error(`${label}.label is required`);
    for (const k of ['description', 'placeholder', 'default']) {
      if (o[k] !== undefined && typeof o[k] !== 'string') throw new Error(`${label}.${k} must be a string`);
    }
    if (o.choices !== undefined) {
      if (!isStrArray(o.choices) || !o.choices.length) throw new Error(`${label}.choices must be a non-empty array of strings`);
      if (o.default !== undefined && !o.choices.includes(o.default)) throw new Error(`${label}.default must be one of its choices`);
    }
    return {
      id: o.id, label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {}),
      ...(o.choices !== undefined ? { choices: [...o.choices] } : {}),
      ...(o.default !== undefined ? { default: o.default } : {}),
    };
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

// A registry package name with an optional version or range — no git/URL/file specs,
// since each one is handed to `npm install` at runtime.
export const NPM_SPEC = /^(?!-)(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._~^<>=*|+-]+)?$/;

function validateContainerDeps(cd: unknown): ProviderPack['containerDeps'] {
  if (cd === undefined) return undefined;
  if (!isObj(cd) || (cd.npmGlobal !== undefined && !isStrArray(cd.npmGlobal))) {
    throw new Error('containerDeps.npmGlobal must be an array of strings');
  }
  for (const spec of cd.npmGlobal || []) {
    if (!NPM_SPEC.test(spec)) throw new Error(`containerDeps.npmGlobal "${spec}" must be a registry package name, optionally @version`);
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

function upgradeV1(body: any, origin: PackOrigin): Omit<ProviderPack, 'origin' | 'dir' | 'hash'> {
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
    frameworks: validateFrameworks(body.frameworks, origin),
    mcp: { classes, servers },
    ...(skills ? { skills } : {}),
    ...(body.containerDeps !== undefined ? { containerDeps: validateContainerDeps(body.containerDeps) } : {}),
  };
}

const V2_KEYS = new Set([
  '$schema', 'schemaVersion', 'name', 'displayName', 'description', 'version',
  'frameworks', 'configure', 'mcp', 'skills', 'options', 'secrets', 'versions', 'containerDeps',
]);

function parseV2(body: any, origin: PackOrigin): Omit<ProviderPack, 'origin' | 'dir' | 'hash'> {
  for (const k of Object.keys(body)) {
    if (!V2_KEYS.has(k)) throw new Error(`unknown field "${k}"`);
  }
  const classes: PackMcpClass[] = [];
  const servers: PackMcpServer[] = [];
  let source: PackMcpSource | undefined;
  let commands: Record<string, string[]> | undefined;
  if (body.mcp !== undefined) {
    if (!isObj(body.mcp)) throw new Error('mcp must be an object');
    for (const k of Object.keys(body.mcp)) {
      if (!['classes', 'servers', 'source', 'commands'].includes(k)) throw new Error(`mcp.${k} is not a valid field`);
    }
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
      const fwIds = (Array.isArray(body.frameworks) ? body.frameworks : []).map((f: any) => f?.id);
      if (c.frameworks !== undefined && (!isStrArray(c.frameworks) || !c.frameworks.length || !c.frameworks.every((f: string) => fwIds.includes(f)))) {
        throw new Error(`mcp.classes[${i}].frameworks must list this pack's framework ids`);
      }
      classes.push({
        id: c.id, label: c.label,
        ...(isStr(c.description) ? { description: c.description } : {}),
        ...(c.default !== undefined ? { default: c.default } : {}),
        ...(c.frameworks !== undefined ? { frameworks: [...c.frameworks] } : {}),
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
    const ids = classes.map((c) => c.id);
    if (body.mcp.source !== undefined) source = validateMcpSource(body.mcp.source, ids);
    if (body.mcp.commands !== undefined) commands = validateMcpCommands(body.mcp.commands, ids);
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
    frameworks: validateFrameworks(body.frameworks, origin),
    mcp: { classes, servers, ...(source ? { source } : {}), ...(commands ? { commands } : {}) },
    ...(body.configure !== undefined
      ? { configure: validateConfigure(body.configure, (body.frameworks || []).map((f: any) => f?.id)) } : {}),
    ...(skills ? { skills } : {}),
    ...(body.options !== undefined ? { options: validateOptions(body.options) } : {}),
    ...(body.secrets !== undefined ? { secrets: validateSecrets(body.secrets) } : {}),
    ...(body.versions !== undefined
      ? { versions: validateVersions(body.versions, (body.frameworks || []).map((f: any) => f?.id)) } : {}),
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
  let parsed: Omit<ProviderPack, 'origin' | 'dir' | 'hash'>;
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
      ...(parsed.mcp.source
        ? { source: { files: parsed.mcp.source.files, rules: parsed.mcp.source.rules.map((r) => ({ ...r, class: q(r.class) })) } }
        : {}),
      ...(parsed.mcp.commands
        ? { commands: Object.fromEntries(Object.entries(parsed.mcp.commands).map(([c, a]) => [q(c), a])) }
        : {}),
    },
    origin,
    hash: src.dir ? hashPackFolder(src.dir) : hashJson(body),
    ...(src.dir ? { dir: path.resolve(src.dir) } : {}),
  };
}

const canonical = (v: any): any =>
  Array.isArray(v) ? v.map(canonical)
    : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;

// Key order and whitespace don't change what a pack does, so they don't change its hash.
export function hashJson(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex').slice(0, 16);
}

// Every file under the pack folder (template, tests and skills included), by relative
// path + content. Dot-entries and node_modules are skipped; symlinks aren't followed.
export function hashPackFolder(dir: string): string {
  const h = crypto.createHash('sha256');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(dir);
  for (const f of files.sort()) {
    h.update(path.relative(dir, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

/** The pack as the browser sees it: no container paths, and secret status (set /
 * missing) in place of the declarations. Never a value. */
export function publicPack(p: ProviderPack): Omit<ProviderPack, 'dir' | 'secrets'> & { secrets: SecretStatus[]; deps: PackDepsStatus } {
  const { dir: _dir, secrets: _s, ...rest } = p;
  return { ...rest, secrets: secretStatus(p), deps: packDepsStatus(p) };
}

// Without `routes`, a pack gets route-config with the state-nav fallback: the fallback
// only runs when route-config finds nothing, so it can't lose a page.
export const DEFAULT_PACK_ROUTES = { kind: 'route-config', fallback: 'state-nav' } as const;

function packFwToDef(fw: ProviderPack['frameworks'][number]): FrameworkDef {
  return {
    scaffold: fw.scaffold,
    install: fw.install,
    vars: fw.vars,
    dev: fw.dev,
    prepare: fw.prepare,
    buildFailed: fw.buildFailed,
    routes: fw.routes ?? { ...DEFAULT_PACK_ROUTES },
  };
}

export function registerPack(pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name');
  // Reserved here too, so a pack dropped straight into /providers can't hijack it.
  if (builtinNames.has(pack.name) && pack.origin !== 'builtin') {
    throw new Error(`"${pack.name}" is reserved for the built-in provider`);
  }
  // Validate every framework before mutating anything, so a bad pack can't leave the
  // registry half-registered.
  for (const fw of pack.frameworks) {
    assertSafeId(fw.id, `framework id in pack "${pack.name}"`);
    const owner = externalFrameworkOwner.get(fw.id);
    if (owner && owner !== pack.name) {
      throw new Error(builtinNames.has(owner)
        ? `framework id "${fw.id}" in pack "${pack.name}" conflicts with a built-in framework id`
        : `framework id "${fw.id}" in pack "${pack.name}" is already registered by pack "${owner}"`);
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
  return externalFrameworks.get(id);
}

export function frameworkIds(): string[] {
  return [...externalFrameworks.keys()];
}

/** Read a pack from a `<name>.json` file or a folder holding `pack.json`. */
export function readPackFrom(p: string, folderOrigin: 'folder' | 'builtin' = 'folder'): ProviderPack {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const manifest = path.join(abs, PACK_MANIFEST);
    if (!fs.existsSync(manifest)) throw new Error(`folder has no ${PACK_MANIFEST}`);
    const pack = validatePack(JSON.parse(fs.readFileSync(manifest, 'utf8')), { origin: folderOrigin, dir: abs });
    // The folder name is the pack's identity on disk (deletePack, matrix references),
    // so it must agree with the manifest.
    if (path.basename(abs) !== pack.name) {
      throw new Error(`folder "${path.basename(abs)}" holds pack "${pack.name}" — rename one so they match`);
    }
    return pack;
  }
  return validatePack(JSON.parse(fs.readFileSync(abs, 'utf8')), { origin: 'file' });
}

/** Load the packs that ship with the testbed. Called before loadAll(), so their names
 * and framework ids are taken before any user pack is read. A broken built-in pack is
 * fatal: without it there is no Ignite UI at all. */
export function loadBuiltins(dir: string = BUILTIN_PACKS_DIR): void {
  if (!fs.existsSync(dir)) throw new Error(`built-in packs folder not found: ${dir}`);
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const pack = readPackFrom(path.join(dir, e.name), 'builtin');
    builtinNames.add(pack.name);
    registerPack(pack);
  }
  warnAmbiguousOverrides();
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
      if (builtinNames.has(pack.name)) throw new Error(`"${pack.name}" is reserved for the built-in provider`);
      const prior = packs.get(pack.name);
      if (prior) throw new Error(`pack "${pack.name}" is already loaded from a ${prior.origin} — skipped`);
      registerPack(pack);
      loaded++;
    } catch (err: any) {
      console.warn(`provider-registry: failed to load ${sanitizeForLog(e.name)}: ${sanitizeForLog(err?.message ?? err)}`);
    }
  }
  if (loaded) console.log(`provider-registry: loaded ${loaded} pack(s) from ${PROVIDERS_DIR}`);
  warnAmbiguousOverrides();
}

/** Persist an uploaded single-file pack as PROVIDERS_DIR/<name>.json and register it.
 * Writes the body as authored, not the normalized form: re-loading normalizes again,
 * and the user's v1 file stays a v1 file. */
export function savePack(raw: unknown, pack: ProviderPack): void {
  assertSafeId(pack.name, 'pack name');
  const existing = packs.get(pack.name);
  if (builtinNames.has(pack.name)) throw new Error(`"${pack.name}" is reserved for the built-in provider`);
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
  if (builtinNames.has(name)) throw new Error('cannot remove the built-in provider');
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

/** Rewrite bare class names to the framework's pack-qualified ids (`igniteui` →
 * `igniteui/igniteui`), so a run records the same class the pipeline enables and
 * MCP_CMD_<PACK>_<CLASS> resolves. `custom` and unknown names pass through. */
export function canonicalMcpClasses(frameworkId: string, classes: string[]): string[] {
  const pack = getPackForFramework(frameworkId);
  if (!pack) return classes.slice();
  return classes.map((c) =>
    pack.mcp.classes.find((k) => bareMcpClass(k.id).toLowerCase() === c.toLowerCase())?.id ?? c);
}

/** The provider (pack name) that owns a framework id, or undefined for an unknown id. */
export function providerFor(frameworkId: string): string | undefined {
  return getPackForFramework(frameworkId)?.name;
}

export function optionsFor(frameworkId: string): PackOption[] {
  return getPackForFramework(frameworkId)?.options || [];
}

/** A run's option values checked against its provider's declarations, with defaults
 * filled in. Values reach argv (never a shell), but they are logged and stored, so they
 * stay short single-line strings. Throws on an undeclared id or an invalid value. */
export function resolveRunOptions(frameworkId: string, raw: unknown): Record<string, string> {
  const decls = optionsFor(frameworkId);
  const given: Record<string, unknown> = raw == null ? {} : (isObj(raw) ? raw : (() => { throw new Error('options must be an object'); })());
  for (const k of Object.keys(given)) {
    if (!decls.some((d) => d.id === k)) throw new Error(`option "${k}" is not declared for framework "${frameworkId}"`);
  }
  const out: Record<string, string> = {};
  for (const d of decls) {
    const v = given[d.id] ?? d.default ?? '';
    if (typeof v !== 'string' || v.length > MAX_OPTION_VALUE || /[\u0000-\u001f\u007f]/.test(v)) {
      throw new Error(`option "${d.id}" must be a single-line string of at most ${MAX_OPTION_VALUE} characters`);
    }
    if (d.choices && v !== '' && !d.choices.includes(v)) throw new Error(`option "${d.id}" must be one of ${d.choices.join(', ')}`);
    out[d.id] = v;
  }
  return out;
}

/** Every provider as the browser sees it: built-in packs first (they load first). */
export function listProvidersForUi(): unknown[] {
  return listPacks().map(publicPack);
}

// ── MCP launch commands ──────────────────────────────────────────────────────
// A server's command comes from, in order: an MCP_CMD_* env override, the pack's
// `mcp.commands` default for its class, or the command as declared/generated.
// The env override for class `<pack>/<cls>` is MCP_CMD_<PACK>_<CLS>; the bare
// MCP_CMD_<CLS> also works while only one loaded pack declares <cls> (so MCP_CMD_IGNITEUI
// keeps meaning Ignite UI's server). A bare class with no pack (`custom`, or a record
// written before classes were qualified) is looked up as-is.

function packsDeclaringBare(bare: string): number {
  const b = bare.toLowerCase();
  return listPacks().filter((p) => p.mcp.classes.some((c) => bareMcpClass(c.id).toLowerCase() === b)).length;
}

function envOverride(cls: string): string[] | undefined {
  const exact = MCP_COMMAND_OVERRIDES[normMcpClass(cls)];
  if (exact) return exact;
  if (!cls.includes('/')) return undefined;
  const bare = bareMcpClass(cls);
  return packsDeclaringBare(bare) === 1 ? MCP_COMMAND_OVERRIDES[normMcpClass(bare)] : undefined;
}

function packDefaultCommand(cls: string): string[] | undefined {
  const pack = cls.includes('/') ? packs.get(cls.slice(0, cls.indexOf('/'))) : undefined;
  return pack?.mcp.commands?.[cls];
}

/** The command a class's servers launch with, or undefined to keep the declared one. */
export function resolveMcpCommand(cls: string | undefined): string[] | undefined {
  if (!cls) return undefined;
  const hit = envOverride(cls) ?? packDefaultCommand(cls);
  return hit ? hit.slice() : undefined;
}

/**
 * The env override for a class as a command line, or undefined when it runs its default.
 * Stamped onto every history record (history.redact) because the A/B arms are otherwise
 * indistinguishable after the fact: the server keeps its name, exposes identically-named
 * tools, and a locally-packed build can report the SAME `--version` as the released one,
 * so the command line is the only thing that says which binary answered.
 */
export function mcpOverrideFor(cls: string | undefined): string | undefined {
  if (!cls) return undefined;
  return envOverride(cls)?.join(' ');
}

/** Folded class → overriding command line, for every class this container overrides,
 * under both the qualified and (when it applies) the bare spelling, so the History
 * re-run check can look up old and new records alike. */
export function mcpOverridesForStatus(): Record<string, string> {
  const out: Record<string, string> = {};
  const classes = [...listPacks().flatMap((p) => p.mcp.classes.map((c) => c.id)), 'custom'];
  for (const cls of classes) {
    const cmd = mcpOverrideFor(cls);
    if (!cmd) continue;
    out[normMcpClass(cls)] = cmd;
    if (cls.includes('/') && packsDeclaringBare(bareMcpClass(cls)) === 1) out[normMcpClass(bareMcpClass(cls))] = cmd;
  }
  return out;
}

// An MCP_CMD_<CLS> that matches the bare class of several packs applies to none of them,
// which would otherwise look exactly like "released" — say so once at startup.
function warnAmbiguousOverrides(): void {
  for (const key of Object.keys(MCP_COMMAND_OVERRIDES)) {
    const owners = listPacks().filter((p) => p.mcp.classes.some((c) => normMcpClass(bareMcpClass(c.id)) === key));
    const qualifiedMatch = listPacks().some((p) => p.mcp.classes.some((c) => normMcpClass(c.id) === key));
    if (owners.length > 1 && !qualifiedMatch) {
      console.warn(`provider-registry: MCP_CMD_${key.toUpperCase()} matches class "${bareMcpClass(owners[0].mcp.classes.find((c) => normMcpClass(bareMcpClass(c.id)) === key)!.id)}" in ${owners.map((o) => o.name).join(', ')} and applies to none — use MCP_CMD_<PACK>_<CLASS>`);
    }
  }
}
