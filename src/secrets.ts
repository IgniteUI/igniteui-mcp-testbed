'use strict';

// Provider-pack secrets (license keys and the like). Two kinds:
//   env   SECRET_<NAME>, forwarded into the container by run.sh/run.ps1. Taken OUT of
//         process.env the moment this module loads, so no child inherits it by default.
//   file  <SECRETS_DIR>/<pack>/<file>, a read-only mount of ./secrets/ on the host.
// Either is handed only to the pack's own scaffold / install / dev-server steps, under
// the secret's name (an env secret's value, a file secret's path), and through
// `{{secret:NAME}}` in those steps' env values. Never in argv: command lines are logged
// into history. Never copied into the app dir, and denied to the agent in opencode.json.
//
// This stops the accidental read and the obvious `cat`, not an agent that goes looking:
// it runs as the same user and could read the dev server's /proc/<pid>/environ.
//
// Dependency-free on purpose and imported first by server.ts, so the scrub runs before
// any other module can copy process.env.

import * as fs from 'fs';
import * as path from 'path';
import type { PackSecretDecl } from './types.ts';

export const SECRET_ENV_PREFIX = 'SECRET_';
export const SECRETS_DIR = process.env.SECRETS_DIR || '/secrets';

// Values shorter than this aren't masked: "true" or "1" would shred every log line.
const MIN_MASK_LEN = 6;
const MAX_SECRET_FILE_BYTES = 64 * 1024;

const masks = new Set<string>();
const addMask = (v: string) => { if (v.length >= MIN_MASK_LEN) masks.add(v); };

const envSecrets = new Map<string, string>();
for (const k of Object.keys(process.env)) {
  if (!k.startsWith(SECRET_ENV_PREFIX)) continue;
  const v = process.env[k];
  delete process.env[k];
  if (v) { envSecrets.set(k.slice(SECRET_ENV_PREFIX.length), v); addMask(v); }
}

// A file secret's contents are masked too, whole and line by line, since a step that
// prints a license file usually prints it a line at a time.
const registeredFiles = new Set<string>();
function registerFileSecret(abs: string): void {
  if (registeredFiles.has(abs)) return;
  registeredFiles.add(abs);
  try {
    if (fs.statSync(abs).size > MAX_SECRET_FILE_BYTES) return;
    const text = fs.readFileSync(abs, 'utf8');
    addMask(text.trim());
    for (const line of text.split(/\r?\n/)) addMask(line.trim());
  } catch { /* unreadable: secretFile already said it is set, the step will fail on it */ }
}


interface PackLike {
  name: string;
  secrets?: PackSecretDecl[];
}

export interface SecretStatus {
  name: string;
  kind: 'env' | 'file';
  required: boolean;
  description?: string;
  set: boolean;
  /** Where to put it — `SECRET_<NAME>` or the host path under ./secrets/. */
  source: string;
}

const inside = (base: string, abs: string) => {
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Lexical containment is checked at pack load; this adds the realpath check, since the
// host folder is the user's and could hold a symlink.
function secretFile(pack: PackLike, s: PackSecretDecl): string | null {
  const base = path.resolve(SECRETS_DIR, pack.name);
  const abs = path.resolve(base, String(s.file).replace(/\\/g, '/'));
  if (!inside(base, abs)) return null;
  try {
    if (!inside(fs.realpathSync(base), fs.realpathSync(abs))) return null;
    const st = fs.statSync(abs);
    return st.isFile() && st.size > 0 ? abs : null;
  } catch {
    return null;
  }
}

export function secretStatus(pack: PackLike): SecretStatus[] {
  return (pack.secrets || []).map((s) => ({
    name: s.name,
    kind: s.file ? 'file' : 'env',
    required: s.required !== false,
    ...(s.description ? { description: s.description } : {}),
    set: s.file ? !!secretFile(pack, s) : envSecrets.has(s.name),
    source: s.file ? `./secrets/${pack.name}/${s.file}` : `${SECRET_ENV_PREFIX}${s.name}`,
  }));
}

export function missingSecrets(pack: PackLike): SecretStatus[] {
  return secretStatus(pack).filter((s) => s.required && !s.set);
}

// name → value (env secret) or absolute path (file secret), for the set ones only.
function resolved(pack: PackLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of pack.secrets || []) {
    const v = s.file ? secretFile(pack, s) : envSecrets.get(s.name);
    if (!v) continue;
    if (s.file) registerFileSecret(v);
    out.set(s.name, v);
  }
  return out;
}

/** The env a pack step gets: every set secret under its own name, plus `extra` with
 * `{{secret:NAME}}` expanded. An unset optional secret referenced in `extra` expands
 * to the empty string. */
export function secretEnv(pack: PackLike | undefined, extra: Record<string, string> = {}): Record<string, string> {
  if (!pack) return { ...extra };
  const vals = resolved(pack);
  const env: Record<string, string> = Object.fromEntries(vals);
  for (const [k, v] of Object.entries(extra)) {
    env[k] = String(v).replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_, n) => vals.get(n) ?? '');
  }
  return env;
}

export function hasMasks(): boolean {
  return masks.size > 0;
}

export function maskSecrets(text: string): string {
  if (!masks.size) return text;
  let out = text;
  // Longest first, so a whole file is masked before its lines are.
  for (const v of [...masks].sort((a, b) => b.length - a.length)) {
    if (out.includes(v)) out = out.split(v).join('***');
  }
  return out;
}

const MAX_PENDING = 64 * 1024;

/** Masks a stream that arrives in arbitrary chunks: output is held back to the last
 * newline, so a secret split across two chunks is masked once whole. Masks never
 * contain a newline (file secrets are also registered line by line). */
export function lineMasker(): { push(chunk: string): string; flush(): string } {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const nl = pending.lastIndexOf('\n');
      if (nl < 0 && pending.length < MAX_PENDING) return '';
      const cut = nl < 0 ? pending.length : nl + 1;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return maskSecrets(ready);
    },
    flush() {
      const rest = pending;
      pending = '';
      return maskSecrets(rest);
    },
  };
}

const maskDeep = (v: any): any =>
  typeof v === 'string' ? maskSecrets(v)
    : Array.isArray(v) ? v.map(maskDeep)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]))
        : v;

/** Wrap an emit so a secret a step happens to print never reaches the log or history. */
export function maskingEmit<T extends (type: string, payload?: any) => void>(emit: T): T {
  // Checked per call: file secrets register only when a step first resolves them.
  return ((type: string, payload?: any) =>
    emit(type, masks.size && (type === 'log' || type === 'error') ? maskDeep(payload) : payload)) as T;
}

/** Test seam: the scrub ran at import, so fixtures set SECRET_* before importing. */
export function envSecretNames(): string[] {
  return [...envSecrets.keys()];
}
