'use strict';

import * as path from 'path';
import type { ChildProcess } from 'child_process';
import * as history from '../history.ts';
import { WORK, ARTIFACT_DIR } from '../config.ts';
import { killTree } from '../proc/exec.ts';
import { killWatcher } from '../proc/watcher.ts';
import { createSSE } from '../stream/sse.ts';
import { cleanupAppDir } from './cleanup.ts';
import { entryDirName, newMatrixId } from './variants.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { Combo, MatrixEntry, MatrixState, RunConfig } from '../types.ts';

interface Fixed {
  projectType?: string;
  theme?: string;
  model: string;
  apiKey?: string;
  customBaseUrl?: string;
  customMcp?: string;
  skipTests?: boolean;
}

// Run the same prompt across platform × variant as one-shot headless runs. Sequential
// (the app + opencode bind fixed ports, so only one entry can be live at a time).
export const sse = createSSE();
const broadcast = (obj: any) => sse.broadcast(obj);

let matrixRunning = false;
let matrixCancelled = false;
let currentChild: ChildProcess | null = null; // the in-flight pipeline child (scaffold/agent/…), for cancellation
let matrixState: MatrixState = { running: false, matrixId: null, total: 0, done: 0, entries: [] };
// runIds individually cancelled from the History tab — a per-entry cancel that
// (unlike the whole-matrix `cancel()`) only aborts that one entry and lets the rest run.
const cancelledEntries = new Set<string>();

function buildCfg(c: Combo, fixed: Fixed): RunConfig {
  // {skills, localSkills} → the three pipeline flags. localSkills without skills means
  // local-only (wipe the generated set); with skills it merges (local overlaid on top).
  return {
    framework: c.platform,
    projectType: fixed.projectType || '',
    theme: fixed.theme || '',
    enabledMcps: c.variant.mcps,
    customMcp: fixed.customMcp,
    skills: !!c.variant.skills,
    excludedSkills: [],
    overrideSkills: !!c.variant.localSkills,
    localSkillsOnly: !!c.variant.localSkills && !c.variant.skills,
    skipTests: !!fixed.skipTests,
    model: fixed.model,
    apiKey: fixed.apiKey,
    customBaseUrl: fixed.customBaseUrl || undefined,
  };
}

// Heartbeat lines ("… opencode still running (Ns)") are pure liveness — collapse
// consecutive ones into a single updating line so they don't flood out real logs.
const HEARTBEAT_RE = /still running \(\d+s\)/;
const ENTRY_LOG_CAP = 800;

// Append a streamed line to an entry's retained log buffer (so reconnecting clients
// and the History record can replay it; the live SSE alone is lost on disconnect).
function pushEntryLog(entry: MatrixEntry, line: string): void {
  const logs = entry.logs ?? (entry.logs = []);
  if (HEARTBEAT_RE.test(line) && logs.length && HEARTBEAT_RE.test(logs[logs.length - 1])) {
    logs[logs.length - 1] = line;
  } else {
    logs.push(line);
    if (logs.length > ENTRY_LOG_CAP) logs.shift();
  }
}

