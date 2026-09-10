'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { LOG_DIR } from '../config.ts';
import { terminateTree } from './exec.ts';
import type { OutputStream } from './exec.ts';

export type WatcherName = 'app' | 'opencode';

// Long-lived child processes for this session (one app, one opencode).
export const procs: Record<WatcherName, ChildProcess | null> = { app: null, opencode: null };

// Spawn a long-running watcher; tee its output to a log file. `detached:true` puts
// it in its own process group so killWatcher can take down the WHOLE tree — `npm run
// start` doesn't forward SIGTERM to its Vite/node child, which would otherwise orphan
// the dev server still bound to APP_PORT and let the next matrix entry screenshot it.
export interface WatcherOpts {
  env?: Record<string, string>;
  /**
   * Observe the watcher's output as it streams. Supplying this switches stdio from a
   * direct fd redirect to pipes that are TEED — the log file still receives everything,
   * byte for byte, and the callback additionally sees each chunk tagged with its stream.
   *
   * Opt-in per watcher on purpose. The redirect form hands the fd to the child and the
   * OS does the rest, which keeps writing even if this process dies; piping routes the
   * output through here instead, so the app dev server (which nothing observes) keeps
   * the simpler, more robust arrangement it has always had.
   */
  onOutput?: ((stream: OutputStream, chunk: string) => void) | null;
  /**
   * Called once the watcher has closed, after its final chunk. An observer that reassembles
   * lines MUST flush here: the last line a dying process writes often has no trailing
   * newline (exactly where a provider error lands), and a buffer left unflushed does not
   * merely lose it — it survives into the *next* watcher and concatenates with its first
   * chunk, which for a model switch means fusing two processes' output into one bogus line.
   */
  onClose?: (() => void) | null;
}

export function spawnWatcher(
  name: WatcherName,
  cmd: string,
  argv: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
  opts: WatcherOpts = {},
): ChildProcess {
  const logPath = path.join(LOG_DIR, `${name}.log`);
  const env = { ...process.env, ...extraEnv, ...(opts.env || {}) };

  if (!opts.onOutput) {
    const out = fs.openSync(logPath, 'a');
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', out, out], detached: true });
    procs[name] = child;
    return child;
  }

  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  // Decode once per stream (see run() in exec.ts): decoding per chunk corrupts any
  // multi-byte character that straddles a chunk boundary, and a mangled classifier input
  // is an unparseable payload rather than a merely ugly log line.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  const tee = (stream: OutputStream) => (chunk: string) => {
    try { log.write(chunk); } catch (_) {}
    // An observer must never be able to take down the watcher it is watching.
    try { opts.onOutput!(stream, chunk); } catch (_) {}
  };
  child.stdout?.on('data', tee('stdout'));
  child.stderr?.on('data', tee('stderr'));
  child.once('close', () => {
    try { log.end(); } catch (_) {}
    if (opts.onClose) { try { opts.onClose(); } catch (_) {} }
  });
  procs[name] = child;
  return child;
}

// SIGTERM the watcher and resolve only once its whole TREE has gone (SIGKILL after a
// grace period, then a bounded wait). Awaiting this before deleting the project dir
// matters: a still-dying dev server holds file handles, which makes rmSync throw
// ENOTEMPTY/EBUSY on the Windows<->Podman bind mount.
//
// It resolved on the launcher's `close` before — which for `npm run start` is the npm
// wrapper, not the Vite server still bound to the port. That let the next matrix entry,
// or the replacement opencode after a model switch, start against a live survivor.
// terminateTree resolves only on confirmed tree death or its bounded fallback, and costs
// nothing extra in the ordinary case where the launcher's exit really does end the tree.
export async function killWatcher(name: WatcherName): Promise<void> {
  const child = procs[name];
  procs[name] = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await terminateTree(child);
}
