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

export interface FrameworkDef {
  scaffold: ScaffoldDef;
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
  models: string[];
  customBaseUrl: string | null;
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
  config: StoredConfig;
  stages: { completed: string[]; timings: Record<string, number> };
  stats: Stats | null;
  screenshots: Screenshot[];
  tests: TestResult | null;
  logs: string[];
}

export interface Variant {
  mcps: string[];
  skills: boolean;
  localSkills: boolean;
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
}

export interface MatrixState {
  running: boolean;
  matrixId: string | null;
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
}