async function runMatrix(combos: Combo[], { prompt, matrixId, fixed }: { prompt: string; matrixId: string; fixed: Fixed }): Promise<void> {
  broadcast({ type: 'matrix-start', matrixId, total: combos.length, entries: matrixState.entries });
  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    const entry = matrixState.entries[i];
    const runId = entry.runId as string; // history record created up-front in begin()

    if (matrixCancelled) {
      // Whole-matrix cancel: settle this + every remaining entry and stop.
      for (let j = i; j < combos.length; j++) {
        const e = matrixState.entries[j];
        if (e.runId && (e.status === 'pending' || e.status === 'running')) {
          e.status = 'cancelled';
          history.finish(e.runId, { status: 'cancelled', error: 'cancelled' });
          broadcast({ type: 'entry-done', index: j, status: 'cancelled', runId: e.runId });
        }
      }
      break;
    }
    // Per-entry cancel of a still-queued entry: skip it without running.
    if (cancelledEntries.has(runId)) {
      entry.status = 'cancelled';
      history.finish(runId, { status: 'cancelled', error: 'cancelled' });
      broadcast({ type: 'entry-done', index: i, status: 'cancelled', runId });
      matrixState.done = i + 1;
      continue;
    }

    entry.status = 'running';
    history.markRunning(runId);
    const cfg = buildCfg(c, fixed);
    broadcast({ type: 'entry-start', index: i, platform: c.platform, variantLabel: c.variantLabel, runId });

    // Per-entry stage timings + completed list, surfaced through the matrix SSE.
    const timings: Record<string, number> = {};
    const completed: string[] = [];
    let stepName: string | null = null, stepStart = 0;
    const markStep = (name: string) => {
      const now = Date.now();
      if (stepName) { timings[stepName] = now - stepStart; completed.push(stepName); }
      stepName = name; stepStart = now;
      entry.step = name; // retained so a reconnect/reload can restore the step label
    };
    const closeStep = () => {
      if (stepName) { timings[stepName] = Date.now() - stepStart; completed.push(stepName); stepName = null; }
    };
    const emit = (type: string, payload?: any) => {
      const obj = typeof payload === 'string' ? { type, msg: payload } : { type, ...payload };
      if (type === 'step') { markStep(obj.step); pushEntryLog(entry, `— ${obj.step} —`); }
      else if (type === 'log') pushEntryLog(entry, obj.msg);
      else if (type === 'error') pushEntryLog(entry, 'ERROR: ' + obj.msg);
      broadcast({ ...obj, index: i });
    };

    // Each entry gets its own project dir (and opencode data dir) so a previous
    // entry's still-dying dev server can't make this one's cleanup throw ENOTEMPTY.
    const entryDir = path.join(WORK, 'matrix', matrixId, entryDirName(i, c.platform, c.variant));
    const appDir = path.join(entryDir, 'app');
    const dataDir = path.join(entryDir, '.opencode-data');
    const artifactDir = path.join(ARTIFACT_DIR, runId);
    // Track the current child so Cancel can kill it. If cancellation already
    // arrived between steps, kill this one immediately so the pipeline aborts now
    // instead of running the step (e.g. don't start the agent after Cancel).
    const onChild = (child: ChildProcess) => {
      currentChild = child;
      if (matrixCancelled || cancelledEntries.has(runId)) killTree(child, 'SIGTERM');
    };
    try {
      const result = await runPipeline(cfg, { emit, headless: true, prompt, dataDir, artifactDir, onChild, appDir });
      closeStep();
      if (result.stats) history.updateStats(runId, result.stats);
      // The agent ran fine but the edited app may not compile — flag that distinctly
      // from a clean success so "0 shots" isn't mistaken for "app had no routes". A
      // built app whose injected Playwright tests fail becomes 'test-failed'.
      const cancelled = matrixCancelled || cancelledEntries.has(runId);
      const tests = result.tests || null;
      const status = cancelled ? 'cancelled'
        : result.appReady === false ? 'build-error'
        : (tests && !tests.ok) ? 'test-failed'
        : 'success';
      const outcomeErr = status === 'build-error' ? (result.appError || 'app build failed')
        : status === 'test-failed' ? (tests?.error || `${tests?.failed} test(s) failed`)
        : null;
      history.finish(runId, { status, error: outcomeErr, completed, timings, screenshots: result.screenshots || [], tests, logs: entry.logs || [] });
      entry.status = status;
      // Retain the summary label so a reload shows the outcome, not the last live step.
      if (status === 'success') {
        const shots = `${(result.screenshots || []).filter((s) => s.ok).length} shots`;
        entry.step = tests && tests.ran ? `${shots} · ${tests.passed}/${tests.total} tests` : shots;
      } else if (status === 'build-error') entry.step = 'build failed';
      else if (status === 'test-failed') entry.step = tests ? `tests failed (${tests.failed}/${tests.total})` : 'tests failed';
      broadcast({
        type: 'entry-done', index: i, status, runId,
        screenshots: result.screenshots || [], stats: result.stats || null, tests, error: outcomeErr,
      });
    } catch (err: any) {
      closeStep();
      // runPipeline threw (cancel / timeout / error) before its own cleanup stage —
      // free any watcher and reclaim disk here so the kept entry dir isn't left heavy.
      await killWatcher('app'); await killWatcher('opencode');
      try { await cleanupAppDir(appDir, emit); } catch (_) {}
      const cancelled = matrixCancelled || cancelledEntries.has(runId);
      const status = cancelled ? 'cancelled' : 'error';
      history.finish(runId, { status, error: cancelled ? 'cancelled' : err.message, completed, timings, logs: entry.logs || [] });
      entry.status = status;
      broadcast({ type: 'entry-done', index: i, status, runId, error: status === 'error' ? err.message : null });
    } finally {
      currentChild = null;
    }
    matrixState.done = i + 1;
  }
  killWatcher('app'); killWatcher('opencode');
  matrixState.running = false;
  matrixRunning = false;
  broadcast({ type: 'matrix-done', matrixId, total: combos.length, cancelled: matrixCancelled });
}

