'use strict';

import { stripAnsi } from '../ansi.ts';
import { recentCalls, detectLoop, type LoopHit, type RecentCall } from './loop.ts';
import type { Diagnostic, DiagnosticKind } from '../types.ts';

// Which pipe a chunk arrived on. Kept distinct because a provider error on stderr and
// the same string echoed on stdout are different observations (see DIAGNOSTICS-PLAN.md
// finding 2) — the classifier is allowed to trust one and not the other.
export type OutputStream = 'stdout' | 'stderr';

export interface LineFramer {
  /** Feed a raw, untrimmed chunk. Complete lines are delivered to `onLine`. */
  push(stream: OutputStream, chunk: string): void;
  /** Deliver any buffered partial line. Call once the process has closed. */
  flush(): void;
}

interface StreamState { buf: string }

// Reassemble whole lines from the arbitrary chunk boundaries a pipe hands us.
//
// This exists because `run()`'s log path (`emit('log', d.toString().trimEnd())`) is
// lossy in exactly the way a framer cannot tolerate: `trimEnd` destroys the only
// signal that says whether a chunk ended on a newline, so a naive wrapper always
// treats its tail as incomplete and mis-joins it to the next chunk.
//
// Terminator handling is deliberately terminal-accurate rather than just splitting on
// LF. Vite and opencode both rewrite progress lines with `ESC[2K` + CR, so a CR is a
// line boundary too — otherwise a payload written after a rewrite keeps the erased
// progress text as a prefix, and an anchored classifier match (`^Error:`) never fires.
// A CR at the very end of the buffer is held back rather than delivered: it may be the
// first half of a CRLF split across two chunks, and delivering early would emit a
// spurious empty line between the two halves.
//
// Lines are ANSI-stripped on the way out — one place, once — but stripping happens
// AFTER splitting, so an escape sequence straddling a chunk boundary is still intact
// by the time it is removed.
export function createLineFramer(
  onLine: (stream: OutputStream, line: string) => void,
  onError?: ((e: unknown) => void) | null,
): LineFramer {
  const states: Record<OutputStream, StreamState> = {
    stdout: { buf: '' },
    stderr: { buf: '' },
  };

  // One bad line must not desync the buffer, so delivery is guarded here as well as at
  // the call site in run(). A classifier that throws costs us that line, nothing more.
  const deliver = (stream: OutputStream, raw: string): void => {
    try { onLine(stream, stripAnsi(raw)); }
    catch (e) { if (onError) { try { onError(e); } catch (_) {} } }
  };

  return {
    push(stream, chunk) {
      if (!chunk) return;
      const st = states[stream];
      st.buf += chunk;
      for (;;) {
        const m = /\r|\n/.exec(st.buf);
        if (!m) break;
        const at = m.index;
        const isCR = st.buf[at] === '\r';
        // Trailing CR with nothing after it: cannot yet tell CR from CRLF. Wait.
        if (isCR && at === st.buf.length - 1) break;
        const line = st.buf.slice(0, at);
        const skip = isCR && st.buf[at + 1] === '\n' ? 2 : 1;
        st.buf = st.buf.slice(at + skip);
        deliver(stream, line);
      }
    },
    flush() {
      for (const stream of ['stdout', 'stderr'] as OutputStream[]) {
        const st = states[stream];
        if (!st.buf) continue;
        // A buffer held back on a lone trailing CR (see push) ends here; the CR itself
        // is a terminator, not content.
        const line = st.buf.endsWith('\r') ? st.buf.slice(0, -1) : st.buf;
        st.buf = '';
        if (line) deliver(stream, line);
      }
    },
  };
}

// ── Detector A: provider errors ───────────────────────────────────────────────

// opencode reports provider failures as a JSON body behind an `Error: ` label. The
// anchor runs on ANSI-STRIPPED lines: the real line carries a colour sequence before
// `Error` and a reset BETWEEN `Error: ` and the `{`, so an unstripped match finds
// nothing at all (verified against the corpus — 1 hit stripped, 0 unstripped).
const ANCHOR = /^\s*Error:\s*(\{.*\})\s*$/;

