'use strict';

import { spawn, type ChildProcess } from 'child_process';
import type { Emit } from '../types.ts';

export type OutputStream = 'stdout' | 'stderr';

export interface RunOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  heartbeatMs?: number;
  onChild?: ((child: ChildProcess) => void) | null;
  /**
   * Raw, untrimmed output as it arrives, tagged with the pipe it came from — the hook
   * the diagnostics line framer attaches to. Deliberately separate from `emit`, which
   * trims (destroying the newline signal a framer needs) and merges both pipes into
   * one callback (discarding the stream attribution). Never affects `emit` behaviour.
   */
  onOutput?: ((stream: OutputStream, chunk: string) => void) | null;
  /**
   * Raise `onStall` once the child has produced no output for this long, and `onResume`
   * when output comes back. Nothing is killed — this is a warning, not a deadline;
   * `timeoutMs` is the deadline.
   *
   * The timer lives in here rather than in a wrapper for the same reason the heartbeat
   * does: `cleanup()` must clear it on every settlement path, and two owners racing to
   * clear the same handle is how a stall gets reported against an entry that already
   * finished. Both callbacks receive the length of the silence in ms.
   */
  stallMs?: number;
  onStall?: ((silentMs: number) => void) | null;
  onResume?: ((silentMs: number) => void) | null;
}

/** Error from a `run()` that hit `timeoutMs`. Flagged rather than identified by its
 * message text — callers used to re-derive the message template by hand, so rewording
 * it silently broke their branch. */
export interface ProcError extends Error {
  timedOut?: boolean;
}

// SIGTERM -> SIGKILL grace, then a bounded wait for confirmation that the tree died.
// Exported so the smoke test can assert the escalation actually fires rather than
// hard-coding a duration that would silently stop matching if these changed.
export const KILL_GRACE_MS = 4000;
export const KILL_CONFIRM_MS = 4000;

// Signal a child's whole process group (negative pid) so its descendants die too,
// not just the launcher. Falls back to the direct child if the group send fails.
export function killTree(child: ChildProcess | null | undefined, sig: NodeJS.Signals): void {
  if (!child) return;
  try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
  catch (_) { try { child.kill(sig); } catch (_) {} }
}

/**
 * Is anything in this child's process tree still running?
 *
 * `close` on a ChildProcess describes the LAUNCHER only. `npm run x` exits on SIGTERM
 * while the node process it spawned ignores it, and a descendant that closed (or never
 * inherited) the pipes lets `close` fire with the real work still going — so "the
 * launcher closed" must never be read as "the tree is gone".
 *
 * Signal 0 on the negative pid asks the OS the question directly, but only where process
 * groups exist. On Windows it throws ESRCH unconditionally, alive or not (verified), so
 * the launcher's own state is the only truth available there — which is consistent with
 * the fact that killTree cannot reach Windows descendants in the first place.
 */
export function treeAlive(child: ChildProcess): boolean {
  if (child.exitCode === null && child.signalCode === null) return true; // launcher alive
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the group exists but is not ours to signal — still alive.
    return e && e.code === 'EPERM';
  }
}

// Resolve once the tree is gone, or false if it outlives `timeoutMs`. Polls, but also
// re-checks the instant the launcher closes, so the ordinary case costs no extra delay.
function waitTreeGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!treeAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (gone: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(cap);
      child.removeListener('close', onClose);
      resolve(gone);
    };
    const check = () => { if (!treeAlive(child)) finish(true); };
    const onClose = () => check();
    const poll = setInterval(check, 100);
    const cap = setTimeout(() => finish(false), timeoutMs);
    // The poll may be unref'd — it only accelerates the answer. The cap must NOT be:
    // it is the bounded-settlement guarantee, and an unref'd one lets the event loop
    // drain out from under an awaited teardown, which resolves nothing at all.
    poll.unref && poll.unref();
    child.once('close', onClose);
  });
}

