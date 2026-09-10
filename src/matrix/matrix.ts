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
import { writeMatrixReport } from './report.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { Combo, MatrixEntry, MatrixPass, MatrixState, MatrixFixed as Fixed, RunConfig, Diagnostic, DiagnosticKind, AgentRunError } from '../types.ts';
import { deriveStatus, summarizeDiagnostics, isActive, kindPriority } from '../capture/diagnostics.ts';
import { DIAGNOSTIC_AGGREGATE_THRESHOLD } from '../config.ts';

// Run the same prompt across platform × variant as one-shot headless runs. Sequential
// (the app + opencode bind fixed ports, so only one entry can be live at a time).
export const sse = createSSE();
// Extra event sinks beside the SSE clients (e.g. the console mirror for terminal-driven
// runs) — they receive every broadcast object; a throwing tap never breaks the run.
const taps = new Set<(obj: any) => void>();
export const tap = (fn: (obj: any) => void): void => { taps.add(fn); };
const broadcast = (obj: any) => {
  sse.broadcast(obj);
  for (const t of taps) { try { t(obj); } catch (_) {} }
};

let matrixRunning = false;
let matrixCancelled = false;
let currentChild: ChildProcess | null = null; // the in-flight pipeline child (scaffold/agent/…), for cancellation
let matrixState: MatrixState = { running: false, matrixId: null, total: 0, done: 0, entries: [], currentPass: 1, totalPasses: 1, pendingPasses: 0 };
// Entries accumulated across all passes of the current run — used by exitOnDone
// (matrix-config.ts) to compute an exit code that reflects every pass, not just the last.
let allPassEntriesLog: MatrixEntry[] = [];
export const getAllPassEntries = (): MatrixEntry[] => allPassEntriesLog;
// runIds individually cancelled from the History tab — a per-entry cancel that
// (unlike the whole-matrix `cancel()`) only aborts that one entry and lets the rest run.
const cancelledEntries = new Set<string>();
// Consecutive-entry counters, per fatal diagnostic kind. Transient matrix state: the
// per-entry diagnostics already carry the durable evidence, so this is never persisted.
const aggregateCounts = new Map<DiagnosticKind, number>();

const STEP_CELL_MAX = 80;
const compactStep = (s: string): string =>
  s.length > STEP_CELL_MAX ? s.slice(0, STEP_CELL_MAX - 1) + '…' : s;

/**
 * Fold one settled entry into the consecutive-failure counters and pick the banner.
 *
 * "Active" means the same thing it does in status derivation — neither resolved nor
 * superseded. A recovered blip did not decide this entry's status and must not be
 * allowed to predict the next entry's either, or one transient hiccup starts a banner
 * announcing the rest of the matrix is doomed. A settle WITHOUT an active diagnostic of
 * a kind resets that kind, success included. Cancelled entries are skipped entirely:
 * neither increment nor reset, since a user cancel says nothing about the provider.
 */
function updateAggregate(diagnostics: Diagnostic[], cancelled: boolean, remaining: number): void {
  if (cancelled) return;
  const active = (diagnostics || []).filter((d) => d.severity === 'fatal' && isActive(d));
  const hit = new Set(active.map((d) => d.kind));
  for (const kind of hit) aggregateCounts.set(kind, (aggregateCounts.get(kind) || 0) + 1);
  for (const kind of [...aggregateCounts.keys()]) if (!hit.has(kind)) aggregateCounts.set(kind, 0);

  // One banner at a time: the highest counter, ties broken by the status priority table.
  let best: { kind: DiagnosticKind; count: number } | null = null;
  for (const [kind, count] of aggregateCounts) {
    if (count < DIAGNOSTIC_AGGREGATE_THRESHOLD) continue;
    if (!best || count > best.count || (count === best.count && kindPriority(kind) < kindPriority(best.kind))) {
      best = { kind, count };
    }
  }
  if (!best) { matrixState.banner = null; return; }
  const title = active.find((d) => d.kind === best!.kind)?.title || best.kind;
  matrixState.banner = {
    kind: best.kind,
    count: best.count,
    message: `${best.count} entries in a row hit ${title}.` +
      (remaining > 0 ? ` The remaining ${remaining} will likely do the same — cancel and retry later?` : ''),
  };
}

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
    selectedTests: fixed.selectedTests,
    promptImages: fixed.promptImages,
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

