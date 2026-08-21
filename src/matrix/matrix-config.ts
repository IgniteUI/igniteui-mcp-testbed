'use strict';

import * as fs from 'fs';
import { PROVIDER_ENV } from '../config.ts';
import { FRAMEWORKS } from '../frameworks.ts';
import { registerPack, validatePack, getPackForFramework } from '../provider-registry.ts';
import { sharedTests, frameworkTests } from '../verify/tests.ts';
import * as matrix from './matrix.ts';
import { normalizeMatrixRequest, type NormalizedMatrixRequest } from './request.ts';

// A MATRIX_CONFIG file is the POST /api/matrix body as JSON, plus:
//   providers   — array of ProviderPack definitions registered (in-memory) before the
//                 request is normalized, so `platforms` can name their framework ids
//                 and `variants[].mcps` their MCP classes. Unlike a Configuration-tab
//                 upload these are NOT persisted to /providers — the config file is
//                 the source of truth and re-registers them on every startup (a
//                 same-named disk pack is replaced for this container's lifetime).
//   apiKeyEnv   — name of an env var holding the key (instead of a plaintext apiKey);
//                 with neither, the PROVIDER_ENV var for the model's prefix is used.
//   customMcp   — may be an object (stringified here; the pipeline expects a string).
//   images      — reference images attached to the prompt, as paths relative to the
//                 ./prompt-images/ mount; an entry may name a file or a whole subfolder
//                 (expanded at load). Alias of the API's `promptImages`; entries that
//                 match no image warn rather than fail.
//   autoRun     — default true: begin the matrix at startup. false = UI prefill only.
//   exitOnDone  — with autoRun: exit the process when the matrix finishes (0 iff every
//                 entry succeeded), for CI. Default false: keep serving the UI.
export interface LoadedMatrixConfig {
  path: string;
  req: NormalizedMatrixRequest;
  autoRun: boolean;
  exitOnDone: boolean;
  warnings: string[];
}

let loaded: LoadedMatrixConfig | null = null;

export const getLoadedMatrixConfig = (): LoadedMatrixConfig | null => loaded;