const DETAIL_MAX = 400;
/** Transport failures that never produce a JSON body. */
const NETWORK_TOKENS = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'fetch failed', 'socket hang up'];
/**
 * Kinds that constitute *provider* evidence — i.e. the thing the transport pass is a
 * last-resort guess about. `stalled` and `looping` are NOT in here: they are warnings
 * about the agent's behaviour, they say nothing about whether the provider was reachable,
 * and treating them as evidence would suppress a real transport failure.
 */
const PROVIDER_ERROR_KINDS = new Set<DiagnosticKind>([
  'rate-limited', 'no-credits', 'auth', 'provider-down', 'network', 'unknown-provider-error',
]);
/** How much of the stderr tail the transport pass looks at. */
const NETWORK_TAIL_LINES = 40;
/** Stderr lines retained for that pass. */
const TAIL_CAP = 80;
/** stdout payloads retained for exit-time promotion (see classifyAgentLine). */
const STDOUT_CANDIDATE_CAP = 20;

/**
 * opencode prints a failed MCP tool call as two lines: `✗ <server>_<tool> {input} failed`
 * followed by `Error: <message>`. Six such pairs sit in the corpus already
 * (run-20260813T113807-b1d9). They are harmless today because their messages are prose
 * rather than JSON — but an HTTP-backed MCP server that returns a JSON error body with a
 * numeric `code` would sail straight through the shape check and get the model provider
 * blamed for a tool's failure, which the CSS/Playwright false positives never could.
 * The preceding line is the only thing that distinguishes the two, so the collector
 * tracks it.
 */
const TOOL_FAILURE_RE = /^\s*✗\s+\S+\s.*\bfailed\s*$/;
export function isToolFailureLabel(line: string): boolean { return TOOL_FAILURE_RE.test(line); }

const truncate = (s: string): string =>
  s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 1) + '…' : s;

export interface ProviderErrorInfo {
  kind: DiagnosticKind;
  code: number;
  message: string;
  errorType?: string;
  /** The evidence line, stripped and truncated. Display material; never compared. */
  detail: string;
}

/**
 * Parse one ANSI-stripped line into a provider error, or null.
 *
 * `JSON.parse` succeeding proves the line was JSON, not that it was a *provider error* —
 * and rule 6 is a catch-all, so without a shape check any `Error: {…}` the agent happens
 * to print would become a fatal diagnostic that decides the run's status. Both fields
 * are therefore validated before any rule can claim the payload.
 */
export function parseProviderError(raw: string): ProviderErrorInfo | null {
  // The framer strips already; doing it again is a no-op. A caller that forgot would
  // otherwise get a silent null, which is precisely the quiet failure mode this whole
  // detector exists to avoid.
  const line = stripAnsi(raw);
  const m = ANCHOR.exec(line);
  if (!m) return null;
  let payload: any;
  try { payload = JSON.parse(m[1]); } catch (_) { return null; }
  if (!payload || typeof payload !== 'object') return null;

  const code = payload.code;
  const message = payload.message;
  if (typeof code !== 'number' || !Number.isFinite(code) || code < 100 || code > 599) return null;
  if (typeof message !== 'string' || !message.trim()) return null;

  const errorType = payload.metadata && typeof payload.metadata.error_type === 'string'
    ? payload.metadata.error_type : undefined;

  // Status code first; the message heuristic is only a fallback for codes the table
  // does not know. The two rules overlap — providers routinely word throttling as
  // "quota exceeded" — so the precedence has to be explicit or a 429 lands on
  // no-credits and tells the user to top up an account that is fine.
  let kind: DiagnosticKind;
  if (code === 429) kind = 'rate-limited';
  else if (code === 401 || code === 403) kind = 'auth';
  else if (code === 402) kind = 'no-credits';
  else if (code === 500 || code === 502 || code === 503 || code === 504) kind = 'provider-down';
  else if (/credit|quota|billing|insufficient/i.test(message)) kind = 'no-credits';
  else kind = 'unknown-provider-error';

  return { kind, code, message, errorType, detail: truncate(line.trim()) };
}

