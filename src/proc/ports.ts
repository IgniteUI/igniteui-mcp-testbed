'use strict';

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { LOG_DIR } from '../config.ts';
import type { Emit } from '../types.ts';

export interface AppReady {
  ready: boolean;
  reason?: string;
  tail?: string;
}

// Resolve true once nothing is listening on `port` (or false on timeout). Used
// before launching an entry's dev server so we never screenshot a previous entry's
// stale server that's still holding the fixed port.
export function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 400);
      });
      sock.once('error', () => { sock.destroy(); resolve(true); });
    };
    attempt();
  });
}

// Resolve when a TCP port accepts a connection, or reject on timeout.
export function waitForPort(port: number, timeoutMs: number, emit?: Emit): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} not ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 800);
        }
      });
    };
    attempt();
  });
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
function tailLines(s: string, n: number): string {
  const lines = stripAnsi(s).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

// Terminal build-failure markers per dev server. Post-agent the source is static,
// so the first build is final: a failed build never recovers, no point waiting.
export const BUILD_FAILED_RE = /(Application bundle generation failed|The build failed|dotnet watch ❌|Waiting for a file to change before restarting|is already in use|address already in use|EADDRINUSE|error when starting dev server)/i;

// Wait until the dev server is actually serving, or it's clear the build failed —
// whichever comes first. Reads only the bytes appended to <name>.log since spawn
// (the file is shared across matrix entries). Returns { ready, reason, tail }.
export function waitForAppReady(
  port: number,
  timeoutMs: number,
  logName: string,
  startOffset: number,
  child: ChildProcess | null,
  emit?: Emit,
): Promise<AppReady> {
  const logPath = path.join(LOG_DIR, `${logName}.log`);
  const deadline = Date.now() + timeoutMs;
  const freshLog = () => {
    try { return fs.readFileSync(logPath).subarray(startOffset).toString(); } catch (_) { return ''; }
  };
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve({ ready: true }); });
      sock.once('error', () => {
        sock.destroy();
        const fresh = freshLog();
        if (child && child.exitCode !== null) {
          return resolve({ ready: false, reason: `dev server exited (code ${child.exitCode})`, tail: tailLines(fresh, 40) });
        }
        if (BUILD_FAILED_RE.test(fresh)) {
          return resolve({ ready: false, reason: 'build failed', tail: tailLines(fresh, 40) });
        }
        if (Date.now() > deadline) {
          return resolve({ ready: false, reason: `not ready within ${timeoutMs}ms`, tail: tailLines(fresh, 40) });
        }
        setTimeout(attempt, 800);
      });
    };
    attempt();
  });
}