// Read + parse + normalize a matrix config file. Throws an Error with a human-readable
// message on unreadable file / invalid JSON / failed validation; the caller decides
// what fail-fast means (server startup exits).
export function loadMatrixConfig(filePath: string): LoadedMatrixConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e: any) {
    throw new Error(`matrix config ${filePath}: cannot read — ${e.message}`);
  }
  let raw: any;
  try {
    // Strip a UTF-8 BOM (Windows-authored files) before parsing.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`matrix config ${filePath}: invalid JSON — ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`matrix config ${filePath}: expected a JSON object`);
  }

  const warnings: string[] = [];

  // Register inline provider packs BEFORE normalizing — `platforms` may name their
  // framework ids. Validation is the same as POST /api/providers; any invalid or
  // conflicting pack is a hard error (fail-fast, like the rest of the file).
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers)) {
      throw new Error(`matrix config ${filePath}: providers must be an array of provider pack objects`);
    }
    for (let i = 0; i < raw.providers.length; i++) {
      try {
        const pack = validatePack(raw.providers[i]);
        registerPack(pack); // in-memory only; rejects 'igniteui' + framework-id collisions
        if (pack.containerDeps?.npmGlobal?.length) {
          warnings.push(
            `provider '${pack.name}' needs global npm package(s) ${pack.containerDeps.npmGlobal.join(', ')} ` +
            'baked into the image (see the Containerfile "3rd-party provider dependencies" section) — ' +
            'scaffold/dev commands may fail without a rebuild');
        }
      } catch (e: any) {
        throw new Error(`matrix config ${filePath}: providers[${i}]: ${e.message}`);
      }
    }
  }

  // Resolve the API key before normalizing: apiKey > apiKeyEnv > provider default var.
  if (!raw.apiKey) {
    const envName = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()
      ? raw.apiKeyEnv.trim()
      : PROVIDER_ENV[String(raw.model || '').split('/')[0]];
    if (raw.apiKeyEnv && !process.env[String(raw.apiKeyEnv).trim()]) {
      warnings.push('configured apiKeyEnv is not set in the environment');
    }
    if (envName && process.env[envName]) raw.apiKey = process.env[envName];
  }

  // customMcp may be authored as an object; downstream expects the JSON string blob.
  if (raw.customMcp !== undefined && raw.customMcp !== null && raw.customMcp !== '') {
    if (typeof raw.customMcp === 'object') {
      raw.customMcp = JSON.stringify(raw.customMcp);
    } else if (typeof raw.customMcp === 'string') {
      try { JSON.parse(raw.customMcp); } catch (e: any) {
        throw new Error(`matrix config ${filePath}: customMcp is not valid JSON — ${e.message}`);
      }
    } else {
      throw new Error(`matrix config ${filePath}: customMcp must be a JSON object or string`);
    }
  }

  const r = normalizeMatrixRequest(raw);
  if (!r.ok) throw new Error(`matrix config ${filePath}: ${r.error}`);
  warnings.push(...r.req.warnings);

  // Warn about variant MCP classes no selected platform's provider declares — an
  // unknown class simply enables nothing at configure time, which headlessly would
  // read as "MCP silently missing". Built-in platforms use the fixed wizard classes;
  // external platforms declare theirs in the pack ('custom' works everywhere).
  const knownClasses = new Set(['custom']);
  for (const p of r.req.platforms) {
    if (FRAMEWORKS[p]) {
      for (const c of ['igniteui', 'theming', 'angular']) knownClasses.add(c);
      continue;
    }
    for (const s of getPackForFramework(p)?.configure?.mcpServers || []) {
      knownClasses.add(s.class.toLowerCase());
    }
  }
  for (const v of r.req.variants) {
    for (const c of v.mcps) {
      if (!knownClasses.has(c.toLowerCase())) {
        warnings.push(`variant MCP class '${c}' is not declared by any selected platform's provider`);
      }
    }
  }

  // selectedTests should name discovered specs (same `<platform>::<category>/<file>`
  // keys the UI combo uses). Unknown keys just match nothing at verify time, so warn
  // rather than fail.
  if (r.req.fixed.selectedTests?.length) {
    const known = new Set<string>();
    try {
      const shared = sharedTests();
      for (const p of r.req.platforms) {
        for (const f of shared) known.add(`${p}::shared/${f}`);
        for (const f of frameworkTests(p)) known.add(`${p}::${p}/${f}`);
      }
    } catch (_) { /* tests dir unreadable — the verify stage will cope */ }
    for (const id of r.req.fixed.selectedTests) {
      if (!known.has(id)) warnings.push(`selectedTests entry '${id}' matches no discovered spec`);
    }
  }

  loaded = {
    path: filePath,
    req: r.req,
    autoRun: raw.autoRun !== false,
    exitOnDone: !!raw.exitOnDone,
    warnings,
  };
  return loaded;
}

// Kick off the loaded config's matrix (the autoRun path). No-op if nothing is loaded
// or a matrix is somehow already running. With exitOnDone, the process exits when the
// matrix settles: 0 iff every entry succeeded, 1 otherwise.
export function startAutoRun(): { matrixId: string; total: number } | null {
  if (!loaded) return null;
  if (matrix.isRunning()) {
    console.log('matrix config: auto-run skipped — a matrix is already running');
    return null;
  }
  const { matrixId, allMatrixIds, total, completion } = matrix.begin(loaded.req.combos, {
    passes: loaded.req.passes,
    fixed: loaded.req.fixed,
  });
  console.log(`matrix config: auto-run started (${matrixId}, ${total} entries × ${loaded.req.passes.length} pass${loaded.req.passes.length === 1 ? '' : 'es'})`);
  if (loaded.exitOnDone) {
    completion.then(() => {
      const entries = matrix.getAllPassEntries();
      const counts: Record<string, number> = {};
      for (const e of entries) counts[e.status] = (counts[e.status] || 0) + 1;
      const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
      // Differentiated exit code for CI: 0 = every entry succeeded; 2 = every entry
      // built but some failed their verification tests; 1 = anything worse
      // (build-error / error / cancelled / interrupted, or nothing ran).
      const statuses = entries.map((e) => e.status);
      const code = statuses.length && statuses.every((s) => s === 'success') ? 0
        : statuses.length && statuses.every((s) => s === 'success' || s === 'test-failed') ? 2
        : 1;
      const summaryPaths = allMatrixIds.map((id) => `./sessions/history/reports/${id}/summary.json`).join(', ');
      console.log(`matrix config: run complete (${summary}) — exiting ${code} (summar${allMatrixIds.length === 1 ? 'y' : 'ies'}: ${summaryPaths})`);
      process.exit(code);
    });
  }
  return { matrixId, total };
}