function providerDiagnostic(
  info: ProviderErrorInfo,
  confidence: Diagnostic['confidence'],
  now: string,
): Diagnostic {
  const label: Record<string, { title: string; advice: string }> = {
    'rate-limited': {
      title: `Provider rate limit (${info.code})`,
      advice: 'Wait a few minutes and re-run, or switch to a different model.',
    },
    auth: {
      title: `Provider rejected the API key (${info.code})`,
      advice: 'Check the API key for this provider — it was refused, not throttled.',
    },
    'no-credits': {
      title: `Provider balance exhausted (${info.code})`,
      advice: 'Top up the provider account, or switch to a model on a funded provider.',
    },
    'provider-down': {
      title: `Provider unavailable (${info.code}${info.errorType ? ` · ${info.errorType}` : ''})`,
      advice: 'The provider failed, not this run. Re-run the entry once it recovers.',
    },
    'unknown-provider-error': {
      title: `Provider error (${info.code})`,
      advice: 'Unrecognized provider status — see the evidence line for what it said.',
    },
  };
  const meta = label[info.kind] || label['unknown-provider-error'];
  return {
    id: `${info.kind}:${info.code}`,
    kind: info.kind,
    severity: 'fatal',
    confidence,
    title: meta.title,
    detail: info.detail,
    advice: meta.advice,
    at: now,
    count: 1,
    lastAt: now,
  };
}

/**
 * Classify one agent output line.
 *
 * Only stderr yields a `confirmed` diagnostic. Restricting it this way is a structural
 * guard against the false-positive class the corpus is full of — `--ig-error-500` CSS
 * custom properties, failed Playwright assertions, `ERR_MODULE_NOT_FOUND` from the
 * agent's own scratch scripts — all of which are output the agent produced or echoed,
 * i.e. stdout.
 *
 * That guard is a SAFEGUARD PENDING LIVE CONFIRMATION, not an established fact: stored
 * logs are a merged stdout+stderr stream, so the corpus cannot show which stream any
 * historical line arrived on. See the probes in DIAGNOSTICS-PLAN.md phase 1. stdout
 * payloads are not discarded outright — the collector holds them and promotes them to
 * `suspected` if the agent then exits non-zero (see `finish`), so if the probes show
 * opencode writes to stdout the detector degrades to weaker wording rather than going
 * silent, which is the failure mode worth engineering against.
 */
export function classifyAgentLine(line: string, stream: OutputStream): Diagnostic | null {
  if (stream !== 'stderr') return null;
  const info = parseProviderError(line);
  if (!info) return null;
  return providerDiagnostic(info, 'confirmed', new Date().toISOString());
}

/** Scan a stderr tail for transport failures that never produce a JSON body. */
export function classifyNetworkFailure(lines: string[], now = new Date().toISOString()): Diagnostic | null {
  for (const line of lines.slice(-NETWORK_TAIL_LINES).reverse()) {
    const hit = NETWORK_TOKENS.find((tok) => line.includes(tok));
    if (!hit) continue;
    return {
      id: `network:${hit}`,
      kind: 'network',
      severity: 'fatal',
      confidence: 'suspected',
      title: `Could not reach the provider (${hit})`,
      detail: truncate(line.trim()),
      advice: 'Check the container network and any custom base URL, then re-run.',
      at: now,
      count: 1,
      lastAt: now,
    };
  }
  return null;
}

// ── Detector B: stall ─────────────────────────────────────────────────────────

const STALL_ID = 'stalled:stall';

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

/**
 * No output for AGENT_STALL_MS. A **warning**, never fatal: it is recoverable by
 * definition and nothing is killed.
 *
 * This is the honest replacement for inferring a rate limit from the agent timeout. It
 * fires at 5 minutes of silence instead of 25 minutes of nothing, and it says the
 * provider *may* be unresponsive — which is true — rather than asserting a 429 nobody
 * observed.
 */
export function stallDiagnostic(silentMs: number, now = new Date().toISOString()): Diagnostic {
  return {
    id: STALL_ID,
    kind: 'stalled',
    severity: 'warning',
    confidence: 'confirmed',
    title: `No output for ${secs(silentMs)}`,
    detail: `the agent produced no output for ${secs(silentMs)}`,
    advice: 'The provider may be unresponsive. Nothing was killed — the run is still going.',
    at: now,
    count: 1,
    lastAt: now,
  };
}

