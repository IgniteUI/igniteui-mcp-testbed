'use strict';

const fs = require('fs');
const path = require('path');

// Persistent, cross-container run store. This lives OUTSIDE /work (which is a fresh
// per-session bind mount) so records survive container teardown — see run.sh's second
// mount. Each run is one JSON file, written atomically (tmp + rename).
let HISTORY_DIR = process.env.HISTORY_DIR || path.join(process.env.WORK_DIR || '/work', 'history');

function setDir(dir) { HISTORY_DIR = dir; }

function ensureDir() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function recordPath(id) {
  return path.join(HISTORY_DIR, `run-${id}.json`);
}

function compactStamp(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('Z', '');
}

function newId(startedAt) {
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${compactStamp(startedAt)}-${suffix}`;
}

// Build the stored config, dropping the API key and normalizing the model to an array
// (it grows as /api/model switches models within one run).
function redact(cfg) {
  cfg = cfg || {};
  return {
    framework: cfg.framework || null,
    projectType: cfg.projectType || '',
    theme: cfg.theme || '',
    enabledMcps: Array.isArray(cfg.enabledMcps) ? cfg.enabledMcps.slice() : [],
    skills: !!cfg.skills,
    excludedSkills: Array.isArray(cfg.excludedSkills) ? cfg.excludedSkills.slice() : [],
    models: cfg.model ? [cfg.model] : [],
    customBaseUrl: cfg.customBaseUrl || null,
  };
}

function writeAtomic(id, record) {
  try {
    ensureDir();
    const p = recordPath(id);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, p);
  } catch (_) {}
}

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Apply a mutation to an existing record and persist it. No-op if it's gone.
function update(id, fn) {
  const record = read(id);
  if (!record) return null;
  fn(record);
  writeAtomic(id, record);
  return record;
}

function createRecord(cfg, opts = {}) {
  const startedAt = opts.startedAt || new Date().toISOString();
  const id = newId(startedAt);
  const record = {
    id,
    startedAt,
    finishedAt: null,
    durationMs: null,
    status: 'running',
    error: null,
    mode: opts.mode || 'interactive', // 'interactive' | 'matrix'
    prompt: opts.prompt || null, // the one-shot instruction (matrix mode)
    matrixId: opts.matrixId || null, // groups entries of one matrix submission
    config: redact(cfg),
    stages: { completed: [], timings: {} },
    stats: null,
    screenshots: [], // [{ route, file, ok, error }]
    logs: [], // streamed pipeline log lines, retained for post-run inspection
  };
  writeAtomic(id, record);
  return id;
}

function finish(id, { status, error, completed, timings, finishedAt, screenshots, logs } = {}) {
  return update(id, (r) => {
    r.status = status || 'success';
    r.error = error || null;
    r.finishedAt = finishedAt || new Date().toISOString();
    r.durationMs = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    if (Array.isArray(completed)) r.stages.completed = completed.slice();
    if (timings) r.stages.timings = timings;
    if (Array.isArray(screenshots)) r.screenshots = screenshots;
    if (Array.isArray(logs)) r.logs = logs.slice();
  });
}

function updateStats(id, snapshot) {
  if (!id || !snapshot) return null;
  return update(id, (r) => { r.stats = snapshot; });
}

function addModel(id, model) {
  if (!model) return null;
  return update(id, (r) => {
    if (!r.config.models.includes(model)) r.config.models.push(model);
  });
}

function list() {
  let files;
  try {
    files = fs.readdirSync(HISTORY_DIR);
  } catch (_) {
    return [];
  }
  const records = [];
  for (const f of files) {
    if (!/^run-.*\.json$/.test(f)) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8')));
    } catch (_) {}
  }
  records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return records;
}

function get(id) {
  return read(id);
}

// Delete a run record. Returns true if a file was removed. Artifacts (screenshots)
// live outside the history dir, so the caller (src/routes/history.js) cleans those separately.
function remove(id) {
  try { fs.unlinkSync(recordPath(id)); return true; } catch (_) { return false; }
}

// A record left as 'running' can only be stale once the process that owned it is
// gone — a container that stopped mid-run, or a crash before finish() ran. Run this
// once at startup (before any new run begins) to settle those into 'interrupted'.
function reapStale() {
  const now = new Date().toISOString();
  let reaped = 0;
  for (const r of list()) {
    if (r.status !== 'running') continue;
    update(r.id, (rec) => {
      rec.status = 'interrupted';
      rec.error = rec.error || 'interrupted — container stopped or run aborted before completion';
      rec.finishedAt = rec.finishedAt || now;
      rec.durationMs = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
    });
    reaped++;
  }
  return reaped;
}

module.exports = {
  setDir, redact, createRecord, finish, updateStats, addModel, list, get, remove, reapStale,
};
