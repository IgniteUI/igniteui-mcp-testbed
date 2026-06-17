'use strict';

import { spawn, type ChildProcess } from 'child_process';
import type { Emit } from '../types.ts';

export interface RunOpts {
  env?: Record<string, string>;
  timeoutMs?: number;
  heartbeatMs?: number;
  onChild?: ((child: ChildProcess) => void) | null;
}

// Signal a child's whole process group (negative pid) so its descendants die too,
// not just the launcher. Falls back to the direct child if the group send fails.
export function killTree(child: ChildProcess | null | undefined, sig: NodeJS.Signals): void {
  if (!child) return;
  try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
  catch (_) { try { child.kill(sig); } catch (_) {} }
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
    const cleanup = () => { if (timer) clearTimeout(timer); if (beat) clearInterval(beat); };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        cleanup();
        killTree(child, 'SIGTERM');
        reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    if (opts.heartbeatMs) {
      const t0 = Date.now();
      beat = setInterval(() => emit('log', `… ${cmd} still running (${Math.round((Date.now() - t0) / 1000)}s)`), opts.heartbeatMs);
      beat.unref && beat.unref();
    }
    child.stdout?.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.stderr?.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      cleanup();
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// Run a command to completion and resolve with its captured stdout (for tools
// like `opencode stats` whose output we want to return rather than stream).
export function capture(cmd: string, argv: string[], cwd: string, env?: Record<string, string> | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...(env || {}) } });
    let out = '', err = '';
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with code ${code}`)));
  });
}
