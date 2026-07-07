'use strict';

// Shared backend domain types — the wire/state contracts that were implicit in JS.

export type Emit = (type: string, payload?: any) => void;

export interface RunConfig {
  framework: string;
  projectType?: string;
  theme?: string;
  enabledMcps?: string[];
  skills?: boolean;
  excludedSkills?: string[];
  overrideSkills?: boolean;
  localSkillsOnly?: boolean;
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

// 'igniteui' (default) — runs `ig ai-config`, writes .vscode/mcp.json + .claude/skills/.
// 'aggrid'             — writes .vscode/mcp.json with ag-mcp, installs skills via npx.
// 'none'               — skips configure entirely, writes bare opencode.json.
export type ConfigureStrategy = 'igniteui' | 'aggrid' | 'none';

export interface FrameworkDef {
  scaffold: ScaffoldDef;
  // npm packages to install into the scaffolded project after scaffold (e.g. ag-grid-community).
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
  skills: boolean;
  excludedSkills: string[];
  overrideSkills: boolean;
  localSkillsOnly: boolean;
  models: string[];
  customBaseUrl: string | null;
}

export interface Screenshot {
  route: string;
  file: string;
  ok: boolean;
  error?: string;
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
}