/**
 * The run's own timeout, as a diagnostic rather than a bare status.
 *
 * Constructed from the `timedOut` flag so History's detail panel and the aggregation
 * counter have something to show for the single longest failure mode in the corpus.
 * `silentMs` distinguishes a run that timed out while still producing output from one
 * that had been silent for most of its budget — a materially different story.
 */
export function timeoutDiagnostic(
  timeoutMs: number,
  silentMs: number | null,
  now = new Date().toISOString(),
  openStall?: Diagnostic | null,
): Diagnostic {
  const silence = silentMs != null && silentMs > 0 ? `; last output ${secs(silentMs)} before the cap` : '';
  // The pair is the actual story: "silent from minute 5, still silent when the cap hit."
  const stalled = openStall ? `; stalled since ${openStall.at} and never recovered` : '';
  return {
    id: 'timed-out:agent',
    kind: 'timed-out',
    severity: 'fatal',
    confidence: 'confirmed',
    title: 'Agent exceeded its time limit',
    detail: `agent exceeded AGENT_TIMEOUT_MS (${timeoutMs}ms)${silence}${stalled}`,
    advice: 'Raise AGENT_TIMEOUT_MS, simplify the prompt, or check whether the provider stalled.',
    at: now,
    count: 1,
    lastAt: now,
  };
}

// ── Detector C: loop ──────────────────────────────────────────────────────────

const loopId = (tool: string): string => `looping:${tool}`;

/**
 * The agent is repeating itself right now. A **warning** only — some legitimate work is
 * repetitive, and this must never fail a run on its own.
 */
export function loopDiagnostic(hit: LoopHit, now = new Date().toISOString()): Diagnostic {
  const what = hit.shape === 'repeat'
    ? `the same call ${hit.reps}× in a row`
    : `a ${hit.period}-step cycle ${hit.reps}× back to back`;
  return {
    id: loopId(hit.tool),
    kind: 'looping',
    severity: 'warning',
    confidence: 'confirmed',
    title: `Agent may be looping on ${hit.tool}`,
    detail: `${what} (identical inputs), running up to the newest tool call`,
    advice: 'Check the entry log — the agent may be stuck retrying instead of progressing.',
    at: now,
    count: 1,
    lastAt: now,
  };
}

// ── Collector ─────────────────────────────────────────────────────────────────

export interface CollectorOpts {
  /** True while the user has cancelled this entry (or the whole matrix). */
  isCancelled?: (() => boolean) | null;
  /** DIAGNOSTICS_STREAM_DEBUG=1 scaffolding — temporary, not an operational knob. */
  onDebug?: ((msg: string) => void) | null;
  /**
   * Mid-run propagation. Receives the FULL current set, never a delta: that makes
   * reconciliation on the far side idempotent and lets a dropped event self-heal on the
   * next one — the same reasoning behind replaying the whole matrix state snapshot on
   * SSE reconnect. A stall reported only in the final record is reported too late to act
   * on, which is why this channel exists at all.
   */
  onChange?: ((diagnostics: Diagnostic[]) => void) | null;
  /**
   * Detector C. Reads opencode's store on a timer while the agent runs, so a loop is
   * reported while there is still time to act on it. Omit to disable (interactive runs
   * have no observable end — that is phase 4).
   */
  loop?: {
    dataDir: string;
    /** Ignore store entries older than this epoch ms (a store can be shared). */
    since: number;
    /** Identical consecutive calls before it counts as a loop. */
    repeats?: number;
    pollMs?: number;
    /** Store reader override. Defaults to `recentCalls` (opencode's SQLite store);
     * injectable so the detector can be driven from a stub, and so a future source
     * (an interactive-session feed) can be swapped in without touching the logic. */
    read?: ((dataDir: string, since: number) => Promise<RecentCall[] | null>) | null;
  } | null;
}

/** Count bumps are throttled to this; structural changes always go out immediately. */
const CHANGE_THROTTLE_MS = 1000;

