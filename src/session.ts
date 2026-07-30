'use strict';

import * as history from './history.ts';
import { StatsCollector } from './stats.ts';
import { OPENCODE_PORT, WORK } from './config.ts';
import { createSSE } from './stream/sse.ts';
import type { RunConfig, Stats, ToolContext, ToolUsage } from './types.ts';

interface RunState {
  phase: string;
  step: string | null;
  completed: string[];
  logs: string[];
  result: any;
  error: string | null;
}

// SSE registries for the interactive run progress and the live stats feed.
export const runSSE = createSSE();
export const statsSSE = createSSE();

let lastConfig: RunConfig | null = null;   // remembered so /api/model can rebuild opencode.json
let currentRunId: string | null = null;    // history record id for the current/last run
let stats: StatsCollector | null = null;    // live StatsCollector for the current session
// What the tool-usage collector needs to scope a read to this run. The pipeline emits
// it as it hands off to `opencode web`, which is before startStats() runs, so it is
// parked here and applied when the collector is created.
let toolCtx: ToolContext | null = null;

// Progress of the current/last pipeline run, so a wizard that reconnects mid-run
// can re-attach and follow it to completion.
let runState: RunState = { phase: 'idle', step: null, completed: [], logs: [], result: null, error: null };

export function publicRunState(): RunState {
  return {
    phase: runState.phase, step: runState.step,
    completed: runState.completed.slice(),
    logs: runState.logs.slice(-200),
    result: runState.result, error: runState.error,
  };
}

// Update runState from one pipeline event and fan it out to re-attach listeners.
export function recordRun(obj: any): void {
  if (obj.type === 'step') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = obj.step;
    runState.phase = 'running';
  } else if (obj.type === 'log') {
    runState.logs.push(obj.msg);
    if (runState.logs.length > 1000) runState.logs.shift();
  } else if (obj.type === 'error') {
    runState.phase = 'error';
    runState.error = obj.msg;
  } else if (obj.type === 'done') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = null;
    runState.phase = 'done';
    runState.result = obj;
  }
  runSSE.broadcast(obj);
}

export function startStats(cfg: RunConfig): void {
  if (stats) stats.stop();
  // Bind the record id now instead of reading `currentRunId` when a callback fires: a
  // collector outlives its run (stop() flushes asynchronously, and beginRun() moves
  // currentRunId on while the previous collector is still ticking), so a live read
  // writes the old session's numbers into the new run's record.
  const runId = currentRunId;
  stats = new StatsCollector({
    port: OPENCODE_PORT,
    dir: WORK,
    model: cfg.model,
    costAvailable: !cfg.customBaseUrl,
  });
  stats.onUpdate((snap: Stats) => {
    history.updateStats(runId, snap);
    statsSSE.broadcast(snap);
  });
  // Which MCP tools / skills the agent has invoked so far, refreshed on the collector's
  // reconcile tick for as long as the interactive session lives.
  stats.onTools((usage: ToolUsage) => {
    history.updateTools(runId, usage);
    statsSSE.broadcast({ type: 'tools', tools: usage });
  });
  stats.onWarn((msg: string) => console.error(msg));
  stats.setToolContext(toolCtx);
  stats.start();
}

// Record the pipeline's tool-collection context. Called during runPipeline, which is
// always immediately followed by startStats() — so it is only parked here, never pushed
// into `stats`: the only collector live at that moment belongs to the *previous* run,
// and handing it this run's context would file this run's usage under that record.
export function setToolContext(ctx: ToolContext | null): void {
  toolCtx = ctx;
}

// Begin a fresh interactive run: reset progress state, remember the config, and
// open its history record. Returns the new run id.
export function beginRun(cfg: RunConfig): string {
  runState = { phase: 'running', step: null, completed: [], logs: [], result: null, error: null };
  lastConfig = cfg;
  toolCtx = null;
  currentRunId = history.createRecord(cfg);
  return currentRunId;
}

export const getRunState = (): RunState => runState;
export const getCurrentRunId = (): string | null => currentRunId;
export const getLastConfig = (): RunConfig | null => lastConfig;
export const getStats = (): StatsCollector | null => stats;
