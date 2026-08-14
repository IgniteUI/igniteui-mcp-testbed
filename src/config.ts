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
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 25 * 60 * 1000);
// Text that flags a provider rate limit in opencode's own log
// (<dataDir>/opencode/log/opencode.log) during the headless agent step; matched
// case-insensitively against each fresh line so the entry aborts early instead of
// burning the rest of AGENT_TIMEOUT_MS waiting on a provider that's already refusing
// requests. opencode/provider-wording dependent (like the label regexes in
// src/capture/usage.ts) — override if your provider phrases it differently.
export const RATE_LIMIT_PATTERN = process.env.RATE_LIMIT_PATTERN || 'rate limit exceeded';
// How long to wait for the (headless) post-edit dev-server build before giving up
// and screenshotting anyway. Generous because the first build of an agent-edited
// app (esp. Blazor) is slow across the bind mount.
export const APP_READY_TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS || 6 * 60 * 1000);

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
export const MCP_COMMAND_BY_CLASS: Record<string, string[]> = {
  igniteui: ['ig', 'mcp'],
  theming: ['igniteui-theming-mcp'],
};

// Which env var carries the API key, keyed by the provider prefix of the model id.
export const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};