export interface FinishOpts {
  exitCode?: number | null;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface DiagnosticsCollector {
  /** Wire straight to RunOpts.onOutput. */
  onOutput(stream: OutputStream, chunk: string): void;
  /**
   * Flush any buffered partial line WITHOUT closing the collector.
   *
   * `finish()` also flushes, but it ends the collector — wrong for an interactive session,
   * where the watcher can close and be replaced (a model switch) while the session, and
   * therefore the collector, carries on. Without this the last unterminated line of the
   * old process is not merely lost: it stays in the buffer and fuses with the first chunk
   * of the replacement.
   */
  flushOutput(): void;
  /** Wire to RunOpts.onStall — the agent has gone quiet for `silentMs`. */
  noteStall(silentMs: number): void;
  /** Wire to RunOpts.onResume — output came back after `silentMs` of silence. */
  noteResume(silentMs: number): void;
  /**
   * Shut the collector down and return the final set. Async because step 4 of the
   * shutdown sequence is an AWAITED final store read — the most repetitive stretch of a
   * run is usually its last one, and the periodic tick may well have missed it.
   */
  finish(opts?: FinishOpts): Promise<Diagnostic[]>;
  /** Perform one loop read now. The poller calls this on its own cadence; exposed so a
   * caller can force a read (and so the detector is drivable in tests). */
  pollLoop(): Promise<void>;
  /**
   * Point Detector C at a store after construction, or clear it with null.
   *
   * Headless knows the store up front and lets the collector run its own timer. An
   * interactive session does not: the collector must exist before `opencode web` starts
   * (or its early output is lost), while the store context only arrives when the pipeline
   * hands off. Omitting `pollMs` leaves the read externally driven — the interactive path
   * calls `pollLoop()` from the StatsCollector's existing 30s reconcile tick rather than
   * starting a second timer against the same store.
   */
  setLoopContext(cfg: CollectorOpts['loop']): void;
  /** Current set (ordered by first occurrence). */
  list(): Diagnostic[];
}

export function createDiagnosticsCollector(opts: CollectorOpts = {}): DiagnosticsCollector {
  const found = new Map<string, Diagnostic>();
  const stderrTail: string[] = [];
  const stdoutCandidates: ProviderErrorInfo[] = [];
  const counts: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  let lastOutputAt = Date.now();
  // TWO states, not one. "stop accepting periodic results" and "stop accepting
  // anything" are different: a single `stopped` boolean would make the shutdown's own
  // final read indistinguishable from a stale in-flight one and discard it.
  let closed = false;
  let acceptPeriodic = true;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let poller: NodeJS.Timeout | null = null;

  let lastNotify = 0;
  // `structural` = a diagnostic appeared or changed lifecycle state (resolved /
  // superseded). Those must reach the UI at once; a rising count can wait a beat so a
  // pathological output loop cannot turn into an SSE flood.
  const notify = (structural: boolean): void => {
    if (!opts.onChange) return;
    const now = Date.now();
    if (!structural && now - lastNotify < CHANGE_THROTTLE_MS) return;
    lastNotify = now;
    try { opts.onChange([...found.values()]); } catch (_) {}
  };

  // A repeat of an already-open id bumps the occurrence count in place, so a provider
  // returning 429 forty times yields one diagnostic rather than forty.
  const upsert = (d: Diagnostic): void => {
    const existing = found.get(d.id);
    if (!existing) { found.set(d.id, d); notify(true); return; }
    existing.count += 1;
    existing.lastAt = d.lastAt;
    // A confirmed sighting outranks a suspected one for the same condition.
    const promoted = existing.confidence === 'suspected' && d.confidence === 'confirmed';
    if (promoted) {
      existing.confidence = 'confirmed';
      existing.detail = d.detail;
    }
    notify(promoted);
  };

  const prev: Record<OutputStream, string> = { stdout: '', stderr: '' };

  const onLine = (stream: OutputStream, line: string): void => {
    if (closed) return;
    if (stream === 'stderr') {
      stderrTail.push(line);
      if (stderrTail.length > TAIL_CAP) stderrTail.shift();
    }
    const afterToolFailure = isToolFailureLabel(prev[stream]);
    prev[stream] = line;
    // A tool's error is not the provider's error.
    if (afterToolFailure) {
      if (opts.onDebug && parseProviderError(line)) {
        opts.onDebug(`ignored provider-shaped payload on ${stream}: follows an MCP tool failure`);
      }
      return;
    }
    const d = classifyAgentLine(line, stream);
    if (d) {
      if (opts.onDebug) opts.onDebug(`anchor hit on ${stream}: ${d.id}`);
      upsert(d);
      return;
    }
    // Held, not classified: promotion happens at exit and only on a non-zero exit.
    if (stream === 'stdout' && stdoutCandidates.length < STDOUT_CANDIDATE_CAP) {
      const info = parseProviderError(line);
      if (info) {
        if (opts.onDebug) opts.onDebug(`anchor hit on stdout (held): ${info.kind}:${info.code}`);
        stdoutCandidates.push(info);
      }
    }
  };

  const framer = createLineFramer(onLine);

  // Apply one store read. A loop that STOPS must be marked stopped, not merely left
  // alone: ceasing to update a diagnostic renders identically to one still firing, so
  // "the agent is looping" would stay on screen for the rest of the run.
  const applyLoop = (calls: RecentCall[] | null): void => {
    if (calls === null) return; // unreadable store — "no data", not "no loop"
    const hit = detectLoop(calls, loopCfg?.repeats ?? 5);
    const now = new Date().toISOString();
    const activeId = hit ? loopId(hit.tool) : null;
    let structural = false;

    for (const d of found.values()) {
      if (d.kind !== 'looping' || d.resolvedAt || d.supersededAt) continue;
      if (d.id !== activeId) { d.resolvedAt = now; structural = true; }
    }

    if (hit) {
      const existing = found.get(activeId!);
      if (!existing) {
        found.set(activeId!, loopDiagnostic(hit, now));
        structural = true;
      } else if (existing.resolvedAt) {
        // Same tool looping again after a recovery — one diagnostic per tool across the
        // run, not one per episode.
        delete existing.resolvedAt;
        existing.count += 1;
        existing.lastAt = now;
        existing.detail = loopDiagnostic(hit, now).detail;
        structural = true;
      } else {
        existing.lastAt = now;
        existing.detail = loopDiagnostic(hit, now).detail;
      }
    }
    if (structural || hit) notify(structural);
  };

  const readLoop = async (periodic: boolean): Promise<void> => {
    const cfg = loopCfg;
    if (!cfg || closed) return;
    if (periodic && !acceptPeriodic) return;
    const gen = generation;
    try {
      const calls = await (cfg.read || recentCalls)(cfg.dataDir, cfg.since);
      // A read that began before shutdown must not append a `looping` diagnostic to an
      // entry that has already settled.
      if (closed || gen !== generation) return;
      if (periodic && !acceptPeriodic) return;
      applyLoop(calls);
    } catch (e: any) {
      if (opts.onDebug) opts.onDebug(`loop read failed (${(e && e.message) || e})`);
    }
  };

  // `opts.loop` is reassigned by setLoopContext, so every reader goes through this.
  let loopCfg = opts.loop || null;

  const startPoller = (): void => {
    if (poller) { clearInterval(poller); poller = null; }
    const pollMs = loopCfg?.pollMs;
    if (!loopCfg || !pollMs) return; // externally driven (see setLoopContext)
    poller = setInterval(() => {
      // Overlapping reads are SKIPPED, not queued (the StatsCollector precedent).
      if (inFlight) return;
      inFlight = readLoop(true).finally(() => { inFlight = null; });
    }, pollMs);
    poller.unref && poller.unref();
  };
  if (loopCfg && loopCfg.pollMs === undefined) loopCfg = { ...loopCfg, pollMs: 30000 };
  startPoller();

  return {
    onOutput(stream, chunk) {
      if (closed) return;
      counts[stream] += 1;
      lastOutputAt = Date.now();
      framer.push(stream, chunk);
    },

    // Recoverable by definition, so it uses the resolve/re-open lifecycle rather than a
    // new diagnostic per episode: an agent that goes quiet, comes back, and goes quiet
    // again is one story, not three.
    noteStall(silentMs) {
      if (closed) return;
      const now = new Date().toISOString();
      const existing = found.get(STALL_ID);
      if (!existing) { found.set(STALL_ID, stallDiagnostic(silentMs, now)); notify(true); return; }
      const wasResolved = !!existing.resolvedAt;
      delete existing.resolvedAt;
      existing.count += 1;
      existing.lastAt = now;
      existing.title = `No output for ${secs(silentMs)}`;
      existing.detail = `the agent produced no output for ${secs(silentMs)}`;
      notify(wasResolved);
    },

    // Ceasing to update a diagnostic is invisible in the UI — it renders identically to
    // one still firing — so a recovery has to be MARKED, not merely left alone.
    noteResume(silentMs) {
      if (closed) return;
      const existing = found.get(STALL_ID);
      if (!existing || existing.resolvedAt || existing.supersededAt) return;
      existing.resolvedAt = new Date().toISOString();
      existing.detail = `no output for ${secs(silentMs)}, then it resumed`;
      notify(true);
    },

    async finish({ exitCode = null, timedOut = false, timeoutMs = 0 }: FinishOpts = {}) {
      if (closed) return [...found.values()];

      // Shutdown, in this order — the ordering is the whole point.
      // 1. Stop scheduling, so nothing new is queued.
      if (poller) { clearInterval(poller); poller = null; }
      // 2. Invalidate any in-flight periodic read, then wait for it to settle so it
      //    cannot land after we finish. Its result is already stale by construction.
      acceptPeriodic = false;
      generation++;
      if (inFlight) { try { await inFlight; } catch (_) {} }
      // 3. Flush the framer. A provider error written without a trailing newline as the
      //    process dies is exactly what this recovers.
      framer.flush();
      // 4. One final, AWAITED read — issued after the invalidation but before the
      //    collector is closed, bumping the generation so it can never be mistaken for
      //    the stale in-flight result we just discarded.
      generation++;
      await readLoop(false);
      // 5. Only now does the guard reject everything. Anything after this is dropped by
      //    design, not by accident.
      closed = true;

      const now = new Date().toISOString();
      const cancelled = !!(opts.isCancelled && opts.isCancelled());
      const failed = timedOut || (exitCode !== null && exitCode !== 0);

      if (timedOut) {
        // A stall that ran straight into the timeout is the OPPOSITE of a recovery.
        // Marking it resolved would erase the strongest evidence the run has, so the
        // supersede pair is used instead — and both fields are stamped together, because
        // status derivation and the UI test `supersededAt` (the state), not the pointer.
        const stall = found.get(STALL_ID);
        const openStall = stall && !stall.resolvedAt && !stall.supersededAt ? stall : null;
        const to = timeoutDiagnostic(timeoutMs, Date.now() - lastOutputAt, now, openStall);
        upsert(to);
        if (openStall) { openStall.supersededAt = now; openStall.supersededBy = to.id; }
      }

      // Diagnostics already confirmed off stderr before a cancel are real observations
      // and are kept; only the exit-time guesswork below is suppressed.
      if (failed && !cancelled) {
        // A structured payload is something only the AGENT can produce — no amount of
        // process teardown fabricates `Error: {"code":429,…}` on stdout — so this pass
        // is safe on every failure path, timeout included.
        for (const info of stdoutCandidates) {
          const existing = found.get(`${info.kind}:${info.code}`);
          // Corroborated by a stderr sighting of the same condition ⇒ it just bumps the
          // count on the confirmed one. Otherwise it stands alone as suspected.
          upsert(providerDiagnostic(info, existing ? 'confirmed' : 'suspected', now));
        }

        // The transport pass is different: teardown genuinely produces these strings.
        // Killing opencode's process group tears its connections, so BOTH a user cancel
        // and the SIGTERM→SIGKILL that follows AGENT_TIMEOUT_MS manufacture exactly the
        // evidence it looks for. On a timeout the honest headline is the timeout — that
        // is what we observed — so the guess is not made at all.
        //
        // The cost is deliberate and worth naming: a run that timed out *because* the
        // provider was unreachable will not carry a `network` diagnostic. Its stderr tail
        // cannot be attributed (pre-timeout failure vs post-signal teardown look
        // identical from here), and claiming the stronger status from unattributable
        // evidence is the failure mode this whole detector exists to avoid. The
        // `timed-out` diagnostic still reports how long the agent had been silent.
        if (!timedOut) {
          // "Better evidence" means an ACTIVE FATAL PROVIDER diagnostic — a transport
          // guess alongside a parsed 504 is noise. It does not mean "any diagnostic":
          // `stalled`/`looping` are warnings about the agent, not findings about the
          // provider, and a resolved or superseded one is no longer the run's problem.
          const haveProviderError = [...found.values()].some(
            (d) => d.severity === 'fatal' && isActive(d) && PROVIDER_ERROR_KINDS.has(d.kind));
          if (!haveProviderError) {
            const net = classifyNetworkFailure(stderrTail, now);
            if (net) upsert(net);
          }
        }
      }

      if (opts.onDebug) {
        opts.onDebug(`stream line counts — stdout:${counts.stdout} stderr:${counts.stderr}` +
          `; stdout payloads held:${stdoutCandidates.length}; cancelled:${cancelled}`);
      }
      notify(true);
      return [...found.values()];
    },

    flushOutput() {
      if (closed) return;
      framer.flush();
    },

    pollLoop() { return readLoop(true); },

    setLoopContext(cfg) {
      if (closed) return;
      loopCfg = cfg || null;
      startPoller();
    },

    list() { return [...found.values()]; },
  };
}

// ── Status derivation ─────────────────────────────────────────────────────────

/** Neither recovered nor overtaken — i.e. still the run's problem. */
export function isActive(d: Diagnostic): boolean {
  return !d.resolvedAt && !d.supersededAt;
}

// Fatal kinds in priority order. `network` and `unknown-provider-error` deliberately
// collapse into the `provider-down` STATUS while keeping their own kind on the
// diagnostic: the pill vocabulary stays small while the detail panel stays precise.
const STATUS_BY_KIND: Array<[DiagnosticKind, string]> = [
  ['auth', 'auth'],
  ['no-credits', 'no-credits'],
  ['rate-limited', 'rate-limited'],
  ['provider-down', 'provider-down'],
  ['network', 'provider-down'],
  ['unknown-provider-error', 'provider-down'],
  ['timed-out', 'timed-out'],
];

/** Rank a fatal kind by the status priority table (lower wins). Used to break ties
 * when two diagnostic kinds are equally "consecutive" in the matrix aggregation. */
export function kindPriority(kind: DiagnosticKind): number {
  const i = STATUS_BY_KIND.findIndex(([k]) => k === kind);
  return i < 0 ? STATUS_BY_KIND.length : i;
}

export interface DeriveOpts {
  cancelled?: boolean;
  buildFailed?: boolean;
  testsFailed?: boolean;
  /** The pipeline threw for a reason no diagnostic explains. */
  errored?: boolean;
}

/**
 * The run's status, derived over the collected diagnostics rather than special-cased
 * per failure mode. Evaluated on the success path too: a fatal diagnostic reclassifies
 * a run that technically exited 0.
 *
 * Resolved and superseded diagnostics are excluded — in the superseded case the
 * diagnostic that overtook it supplies the status instead. `stalled` and `looping` are
 * warnings and can never appear here.
 */
export function deriveStatus(diagnostics: Diagnostic[], o: DeriveOpts = {}): string {
  if (o.cancelled) return 'cancelled';
  if (o.buildFailed) return 'build-error';
  const fatal = new Set(
    (diagnostics || []).filter((d) => d.severity === 'fatal' && isActive(d)).map((d) => d.kind),
  );
  for (const [kind, status] of STATUS_BY_KIND) if (fatal.has(kind)) return status;
  if (o.testsFailed) return 'test-failed';
  if (o.errored) return 'error';
  return 'success';
}

/** One-line summary for the compact matrix step cell / run log. */
export function summarizeDiagnostics(diagnostics: Diagnostic[]): string | null {
  const active = (diagnostics || []).filter(isActive);
  if (!active.length) return null;
  const worst = active.find((d) => d.severity === 'fatal') || active[0];
  const more = active.length > 1 ? ` (+${active.length - 1} more)` : '';
  const hedge = worst.confidence === 'suspected' ? 'possibly: ' : '';
  return `${hedge}${worst.title}${worst.count > 1 ? ` ×${worst.count}` : ''}${more}`;
}
