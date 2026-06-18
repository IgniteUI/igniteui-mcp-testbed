'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { RunConfig, StoredConfig, HistoryRecord, Stats, Screenshot } from './types.ts';

// Persistent, cross-container run store. This lives OUTSIDE /work (which is a fresh
// per-session bind mount) so records survive container teardown — see run.sh's second
// mount. Each run is one JSON file, written atomically (tmp + rename).
let HISTORY_DIR = process.env.HISTORY_DIR || path.join(process.env.WORK_DIR || '/work', 'history');

export function setDir(dir: string): void { HISTORY_DIR = dir; }

function ensureDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function recordPath(id: string): string {
  return path.join(HISTORY_DIR, `run-${id}.json`);
}

function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('Z', '');
}

function newId(startedAt: string): string {
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${compactStamp(startedAt)}-${suffix}`;
}

// Build the stored config, dropping the API key and normalizing the model to an array
// (it grows as /api/model switches models within one run).
export function redact(cfg?: Partial<RunConfig> | null): StoredConfig {
  const c = cfg || {};
  return {
    framework: c.framework || null,
    projectType: c.projectType || '',
    theme: c.theme || '',
    enabledMcps: Array.isArray(c.enabledMcps) ? c.enabledMcps.slice() : [],
    skills: !!c.skills,
    excludedSkills: Array.isArray(c.excludedSkills) ? c.excludedSkills.slice() : [],
    models: c.model ? [c.model] : [],
    customBaseUrl: c.customBaseUrl || null,
  };
}

function writeAtomic(id: string, record: HistoryRecord): void {
  try {
    ensureDir();
    const p = recordPath(id);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, p);
  } catch (_) {}
}

function read(id: string): HistoryRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Apply a mutation to an existing record and persist it. No-op if it's gone.
function update(id: string, fn: (r: HistoryRecord) => void): HistoryRecord | null {
  const record = read(id);
  if (!record) return null;
  fn(record);
  writeAtomic(id, record);
  return record;
}

export interface CreateOpts {
  startedAt?: string;
  mode?: HistoryRecord['mode'];
  prompt?: string | null;
  matrixId?: string | null;
}

export function createRecord(cfg?: Partial<RunConfig> | null, opts: CreateOpts = {}): string {
  const startedAt = opts.startedAt || new Date().toISOString();
  const id = newId(startedAt);
  const record: HistoryRecord = {
    id,
    startedAt,
    finishedAt: null,
    durationMs: null,
    status: 'running',
    error: null,
    rating: null,
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

export interface FinishOpts {
  status?: string;
  error?: string | null;
  completed?: string[];
  timings?: Record<string, number>;
  finishedAt?: string;
  screenshots?: Screenshot[];
  logs?: string[];
}

export function finish(id: string, { status, error, completed, timings, finishedAt, screenshots, logs }: FinishOpts = {}): HistoryRecord | null {
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

export function updateStats(id: string | null, snapshot: Stats | null): HistoryRecord | null {
  if (!id || !snapshot) return null;
  return update(id, (r) => { r.stats = snapshot; });
}

export function addModel(id: string | null, model: string): HistoryRecord | null {
  if (!id || !model) return null;
  return update(id, (r) => {
    if (!r.config.models.includes(model)) r.config.models.push(model);
  });
}

export function updateRating(id: string, rating: number | null): HistoryRecord | null {
  return update(id, (r) => { r.rating = rating; });
}

export function list(): HistoryRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(HISTORY_DIR);
  } catch (_) {
    return [];
  }
  const records: HistoryRecord[] = [];
  for (const f of files) {
    if (!/^run-.*\.json$/.test(f)) continue;
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8')));
    } catch (_) {}
  }
  records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return records;
}

export function get(id: string): HistoryRecord | null {
  return read(id);
}

// Delete a run record. Returns true if a file was removed. Artifacts (screenshots)
// live outside the history dir, so the caller (src/routes/history.js) cleans those separately.
export function remove(id: string): boolean {
  try { fs.unlinkSync(recordPath(id)); return true; } catch (_) { return false; }
}

// A record left as 'running' can only be stale once the process that owned it is
// gone — a container that stopped mid-run, or a crash before finish() ran. Run this
// once at startup (before any new run begins) to settle those into 'interrupted'.
export function reapStale(): number {
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
