'use strict';

const history = require('./history');
const { StatsCollector } = require('./stats');
const { OPENCODE_PORT, WORK } = require('./config');
const { createSSE } = require('./stream/sse');

// SSE registries for the interactive run progress and the live stats feed.
const runSSE = createSSE();
const statsSSE = createSSE();

let lastConfig = null;   // remembered so /api/model can rebuild opencode.json
let currentRunId = null; // history record id for the current/last run
let stats = null;        // live StatsCollector for the current session

// Progress of the current/last pipeline run, so a wizard that reconnects mid-run
// can re-attach and follow it to completion.
let runState = { phase: 'idle', step: null, completed: [], logs: [], result: null, error: null };

function publicRunState() {
  return {
    phase: runState.phase, step: runState.step,
    completed: runState.completed.slice(),
    logs: runState.logs.slice(-200),
    result: runState.result, error: runState.error,
  };
}

// Update runState from one pipeline event and fan it out to re-attach listeners.
function recordRun(obj) {
  if (obj.type === 'step') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = obj.step;
    runState.phase = 'running';
  } else if (obj.type === 'log') {
    runState.logs.push(obj.msg);
    if (runState.logs.length > 1000) runState.logs.shift();
  } else if (obj.type === 'error') {
    runState.phase = 'error';
    runState.error = obj.msg;
  } else if (obj.type === 'done') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = null;
    runState.phase = 'done';
    runState.result = obj;
  }
  runSSE.broadcast(obj);
}

function startStats(cfg) {
  if (stats) stats.stop();
  stats = new StatsCollector({
    port: OPENCODE_PORT,
    dir: WORK,
    model: cfg.model,
    costAvailable: !cfg.customBaseUrl,
  });
  stats.onUpdate((snap) => {
    history.updateStats(currentRunId, snap);
    statsSSE.broadcast(snap);
  });
  stats.onWarn((msg) => console.error(msg));
  stats.start();
}

// Begin a fresh interactive run: reset progress state, remember the config, and
// open its history record. Returns the new run id.
function beginRun(cfg) {
  runState = { phase: 'running', step: null, completed: [], logs: [], result: null, error: null };
  lastConfig = cfg;
  currentRunId = history.createRecord(cfg);
  return currentRunId;
}

module.exports = {
  runSSE, statsSSE,
  publicRunState, recordRun, startStats, beginRun,
  getRunState: () => runState,
  getCurrentRunId: () => currentRunId,
  getLastConfig: () => lastConfig,
  getStats: () => stats,
};
