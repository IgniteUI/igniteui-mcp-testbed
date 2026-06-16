'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { LOG_DIR } = require('../config');
const { killTree } = require('./exec');

// Long-lived child processes for this session (one app, one opencode).
const procs = { app: null, opencode: null };

// Spawn a long-running watcher; tee its output to a log file. `detached:true` puts
// it in its own process group so killWatcher can take down the WHOLE tree — `npm run
// start` doesn't forward SIGTERM to its Vite/node child, which would otherwise orphan
// the dev server still bound to APP_PORT and let the next matrix entry screenshot it.
function spawnWatcher(name, cmd, argv, cwd, extraEnv) {
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
function killWatcher(name) {
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

module.exports = { procs, spawnWatcher, killWatcher };
