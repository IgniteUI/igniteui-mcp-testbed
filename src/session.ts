'use strict';

import * as history from './history.ts';
import { StatsCollector } from './stats.ts';
import { OPENCODE_PORT, WORK } from './config.ts';
import { createSSE } from './stream/sse.ts';
import { createDiagnosticsCollector, type DiagnosticsCollector, type OutputStream } from './capture/diagnostics.ts';
import type { RunConfig, Stats, ToolContext, ToolUsage, Diagnostic } from './types.ts';

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
// Diagnostics for the current interactive session. Unlike a headless entry — which has a
// call frame to hang a collector off and a definite end — an interactive session's
// prompting outlives runPipeline() entirely, so the collector lives here and accrues for
// as long as `opencode web` does.
let diag: DiagnosticsCollector | null = null;
let diagRunId: string | null = null;
// Bumped on every beginRun. The previous collector settles ASYNCHRONOUSLY (its final
// flush and loop read are awaited), so it can still emit after the next run has started —
// and `statsSSE` is shared across runs. History writes stay correct either way because
// each collector's callback closes over its own run id; it is only the broadcast that
// would land on the wrong session's UI.
let diagGeneration = 0;

/**
 * Feed one chunk of `opencode web` output to the session's diagnostics collector.
 *
 * A stable module-level entry point on purpose: the watcher is spawned inside
 * runPipeline, before startStats() would have had a chance to build anything, so the
 * sink has to exist first. `beginRun` creates the collector, which is why the wizard's
 * very first provider error is not lost.
 */
export function feedAgentOutput(stream: OutputStream, chunk: string): void {
  if (diag) diag.onOutput(stream, chunk);
}

/**
 * An output sink bound to the collector that is current *right now*.
 *
 * Watchers outlive the moment they were spawned: `/api/run` calls `beginRun` (installing
 * a new collector) and only then does the pipeline kill the previous watcher, so a dying
 * process's last output would otherwise be attributed to the run that just started. The
 * sink captures its owner and goes quiet once that owner is no longer current, which is
 * the same generation discipline the collector uses internally for its loop poller.
 */
export function agentSink(): { onOutput: (s: OutputStream, c: string) => void; onClose: () => void } {
  const owner = diag;
  return {
    onOutput: (stream, chunk) => { if (owner && owner === diag) owner.onOutput(stream, chunk); },
    // Flushing the OWNER (not whatever is current) is the point: its partial line must
    // not be carried into the next session's collector.
    onClose: () => { if (owner) owner.flushOutput(); },
  };
}

/**
 * The `opencode web` watcher has closed — flush whatever partial line it left behind.
 *
 * Not the same as ending the session: `/api/model` kills and respawns the watcher while
 * the session (and this collector) continue, so the buffer has to be drained at the seam
 * or the two processes' output runs together.
 */
export function flushAgentOutput(): void {
  if (diag) diag.flushOutput();
}

/** The current interactive session's diagnostics (empty when there are none). */
export function getDiagnostics(): Diagnostic[] {
  return diag ? diag.list() : [];
}

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
  // Detector C rides the StatsCollector's existing 30s reconcile tick rather than
  // starting a second timer against the same store. The tick is already the established
  // place where mid-run store reads are safe.
  stats.onTick(() => { if (diag) diag.pollLoop(); });
  stats.setToolContext(toolCtx);
  // The store context arrives with the pipeline hand-off, well after beginRun built the
  // collector — hence setLoopContext rather than a constructor argument. No pollMs: the
  // tick above drives it.
  if (diag && toolCtx) {
    diag.setLoopContext({ dataDir: toolCtx.dataDir, since: toolCtx.since });
  }
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

  // Close the previous session's collector before the new one starts, so a late read can
  // never file the old session's findings under this run's record.
  const previous = diag;
  // Bound to the record id now rather than reading currentRunId when a callback fires,
  // for the same reason startStats does it: the collector outlives its run.
  const runId = currentRunId;
  const generation = ++diagGeneration;
  diagRunId = runId;
  diag = createDiagnosticsCollector({
    onChange: (ds) => {
      // The record write is always correct — `runId` is this collector's own. The
      // broadcast is not: statsSSE is shared, so a superseded collector's final emit
      // would paint the previous session's diagnostics onto the new run's wizard.
      history.updateDiagnostics(runId, ds);
      if (generation === diagGeneration) statsSSE.broadcast({ type: 'diagnostics', diagnostics: ds });
    },
  });
  // Settled only AFTER the new collector is installed and the generation has moved on,
  // so its trailing emit is already superseded by the guard above.
  if (previous) { previous.finish({ exitCode: 0 }).catch(() => {}); }
  // NOTE: Detector B (stall) is deliberately NOT wired for interactive sessions. Its
  // signal is "the agent produced no output for 5 minutes", which for a one-shot headless
  // run means the provider may be wedged — but for an interactive session it is the
  // normal state whenever the user is reading, thinking, or away from the keyboard. It
  // would fire on almost every session and train the user to ignore the warning, which is
  // worse than not having it.
  return currentRunId;
}

export const getRunState = (): RunState => runState;
export const getCurrentRunId = (): string | null => currentRunId;
export const getLastConfig = (): RunConfig | null => lastConfig;
export const getStats = (): StatsCollector | null => stats;
export const getDiagnosticsRunId = (): string | null => diagRunId;
