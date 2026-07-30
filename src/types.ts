'use strict';

// Shared backend domain types — the wire/state contracts that were implicit in JS.

export type Emit = (type: string, payload?: any) => void;

export interface RunConfig {
  framework: string;
  projectType?: string;
  theme?: string;
  enabledMcps?: string[];
  customMcp?: string;
  skills?: boolean;
  excludedSkills?: string[];
  overrideSkills?: boolean;
  localSkillsOnly?: boolean;
  // Which injected test files to run in the verify stage, as `<category>/<file>` keys
  // (category = 'shared' or a framework). undefined ⇒ run all discovered; [] ⇒ run none.
  selectedTests?: string[];
  // Reference images attached to the agent's prompt, as paths relative to
  // PROMPT_IMAGES_DIR (e.g. 'dashboard/home.png'). See src/prompt-images.ts.
  promptImages?: string[];
  model: string;
  apiKey?: string;
  customBaseUrl?: string | null;
}

export interface ScaffoldDef {
  cmd: string;
  argv: string[];
  cwdIsParent?: boolean;
}

export interface DevDef {
  cmd: string;
  argv: string[];
  env?: Record<string, string>;
}

// 'igniteui'  (default) — runs `ig ai-config`, writes .mcp.json + .agents/skills/.
// 'external'            — drives config from a ProviderPack (MCP servers + skills via
//                         git clone); opencode.json is written directly, no translate step.
// 'none'                — skips configure entirely, writes bare opencode.json.
export type ConfigureStrategy = 'igniteui' | 'external' | 'none';

// ── Provider Pack ─────────────────────────────────────────────────────────────
// A JSON file (one per 3rd-party library) that describes how to scaffold, install,
// and configure AI tooling for that library.  Loaded at runtime from PROVIDERS_DIR.

export interface ProviderPackFramework {
  id: string;
  label: string;
  scaffold: ScaffoldDef;
  install?: string[];
  dev: DevDef;
  prepare?: Record<string, string>;
}

export interface ProviderPackMcpServer {
  name: string;
  command: string;
  args?: string[];
  /** Logical class used for enable/disable toggling (e.g. 'igniteui'). */
  class: string;
  label: string;
  description?: string;
}

export interface ProviderPackSkills {
  /** 'owner/repo' on GitHub — cloned with `git clone --depth 1` and skill folders copied. */
  github?: string;
  /** Alternative: run a command directly (e.g. a custom install script). */
  installCommand?: string[];
  /** Human label shown in the wizard skills checkbox. */
  label: string;
}

export interface ProviderPackConfigure {
  mcpServers: ProviderPackMcpServer[];
  skills?: ProviderPackSkills;
}

export interface ProviderPack {
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  frameworks: ProviderPackFramework[];
  configure: ProviderPackConfigure;
  /** npm packages that must be installed globally in the container image. */
  containerDeps?: { npmGlobal?: string[] };
}

export interface FrameworkDef {
  scaffold: ScaffoldDef;
  // npm packages to install into the scaffolded project after scaffold (e.g. @angular/material).
  install?: string[];
  // How to set up AI tooling. Defaults to 'igniteui' when omitted.
  configure?: ConfigureStrategy;
  aiFramework: string;
  dev: DevDef;
  prepare?: Record<string, string>;
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  total: number;
}

export interface CostInfo {
  amount: number;
  currency: string;
  available: boolean;
}

// Union of the StatsCollector snapshot and the parseOpencodeStats result.
export interface Stats {
  updatedAt?: string;
  model?: string | null;
  sessions?: number;
  messages?: { total: number; user?: number; assistant?: number };
  tokens: Tokens;
  cost: CostInfo;
  perModel?: Record<string, { tokens: Tokens; cost: number }>;
  parsed?: boolean;
}

export interface StoredConfig {
  framework: string | null;
  projectType: string;
  theme: string;
  enabledMcps: string[];
  customMcp: boolean;
  skills: boolean;
  excludedSkills: string[];
  overrideSkills: boolean;
  localSkillsOnly: boolean;
  selectedTests: string[];
  promptImages: string[];
  models: string[];
  customBaseUrl: string | null;
}

// One reference image available under PROMPT_IMAGES_DIR. `name` is the path relative
// to that dir (POSIX separators), which is also the id the UI and configs use.
export interface PromptImage {
  name: string;
  size: number;
  mtime: string;
}

export interface Screenshot {
  route: string;
  file: string;
  ok: boolean;
  error?: string;
}

// One failed Playwright test, surfaced in the run log + History detail.
export interface TestFailure {
  title: string;
  file: string;
  error: string;
}

// Outcome of the post-generation Playwright verification stage (headless/matrix only).
// `ran` is whether the runner executed; `ok` is whether every test passed. A run with
// no injected test files never produces a TestResult (the stage is skipped).
export interface TestResult {
  ran: boolean;
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number | null;
  files: string[];
  failures: TestFailure[];
  reportFile?: string | null; // artifact filename (served under /history/artifacts/<id>/)
  error?: string | null;      // harness-level error (runner couldn't execute / parse)
}

