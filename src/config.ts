'use strict';

import * as path from 'path';

export const WIZARD_PORT = Number(process.env.WIZARD_PORT || 8080);
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
export const WORK = process.env.WORK_DIR || '/work';
export const APP_DIR = path.join(WORK, 'app');
export const LOG_DIR = path.join(WORK, 'logs');
// Persistent, cross-container store (second bind mount). Screenshot artifacts live
// under it so they survive container teardown alongside the run records.
export const HISTORY_DIR = process.env.HISTORY_DIR || path.join(WORK, 'history');
export const ARTIFACT_DIR = path.join(HISTORY_DIR, 'artifacts');
// Static per-matrix HTML reports, written when a matrix settles. Under HISTORY_DIR so
// they persist across containers and can link screenshots relatively.
export const REPORTS_DIR = path.join(HISTORY_DIR, 'reports');

// Host-supplied skills, bind-mounted in (see run.sh/run.ps1). Each subfolder is one
// skill (a SKILL.md + resources) overlaid onto the generated .agents/skills/.
export const LOCAL_SKILLS_DIR = process.env.LOCAL_SKILLS_DIR || '/local-skills';

// Host-supplied reference images attached to the agent's prompt (design mockups,
// sketches, screenshots), bind-mounted read-WRITE at /prompt-images so browser uploads
// land in the same host folder a terminal-driven config reads from. Subfolders are
// allowed (a selection entry may name a file or a whole folder).
export const PROMPT_IMAGES_DIR = process.env.PROMPT_IMAGES_DIR || '/prompt-images';
// Per-file upload cap and how many images one run may attach (models reject huge
// image payloads and each image costs tokens, so both are bounded).
export const PROMPT_IMAGE_MAX_BYTES = Number(process.env.PROMPT_IMAGE_MAX_BYTES || 10 * 1024 * 1024);
// `0` is a meaningful setting — attachments off for this container — and is reported to
// the UI, which then disables its picker. Coerced to a non-negative integer so a garbage
// value can't reach the UI as NaN (which it would read as "no cap given" and fall back
// from, while the pipeline silently dropped every image). Unset / empty / unparseable
// falls back to the default rather than to 0, so a typo doesn't quietly turn the feature
// off; a negative clamps to 0, which does.
const rawImageMaxCount = process.env.PROMPT_IMAGE_MAX_COUNT?.trim();
export const PROMPT_IMAGE_MAX_COUNT = rawImageMaxCount && Number.isFinite(Number(rawImageMaxCount))
  ? Math.max(0, Math.trunc(Number(rawImageMaxCount)))
  : 8;

// Provider packs loaded at runtime — persists across container restarts via the
// /providers bind mount (see run.sh / run.ps1).  Each .json file in this dir is
// one ProviderPack describing how to scaffold and configure a 3rd-party library.
export const PROVIDERS_DIR = process.env.PROVIDERS_DIR || '/providers';
// Host-supplied Playwright verification tests, bind-mounted in read-only (see
// run.sh/run.ps1). A run collects TESTS_DIR/shared plus TESTS_DIR/<framework> and runs
// them against the freshly-built app in the post-generation `verify` stage (headless
// mode only). Timeout caps the whole runner; 0/absent tests => the stage is skipped.
export const TESTS_DIR = process.env.TESTS_DIR || '/tests';
export const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 5 * 60 * 1000);

// Matrix-mode tunables.
// Optional JSON config file (bind-mounted; see run.sh/run.ps1 --matrix-config) that
// pre-loads — and by default auto-runs — a matrix without going through the UI.
export const MATRIX_CONFIG = process.env.MATRIX_CONFIG || '';
export const MATRIX_MAX_ENTRIES = Number(process.env.MATRIX_MAX_ENTRIES || 24);
// Cap on the number of passes per matrix submission. Each pass pre-creates
// combos × History records and queues a full sequential matrix run, so an
// unbounded passes array is an easy DoS vector. Override with MATRIX_MAX_PASSES.
export const MATRIX_MAX_PASSES = Number(process.env.MATRIX_MAX_PASSES || 10);
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 25 * 60 * 1000);
// How long to wait for the (headless) post-edit dev-server build before giving up
// and screenshotting anyway. Generous because the first build of an agent-edited
// app (esp. Blazor) is slow across the bind mount.
export const APP_READY_TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS || 6 * 60 * 1000);

// Diagnostics (src/capture/diagnostics.ts).
// Cap on the post-agent `opencode stats` call. It runs on the FAILURE path too, so a
// hung stats command would hang the entry during failure recovery — the worst possible
// place for an unbounded wait.
export const STATS_TIMEOUT_MS = Number(process.env.STATS_TIMEOUT_MS || 60 * 1000);
// Detector B: how long the agent may produce NO output before a `stalled` warning is
// raised. Nothing is killed — this is the honest early signal that replaces inferring a
// rate limit from the 25-minute timeout: it fires at 5 minutes of silence and says the
// provider may be unresponsive, which is true, rather than asserting a 429 nobody saw.
export const AGENT_STALL_MS = Number(process.env.AGENT_STALL_MS || 5 * 60 * 1000);
// Detector C: identical consecutive tool calls (same tool, same canonicalized input)
// before the agent is reported as looping. A warning only — plenty of legitimate work
// is repetitive, so this must never fail a run on its own.
export const AGENT_LOOP_REPEATS = Number(process.env.AGENT_LOOP_REPEATS || 5);
// Temporary scaffolding, not an operational knob: logs per-stream line counters and any
// anchor-matching line WITH its stream tag, so the "which stream do provider errors
// arrive on" question can be answered by a deliberate probe rather than by waiting for
// a real outage. Never logs the agent's output wholesale (it can contain file contents).
export const DIAGNOSTICS_STREAM_DEBUG = process.env.DIAGNOSTICS_STREAM_DEBUG === '1';
// How many consecutive entries must hit the same fatal diagnostic kind before the
// matrix raises an aggregate banner. The matrix is never cancelled automatically.
export const DIAGNOSTIC_AGGREGATE_THRESHOLD = Number(process.env.DIAGNOSTIC_AGGREGATE_THRESHOLD || 2);