// Set up state for a (validated, already-capped) set of combos and kick off the run
// in the background. Returns { matrixId, total }; the caller responds immediately and
// the client follows progress via the matrix SSE stream.
export function begin(combos: Combo[], { prompt, fixed }: { prompt: string; fixed: Fixed }): { matrixId: string; total: number } {
  const matrixId = newMatrixId();
  matrixRunning = true;
  matrixCancelled = false;
  cancelledEntries.clear();
  matrixState = {
    running: true, matrixId, total: combos.length, done: 0,
    // Create every entry's history record up-front (status 'pending') so the whole
    // matrix shows in History the moment it's submitted, not one row at a time.
    entries: combos.map((c, i) => ({
      index: i, platform: c.platform, variantLabel: c.variantLabel,
      mcps: c.variant.mcps, skills: c.variant.skills, localSkills: c.variant.localSkills, status: 'pending',
      runId: history.createRecord(buildCfg(c, fixed), { mode: 'matrix', prompt, matrixId, status: 'pending' }),
    })),
  };
  runMatrix(combos, { prompt, matrixId, fixed }).catch((e: any) => {
    matrixRunning = false; matrixState.running = false;
    broadcast({ type: 'error', msg: e.message });
  });
  return { matrixId, total: combos.length };
}

// Abort the in-progress matrix: kill whatever the current entry is running (whole
// process group — scaffold/npm-install, ai-config, or the agent) plus app/opencode,
// which rejects the current entry's pipeline; the loop then sees `matrixCancelled`
// and skips the rest.
export function cancel(): { ok: boolean; error?: string } {
  if (!matrixRunning) return { ok: false, error: 'no matrix run in progress' };
  matrixCancelled = true;
  killTree(currentChild, 'SIGTERM');
  killWatcher('app'); killWatcher('opencode');
  broadcast({ type: 'log', msg: 'cancellation requested — stopping the current step' });
  return { ok: true };
}

// Cancel a single entry by its history runId (from the History tab). A still-pending
// entry is just skipped when the loop reaches it; the currently-running entry has its
// child + watchers killed so its pipeline rejects — but the loop continues with the
// rest of the matrix (unlike the whole-matrix `cancel()` above).
export function cancelEntry(runId: string): { ok: boolean; error?: string } {
  if (!matrixRunning) return { ok: false, error: 'no matrix run in progress' };
  const entry = matrixState.entries.find((e) => e.runId === runId);
  if (!entry) return { ok: false, error: 'run is not part of the active matrix' };
  if (entry.status !== 'pending' && entry.status !== 'running') {
    return { ok: false, error: 'run is not pending or running' };
  }
  cancelledEntries.add(runId);
  if (entry.status === 'running') {
    killTree(currentChild, 'SIGTERM');
    killWatcher('app'); killWatcher('opencode');
    broadcast({ type: 'log', index: entry.index, msg: 'entry cancellation requested — stopping this run' });
  }
  return { ok: true };
}

export const isRunning = (): boolean => matrixRunning;
export const getState = (): MatrixState => matrixState;
