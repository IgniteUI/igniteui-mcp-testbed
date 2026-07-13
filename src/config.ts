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

// Host-supplied skills, bind-mounted in (see run.sh/run.ps1). Each subfolder is one
// skill (a SKILL.md + resources) overlaid onto the generated .claude/skills/.
export const LOCAL_SKILLS_DIR = process.env.LOCAL_SKILLS_DIR || '/local-skills';

// Host-supplied Playwright verification tests, bind-mounted in read-only (see
// run.sh/run.ps1). A run collects TESTS_DIR/shared plus TESTS_DIR/<framework> and runs
// them against the freshly-built app in the post-generation `verify` stage (headless
// mode only). Timeout caps the whole runner; 0/absent tests => the stage is skipped.
export const TESTS_DIR = process.env.TESTS_DIR || '/tests';
export const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 5 * 60 * 1000);

// Matrix-mode tunables.
export const MATRIX_MAX_ENTRIES = Number(process.env.MATRIX_MAX_ENTRIES || 24);
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 25 * 60 * 1000);
// How long to wait for the (headless) post-edit dev-server build before giving up
// and screenshotting anyway. Generous because the first build of an agent-edited
// app (esp. Blazor) is slow across the bind mount.
export const APP_READY_TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS || 6 * 60 * 1000);

// Put opencode's storage (SQLite + logs) under /work so `opencode stats` and the
// running `opencode web` share one data dir and the usage data survives the
// ephemeral container. opencode honours XDG_DATA_HOME for its storage location.
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(WORK, '.opencode-data');

// Reliable launch commands for the known Ignite UI MCP servers, run from the
// globally-installed packages (see Containerfile) instead of the broken/network
// `npx` invocations ig ai-config writes. Keyed by the wizard's server class.
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