async function runMatrix(combos: Combo[], { prompt, matrixId, fixed, name }: { prompt: string; matrixId: string; fixed: Fixed; name: string | null }): Promise<void> {
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
      // Every remaining entry just emitted `entry-done`, so the counter has to jump with
      // them. Leaving it at the last *executed* entry makes the reconnect snapshot
      // contradict the events a connected client already applied.
      matrixState.done = combos.length;
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
      // Retained server-side (same reason as `entry.step` and `entry.logs`): the SSE
      // stream alone is lost on disconnect, so without this a reload would drop a live
      // stall warning that the entry is still carrying.
      else if (type === 'diagnostics') entry.diagnostics = obj.diagnostics;
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
      const result = await runPipeline(cfg, {
        emit, headless: true, prompt, dataDir, artifactDir, onChild, appDir,
        isCancelled: () => matrixCancelled || cancelledEntries.has(runId),
      });
      closeStep();
      if (result.stats) history.updateStats(runId, result.stats);
      // The agent ran fine but the edited app may not compile — flag that distinctly
      // from a clean success so "0 shots" isn't mistaken for "app had no routes". A
      // built app whose injected Playwright tests fail becomes 'test-failed'.
      const cancelled = matrixCancelled || cancelledEntries.has(runId);
      const tests = result.tests || null;
      const diagnostics = result.diagnostics || [];
      // Derived over the diagnostics rather than special-cased per failure mode, and on
      // the SUCCESS path too: a fatal diagnostic reclassifies a run that exited 0.
      const status = deriveStatus(diagnostics, {
        cancelled,
        buildFailed: result.appReady === false,
        testsFailed: !!(tests && !tests.ok),
      });
      const diagSummary = summarizeDiagnostics(diagnostics);
      const outcomeErr = status === 'build-error' ? (result.appError || 'app build failed')
        : status === 'test-failed' ? (tests?.error || `${tests?.failed} test(s) failed`)
        : diagSummary;
      const tools = result.tools || null;
      history.finish(runId, { status, error: outcomeErr, completed, timings, screenshots: result.screenshots || [], tests, tools, diagnostics, logs: entry.logs || [] });
      if (diagnostics.length) entry.diagnostics = diagnostics;
      updateAggregate(diagnostics, cancelled, combos.length - (i + 1));
      entry.status = status;
      // Surfaced on the entry so the Matrix tab shows which tooling was exercised
      // without opening History — the point of comparison between variants.
      if (tools) {
        entry.mcpCalls = tools.mcpCalls;
        entry.skillCalls = tools.skillCalls;
      }
      // Retain the summary label so a reload shows the outcome, not the last live step.
      if (status === 'success') {
        const shots = `${(result.screenshots || []).filter((s) => s.ok).length} shots`;
        const parts = [tests && tests.ran ? `${shots} · ${tests.passed}/${tests.total} tests` : shots];
        if (tools) parts.push(`${tools.mcpCalls} mcp · ${tools.skillCalls} skill`);
        if (diagSummary) parts.push(`⚠ ${diagSummary}`);
        entry.step = compactStep(parts.join(' · '));
      } else if (status === 'build-error') entry.step = 'build failed';
      else if (status === 'test-failed') entry.step = tests ? `tests failed (${tests.failed}/${tests.total})` : 'tests failed';
      else if (diagSummary) entry.step = compactStep(diagSummary);
      broadcast({
        type: 'entry-done', index: i, status, runId,
        screenshots: result.screenshots || [], stats: result.stats || null, tests, tools, diagnostics,
        banner: matrixState.banner || null, error: outcomeErr,
      });
    } catch (err: any) {
      closeStep();
      // runPipeline threw (cancel / timeout / error) before its own cleanup stage —
      // free any watcher and reclaim disk here so the kept entry dir isn't left heavy.
      await killWatcher('app'); await killWatcher('opencode');
      try { await cleanupAppDir(appDir, emit); } catch (_) {}
      const cancelled = matrixCancelled || cancelledEntries.has(runId);
      // The evidence rides out on the error, since a failed pipeline returns no result.
      const agentErr = err as AgentRunError;
      const diagnostics = agentErr.diagnostics || [];
      // A provider failure isn't a code/test failure — it gets its own status (and its
      // own pill) so it reads distinctly from a hard error, and the run still keeps the
      // token/cost + MCP-call evidence it accumulated before it died.
      const status = deriveStatus(diagnostics, { cancelled, errored: true });
      const diagSummary = summarizeDiagnostics(diagnostics);
      const error = cancelled ? 'cancelled' : (diagSummary || err.message);
      history.finish(runId, {
        status, error, completed, timings, diagnostics,
        stats: agentErr.stats ?? null, tools: agentErr.tools ?? null, logs: entry.logs || [],
      });
      entry.status = status;
      if (diagnostics.length) entry.diagnostics = diagnostics;
      entry.step = compactStep(cancelled ? 'cancelled' : error);
      updateAggregate(diagnostics, cancelled, combos.length - (i + 1));
      broadcast({
        type: 'entry-done', index: i, status, runId, diagnostics,
        stats: agentErr.stats || null, tools: agentErr.tools || null,
        banner: matrixState.banner || null, error: cancelled ? null : error,
      });
    } finally {
      currentChild = null;
    }
    matrixState.done = i + 1;
  }
  killWatcher('app'); killWatcher('opencode');
  // runMatrix job done — runAllPasses handles state reset, report generation, and
  // the matrix-done broadcast so the outer loop can proceed to the next pass (if any).
}