/**
 * Take the tree down and RESOLVE ONLY ONCE IT IS ACTUALLY GONE: SIGTERM, escalate to
 * SIGKILL after a grace period, then a bounded wait for confirmation.
 *
 * Awaitable on purpose. An earlier version signalled and let the caller resume on the
 * launcher's `close`, four seconds ahead of the group SIGKILL — so a resistant descendant
 * could overlap the next matrix entry or the replacement opencode, which is the exact
 * failure the escalation exists to prevent. Resolves `{confirmed:false}` rather than
 * hanging if even SIGKILL leaves something behind (an uninterruptible-sleep process
 * survives it); the caller proceeds, but says so out loud instead of pretending.
 */
export async function terminateTree(child: ChildProcess): Promise<{ confirmed: boolean }> {
  killTree(child, 'SIGTERM');
  if (await waitTreeGone(child, KILL_GRACE_MS)) return { confirmed: true };
  killTree(child, 'SIGKILL');
  if (await waitTreeGone(child, KILL_CONFIRM_MS)) return { confirmed: true };
  return { confirmed: false };
}

// Run a command to completion, streaming its output through `emit`. Optional
// `opts.env` is merged over process.env; `opts.timeoutMs` kills + rejects on hang;
// `opts.heartbeatMs` emits a liveness tick so a long-but-working run (e.g. the agent)
// is distinguishable from a stuck one. stdin is /dev/null so a child that tries to
// prompt interactively (auth, "continue?") gets EOF and fails fast instead of hanging.
export function run(cmd: string, argv: string[], cwd: string, emit: Emit, opts: RunOpts = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    emit('log', `$ ${cmd} ${argv.join(' ')}`);
    // detached -> own process group, so killTree() can take down the whole tree
    // (e.g. `ig new` spawning `npm install`); otherwise SIGTERM to the launcher
    // leaves the real work running and Cancel can't stop it.
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (opts.onChild) opts.onChild(child);

    let timer: NodeJS.Timeout | null = null, beat: NodeJS.Timeout | null = null;
    let stall: NodeJS.Timeout | null = null;
    let timedOut = false, settled = false;
    // Clears only the OBSERVATIONAL timers. The termination escalation is not among them
    // and must never be — settling the promise says the caller is done waiting, not that
    // the process tree is gone. See terminateTree.
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (beat) { clearInterval(beat); beat = null; }
      if (stall) { clearInterval(stall); stall = null; }
    };
    const timeoutError = (): ProcError => {
      const e: ProcError = new Error(`${cmd} timed out after ${opts.timeoutMs}ms`);
      e.timedOut = true;
      return e;
    };
    // ONE settlement function, not one settlement event. The timeout path defers its
    // rejection until the tree is confirmed dead, which would otherwise let `close`
    // reject first with a generic "exited with code N" and silently downgrade every
    // timeout to an ordinary error. Making `close` the sole settler instead would hang
    // whenever `close` never arrives, so all three paths funnel through this guard.
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err); else resolve();
    };

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        // Intent is recorded BEFORE signalling, so whichever path settles produces the
        // typed timeout error rather than the exit-code error the signal itself causes.
        timedOut = true;
        if (beat) { clearInterval(beat); beat = null; }
        emit('log', `… ${cmd} exceeded ${opts.timeoutMs}ms — terminating`);
        // Settlement is deferred to terminateTree: the caller must not resume while a
        // descendant that ignored SIGTERM is still running, or it overlaps whatever
        // starts next (the following matrix entry, the replacement opencode).
        terminateTree(child).then(({ confirmed }) => {
          if (!confirmed) {
            emit('log', `warning: ${cmd} did not exit after SIGKILL; proceeding without confirming its process tree is gone`);
          }
          settle(timeoutError());
        });
      }, opts.timeoutMs);
    }
    if (opts.heartbeatMs) {
      const t0 = Date.now();
      beat = setInterval(() => emit('log', `… ${cmd} still running (${Math.round((Date.now() - t0) / 1000)}s)`), opts.heartbeatMs);
      beat.unref && beat.unref();
    }

    // Decode UTF-8 once per stream rather than per chunk: a multi-byte character split
    // across a chunk boundary would otherwise become two replacement characters. A
    // mangled log line is cosmetic, but a mangled classifier input is an unparseable
    // JSON payload and a lost diagnostic.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // Diagnostics must never change how the agent runs: a throwing observer degrades to
    // "no diagnostics", never to "no run". Reported once per distinct failure so a
    // per-chunk fault can't flood the log.
    const warned = new Set<string>();
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e: any) {
        const msg = (e && e.message) || String(e);
        if (!warned.has(msg)) { warned.add(msg); emit('log', `warning: diagnostics failed (${msg})`); }
      }
    };

    // Stall detection. Only real child output counts as liveness — the heartbeat goes
    // out through `emit` and never reaches here, so there is no heartbeat text to
    // string-match away.
    let lastOutputAt = Date.now();
    let isStalled = false;
    if (opts.stallMs && opts.onStall) {
      const stallMs = opts.stallMs;
      const tick = Math.min(Math.max(Math.floor(stallMs / 5), 1000), 30000);
      stall = setInterval(() => {
        const silent = Date.now() - lastOutputAt;
        if (!isStalled && silent >= stallMs) {
          isStalled = true;
          guard(() => opts.onStall!(silent));
        }
      }, tick);
      stall.unref && stall.unref();
    }

    const feed = (stream: OutputStream, chunk: string) => {
      const silent = Date.now() - lastOutputAt;
      lastOutputAt = Date.now();
      if (isStalled) {
        isStalled = false;
        if (opts.onResume) guard(() => opts.onResume!(silent));
      }
      if (opts.onOutput) guard(() => opts.onOutput!(stream, chunk));
      emit('log', chunk.trimEnd());
    };
    child.stdout?.on('data', (d: string) => feed('stdout', d));
    child.stderr?.on('data', (d: string) => feed('stderr', d));

    child.on('error', (e) => settle(e));
    child.on('close', (code) => {
      // On the timeout path the launcher's close proves nothing about its descendants,
      // so it must NOT settle — terminateTree does, once the tree is confirmed gone or
      // the bounded fallback expires. Either way settlement is guaranteed.
      if (timedOut) return;
      settle(code === 0 ? null : new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// Run a command to completion and resolve with its captured stdout (for tools
// like `opencode stats` whose output we want to return rather than stream).
//
// `detached: true` is required, not incidental: without its own process group the
// negative-pid send in killTree fails and falls back to signalling the launcher alone,
// leaving the real work running — the exact bug the timeout is meant to prevent.
export function capture(
  cmd: string, argv: string[], cwd: string,
  env?: Record<string, string> | null,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd, env: { ...process.env, ...(env || {}) }, detached: true,
    });
    let out = '', err = '', settled = false, timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const timeoutError = (): ProcError => {
      const e: ProcError = new Error(`${cmd} timed out after ${timeoutMs}ms`);
      e.timedOut = true;
      return e;
    };
    const settle = (e: Error | null, value = '') => {
      if (settled) return;
      settled = true;
      cleanup();
      if (e) reject(e); else resolve(value);
    };
    // Same single-settlement discipline as run(), and for the same reason: rejecting in
    // the tick the signal is sent resolves the caller while the process tree is still
    // alive. This call site is the post-agent `opencode stats`, which runs on the FAILURE
    // path — leaving descendants alive during failure recovery is how a dying entry
    // poisons the next one.
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateTree(child).then(() => settle(timeoutError()));
      }, timeoutMs);
      timer.unref && timer.unref();
    }
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => settle(e));
    child.on('close', (code) => {
      // Same rule as run(): on the timeout path terminateTree owns settlement.
      if (timedOut) return;
      code === 0 ? settle(null, out) : settle(new Error(err.trim() || `${cmd} exited with code ${code}`));
    });
  });
}
