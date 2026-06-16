'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('../config');

// Resolve true once nothing is listening on `port` (or false on timeout). Used
// before launching an entry's dev server so we never screenshot a previous entry's
// stale server that's still holding the fixed port.
function waitForPortFree(port, timeoutMs) {
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
function waitForPort(port, timeoutMs, emit) {
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

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function tailLines(s, n) {
  const lines = stripAnsi(s).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

// Terminal build-failure markers per dev server. Post-agent the source is static,
// so the first build is final: a failed build never recovers, no point waiting.
const BUILD_FAILED_RE = /(Application bundle generation failed|The build failed|dotnet watch ❌|Waiting for a file to change before restarting|is already in use|address already in use|EADDRINUSE|error when starting dev server)/i;

// Wait until the dev server is actually serving, or it's clear the build failed —
// whichever comes first. Reads only the bytes appended to <name>.log since spawn
// (the file is shared across matrix entries). Returns { ready, reason, tail }.
function waitForAppReady(port, timeoutMs, logName, startOffset, child, emit) {
  const logPath = path.join(LOG_DIR, `${logName}.log`);
  const deadline = Date.now() + timeoutMs;
  const freshLog = () => {
    try { return fs.readFileSync(logPath).slice(startOffset).toString(); } catch (_) { return ''; }
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

module.exports = { waitForPort, waitForPortFree, waitForAppReady, BUILD_FAILED_RE };
