'use strict';

const path = require('path');

const WIZARD_PORT = Number(process.env.WIZARD_PORT || 8080);
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORK = process.env.WORK_DIR || '/work';
const APP_DIR = path.join(WORK, 'app');
const LOG_DIR = path.join(WORK, 'logs');
// Persistent, cross-container store (second bind mount). Screenshot artifacts live
// under it so they survive container teardown alongside the run records.
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(WORK, 'history');
const ARTIFACT_DIR = path.join(HISTORY_DIR, 'artifacts');

// Matrix-mode tunables.
const MATRIX_MAX_ENTRIES = Number(process.env.MATRIX_MAX_ENTRIES || 24);
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 15 * 60 * 1000);
// How long to wait for the (headless) post-edit dev-server build before giving up
// and screenshotting anyway. Generous because the first build of an agent-edited
// app (esp. Blazor) is slow across the bind mount.
const APP_READY_TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS || 6 * 60 * 1000);

// Put opencode's storage (SQLite + logs) under /work so `opencode stats` and the
// running `opencode web` share one data dir and the usage data survives the
// ephemeral container. opencode honours XDG_DATA_HOME for its storage location.
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(WORK, '.opencode-data');

// Reliable launch commands for the known Ignite UI MCP servers, run from the
// globally-installed packages (see Containerfile) instead of the broken/network
// `npx` invocations ig ai-config writes. Keyed by the wizard's server class.
const MCP_COMMAND_BY_CLASS = {
  igniteui: ['ig', 'mcp'],
  theming: ['igniteui-theming-mcp'],
};

// Which env var carries the API key, keyed by the provider prefix of the model id.
const PROVIDER_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

module.exports = {
  WIZARD_PORT, OPENCODE_PORT, WORK, APP_DIR, LOG_DIR, HISTORY_DIR, ARTIFACT_DIR,
  MATRIX_MAX_ENTRIES, AGENT_TIMEOUT_MS, APP_READY_TIMEOUT_MS,
  MCP_COMMAND_BY_CLASS, PROVIDER_ENV,
};