// ── Tool usage ────────────────────────────────────────────────────────────────
// What the agent actually reached for during a run. The whole point of the testbed
// is whether the MCP servers and skills we hand the agent get *used*, so this is
// recorded per run alongside tokens/cost. Read from opencode's SQLite store (the
// `part` table's tool parts) — see src/capture/tool-usage.ts.

// One tool, aggregated over the run.
export interface ToolCallStat {
  /** Raw tool name as opencode reports it ('read', 'igniteui-cli_get_doc'). */
  tool: string;
  kind: 'mcp' | 'skill' | 'builtin';
  /** MCP server the tool belongs to; null for skills and built-ins. */
  server: string | null;
  /** Display name: the bare tool for MCP, the skill name for skills, else `tool`. */
  name: string;
  calls: number;
  errors: number;
  /** Summed wall-clock across all calls, when opencode reported start/end. */
  durationMs: number;
}

// One invocation, in order. Capped (TIMELINE_CAP) so a long run can't bloat the record.
export interface ToolEvent {
  at: number; // epoch ms
  tool: string;
  kind: ToolCallStat['kind'];
  name: string;
  ok: boolean;
  ms: number | null;
}

// `configured`/`installed` are what the run was *given*; `used` is what the agent
// actually called. `unused` is the interesting column — an MCP server or skill that
// was wired up but never invoked means the agent never discovered it.
export interface ToolUsageSet {
  configured: string[];
  used: string[];
  unused: string[];
}

export interface ToolUsage {
  /** Which source this was read from — the SQLite store, or the log-line fallback. */
  source: 'db' | 'log';
  /** Total tool invocations, and how many ended in an error state. */
  calls: number;
  errors: number;
  mcpCalls: number;
  skillCalls: number;
  /** Every tool the agent called, most-called first (all three kinds). */
  tools: ToolCallStat[];
  servers: ToolUsageSet;
  skills: ToolUsageSet;
  timeline: ToolEvent[];
  /** Set when the store was found but unreadable / an unrecognized shape. */
  warning?: string;
}

export interface HistoryRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: string;
  error: string | null;
  rating: number | null;
  mode: 'interactive' | 'matrix';
  prompt: string | null;
  matrixId: string | null;
  matrixName?: string | null; // user-set label from the matrix request / config file
  config: StoredConfig;
  stages: { completed: string[]; timings: Record<string, number> };
  stats: Stats | null;
  screenshots: Screenshot[];
  tests: TestResult | null;
  /** MCP tools + skills the agent invoked. null until collected (or if unavailable). */
  tools: ToolUsage | null;
  logs: string[];
}

export interface Variant {
  mcps: string[];
  skills: boolean;
  localSkills: boolean;
}

// The per-matrix constant config applied to every entry (the axes are the combos;
// everything else — model, key, custom MCP, test selection — is fixed across them).
export interface MatrixFixed {
  projectType?: string;
  theme?: string;
  model: string;
  apiKey?: string;
  customBaseUrl?: string;
  customMcp?: string;
  selectedTests?: string[];
  promptImages?: string[];
}

export interface Combo {
  platform: string;
  variant: Variant;
  variantLabel: string;
}

export interface MatrixEntry {
  index: number;
  platform: string;
  variantLabel: string;
  mcps: string[];
  skills: boolean;
  localSkills: boolean;
  status: string;
  runId: string | null;
  logs?: string[];
  step?: string;
  /** MCP tool / skill invocation counts, retained so a reload keeps showing them. */
  mcpCalls?: number;
  skillCalls?: number;
}

export interface MatrixState {
  running: boolean;
  matrixId: string | null;
  name?: string | null;
  total: number;
  done: number;
  entries: MatrixEntry[];
}

export interface SkippedRoute {
  path: string;
  reason: string;
}

export interface RouteDiscovery {
  routes: string[];
  skipped: SkippedRoute[];
  sources?: string[];
  /** True when routes are logical page names discovered from state-based navigation
   * (React useState / conditional rendering) rather than URL router config.
   * Screenshots must be captured via nav-item clicks, not URL navigation. */
  stateNav?: boolean;
}

// Everything src/capture/tool-usage.ts needs to scope a read to one run. The pipeline
// hands this out (PipelineOpts.onToolContext) because only it knows which MCP servers
// ended up enabled and which skills survived the prune/overlay stages.
export interface ToolContext {
  dataDir: string;
  /** Ignore store entries older than this epoch ms (an interactive store is shared). */
  since: number;
  mcpServers: string[];
  skillNames: string[];
}

export interface InteractiveResult {
  appPort: number;
  opencodePort: number;
}

export interface HeadlessResult {
  appPort: number;
  stats: Stats | null;
  screenshots: Screenshot[];
  routes: string[];
  skipped: SkippedRoute[];
  appReady: boolean;
  appError?: string;
  tests?: TestResult | null;
  tools?: ToolUsage | null;
}