// Run the combo set once per pass (outer loop) — each with its own prompt, matrixId,
// and pre-created history records. All records are created up-front by begin() so
// they appear in History the moment the matrix is submitted.
async function runAllPasses(combos: Combo[], passes: MatrixPass[], allPassIds: string[][], matrixIds: string[], fixed: Fixed): Promise<void> {
  for (let r = 0; r < passes.length; r++) {
    const { prompt, name = null } = passes[r];
    const matrixId = matrixIds[r];
    const isLast = r === passes.length - 1;

    // Swap matrixState to this pass's entries (pre-created in begin()).
    matrixState.matrixId = matrixId;
    matrixState.name = name;
    matrixState.total = combos.length;
    matrixState.done = 0;
    matrixState.currentPass = r + 1;
    matrixState.totalPasses = passes.length;
    matrixState.pendingPasses = passes.length - (r + 1);
    // The aggregate banner is per-pass: each pass is its own matrixId with its own
    // report, and consecutive-failure counters from the previous pass must not predict
    // this one's (a rate limit that has since cleared would start it already banner-ed).
    aggregateCounts.clear();
    matrixState.banner = null;
    matrixState.entries = combos.map((c, i) => ({
      index: i, platform: c.platform, variantLabel: c.variantLabel,
      mcps: c.variant.mcps, skills: c.variant.skills, localSkills: c.variant.localSkills,
      status: 'pending', runId: allPassIds[r][i],
    }));

    broadcast({ type: 'matrix-start', matrixId, name, total: combos.length,
      entries: matrixState.entries, currentPass: r + 1, totalPasses: passes.length });

    if (matrixCancelled) {
      // Queue-level cancel arrived before this pass started — settle its entries.
      for (const entry of matrixState.entries) {
        entry.status = 'cancelled';
        if (entry.runId) {
          history.finish(entry.runId, { status: 'cancelled', error: 'cancelled' });
          broadcast({ type: 'entry-done', index: entry.index, status: 'cancelled', runId: entry.runId });
        }
      }
    } else {
      await runMatrix(combos, { prompt, matrixId, fixed, name: name ?? null });
    }
    // Snapshot this pass's settled entries into the cross-pass accumulator so
    // exitOnDone can compute a correct exit code over the whole run.
    allPassEntriesLog.push(...matrixState.entries);

    // Per-pass report (best-effort: a failure must never surface as a pass error).
    let report: string | null = null;
    let summary: string | null = null;
    try {
      writeMatrixReport(matrixId, matrixState.entries, {
        prompt, model: fixed.model, cancelled: matrixCancelled, name: name ?? null,
      });
      report = `/history/reports/${matrixId}/report.html`;
      summary = `/history/reports/${matrixId}/summary.json`;
    } catch (e: any) {
      broadcast({ type: 'log', msg: `report generation failed: ${e.message}` });
    }

    broadcast({ type: 'matrix-done', matrixId, total: combos.length, cancelled: matrixCancelled,
      report, summary, last: isLast, currentPass: r + 1, totalPasses: passes.length });

    if (matrixCancelled) {
      // Settle pre-created history records for every un-started pass.
      for (let rr = r + 1; rr < passes.length; rr++) {
        for (const runId of allPassIds[rr]) {
          if (runId) history.finish(runId, { status: 'cancelled', error: 'cancelled' });
        }
      }
      break;
    }
  }
  matrixState.running = false;
  matrixRunning = false;
}

// Set up state for a (validated, already-capped) set of combos and kick off all passes
// in the background. Creates every pass's history records up-front (status 'pending')
// so they appear in History the moment the request is submitted, not one row at a time.
// Returns { matrixId, total, completion }; the caller responds immediately and the
// client follows progress via the matrix SSE stream.
export function begin(combos: Combo[], { passes, fixed }: { passes: MatrixPass[]; fixed: Fixed }): { matrixId: string; allMatrixIds: string[]; total: number; completion: Promise<void> } {
  const matrixIds = passes.map(() => newMatrixId());
  // Pre-create ALL history records across ALL passes, all as 'pending'.
  const allPassIds: string[][] = passes.map((pass, r) =>
    combos.map((c) =>
      history.createRecord(buildCfg(c, fixed), {
        mode: 'matrix', prompt: pass.prompt,
        matrixId: matrixIds[r], matrixName: pass.name ?? null, status: 'pending',
      })
    )
  );
  matrixRunning = true;
  matrixCancelled = false;
  cancelledEntries.clear();
  allPassEntriesLog = [];
  aggregateCounts.clear();
  matrixState = {
    running: true, matrixId: matrixIds[0], name: passes[0].name ?? null,
    total: combos.length, done: 0,
    currentPass: 1, totalPasses: passes.length, pendingPasses: passes.length - 1,
    // Retained after the matrix finishes, so the final view still explains why the tail
    // of the run looks the way it does.
    banner: null,
    entries: combos.map((c, i) => ({
      index: i, platform: c.platform, variantLabel: c.variantLabel,
      mcps: c.variant.mcps, skills: c.variant.skills, localSkills: c.variant.localSkills,
      status: 'pending', runId: allPassIds[0][i],
    })),
  };
  const completion = runAllPasses(combos, passes, allPassIds, matrixIds, fixed).catch((e: any) => {
    matrixRunning = false; matrixState.running = false;
    broadcast({ type: 'error', msg: e.message });
  });
  return { matrixId: matrixIds[0], allMatrixIds: matrixIds, total: combos.length, completion };
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
