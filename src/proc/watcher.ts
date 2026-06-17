'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { LOG_DIR } from '../config.ts';
import { killTree } from './exec.ts';

export type WatcherName = 'app' | 'opencode';

// Long-lived child processes for this session (one app, one opencode).
export const procs: Record<WatcherName, ChildProcess | null> = { app: null, opencode: null };

// Spawn a long-running watcher; tee its output to a log file. `detached:true` puts
// it in its own process group so killWatcher can take down the WHOLE tree — `npm run
// start` doesn't forward SIGTERM to its Vite/node child, which would otherwise orphan
// the dev server still bound to APP_PORT and let the next matrix entry screenshot it.
export function spawnWatcher(
  name: WatcherName,
  cmd: string,
  argv: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): ChildProcess {
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
    detached: true,
  });
  procs[name] = child;
  return child;
}

// SIGTERM the watcher and resolve only once it has actually exited (SIGKILL after
// a grace period). Awaiting this before deleting the project dir matters: a
// still-dying dev server holds file handles, which makes rmSync throw ENOTEMPTY/
// EBUSY on the Windows<->Podman bind mount.
export function killWatcher(name: WatcherName): Promise<void> {
  const child = procs[name];
  procs[name] = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('close', done);
    killTree(child, 'SIGTERM');
    const t = setTimeout(() => { killTree(child, 'SIGKILL'); done(); }, 4000);
    t.unref && t.unref();
  });
}