// Put opencode's storage (SQLite + logs) under /work so `opencode stats` and the
// running `opencode web` share one data dir and the usage data survives the
// ephemeral container. opencode honours XDG_DATA_HOME for its storage location.
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(WORK, '.opencode-data');
// Where that store ended up. Matrix entries override it per entry (see matrix.ts's
// `dataDir`); an interactive session uses this one, and the tool-usage collector reads
// `<dir>/opencode/opencode.db` out of it (src/capture/tool-usage.ts).
export const OPENCODE_DATA_DIR = process.env.XDG_DATA_HOME as string;

// Reliable launch commands for the known MCP servers, run from globally-installed
// packages (see Containerfile) instead of the `npx` invocations that cold-fetch
// from npm on each run. Keyed by the wizard's server class.
const DEFAULT_MCP_COMMANDS: Record<string, string[]> = {
  igniteui: ['ig', 'mcp'],
  theming: ['igniteui-theming-mcp'],
};

// Swap ANY class's server for a locally-built one (see the ./local-mcp tarball install in
// the Containerfile) — the A/B knob for testing an unreleased MCP server. One var per
// class, the whole command line whitespace-separated:
//   MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp
//   MCP_CMD_THEMING="/opt/local-mcp/bin/my-theming-mcp --stdio"
// It is a prefix scan rather than an allowlist because the class space is open-ended:
// classify() yields theming/angular/igniteui/other, the pipeline adds `custom`, and a
// provider pack declares whatever `class` string it likes — an allowlist would silently
// ignore an override for a pack-supplied server.
// Overriding the *command* rather than injecting a second server keeps the server name
// (and so every tool name the model sees) identical across arms, so the binary is the
// only thing that varies. Unset ⇒ that class's default command.
const MCP_CMD_PREFIX = 'MCP_CMD_';

// Class names may carry characters an env var name cannot (a pack is free to use
// `mui-docs`), so both sides are folded to [a-z0-9_] before matching. Lookups therefore
// go through mcpCommandFor(), never a bare index into the map.
const normClass = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
const splitCmd = (v: string | undefined): string[] => (v || '').trim().split(/\s+/).filter(Boolean);

function collectOverrides(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // Back-compat alias, applied first so an explicit MCP_CMD_IGNITEUI wins over it.
  const legacy = splitCmd(process.env.IGNITEUI_MCP_CMD);
  if (legacy.length) out.igniteui = legacy;
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith(MCP_CMD_PREFIX)) continue;
    const cls = normClass(key.slice(MCP_CMD_PREFIX.length));
    const argv = splitCmd(raw);
    // An empty or whitespace-only value is "not set", not "run nothing" — otherwise a
    // stray `MCP_CMD_IGNITEUI=` in a .env would blank the command and fail the launch.
    if (cls && argv.length) out[cls] = argv;
  }
  return out;
}

/** Normalized class key → argv, for every class whose command came from the env. */
export const MCP_COMMAND_OVERRIDES: Record<string, string[]> = collectOverrides();

/** Defaults with overrides applied. Exported for inspection; resolve via mcpCommandFor. */
export const MCP_COMMAND_BY_CLASS: Record<string, string[]> = (() => {
  const merged: Record<string, string[]> = { ...DEFAULT_MCP_COMMANDS };
  for (const [cls, argv] of Object.entries(MCP_COMMAND_OVERRIDES)) merged[cls] = argv;
  return merged;
})();

const BY_NORM_CLASS: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [cls, argv] of Object.entries(MCP_COMMAND_BY_CLASS)) m[normClass(cls)] = argv;
  return m;
})();

/** The command a class's server should launch with, or undefined to leave it as generated. */
export function mcpCommandFor(cls: string | undefined): string[] | undefined {
  if (!cls) return undefined;
  const hit = BY_NORM_CLASS[normClass(cls)];
  return hit ? hit.slice() : undefined;
}

/**
 * The override for a class as a command line, or undefined when it runs its default.
 * Stamped onto every history record (history.redact) because the A/B arms are otherwise
 * indistinguishable after the fact: the server keeps its name, exposes identically-named
 * tools, and a locally-packed build can report the SAME `--version` as the released one,
 * so the command line is the only thing that says which binary answered.
 */
export function mcpOverrideFor(cls: string | undefined): string | undefined {
  if (!cls) return undefined;
  const hit = MCP_COMMAND_OVERRIDES[normClass(cls)];
  return hit ? hit.join(' ') : undefined;
}

// Which env var carries the API key, keyed by the provider prefix of the model id.
export const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};
