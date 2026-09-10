'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// Detector C's store reader.
//
// It shares src/capture/tool-usage.ts's *discipline* — the same lazily-imported
// `node:sqlite`, the same read-only open (opencode may still hold the db open; we must
// never take a write lock on its store), the same skip-don't-queue rule for overlapping
// reads — but deliberately NOT its aggregator, for two reasons:
//
//  - `ToolEvent` carries no input, so `(tool, normalized input)` repetition simply is
//    not computable from it. Repetition is the entire signal here.
//  - `tool-usage.ts` retains the FIRST 500 events and discards the rest, so a detector
//    reading "the tail" would get a frozen prefix once a run passes 500 calls — exactly
//    when a loop becomes worth detecting.

const DB_REL = path.join('opencode', 'opencode.db');

/** How many of the newest calls to pull. Bounded: this runs on a timer, mid-run. */
export const LOOP_TAIL = 200;

export interface RecentCall {
  at: number;
  tool: string;
  /** Hash of the canonicalized tool input. Inputs are hashed, never stored, so a prompt
   * or file body can never land in a history record. */
  fingerprint: string;
}

// Stable canonical form: object keys sorted at every depth, arrays kept in order.
// Two calls with the same input must hash identically regardless of key order.
function canonical(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/**
 * Hash the COMPLETE canonical input — never a truncated one.
 *
 * Truncating before hashing collapses any two inputs sharing a prefix into one
 * fingerprint, and tool inputs are exactly the kind of data that shares long prefixes:
 * two `write` calls to the same path with different bodies, two `edit`s whose payloads
 * begin with the same imports. That would manufacture a loop out of ordinary sequential
 * work, in the detector whose whole job is telling repetition from progress. Truncation
 * belongs only in the `detail` string shown as evidence, which is never compared.
 */
export function fingerprintInput(input: unknown): string {
  return createHash('sha1').update(canonical(input ?? null)).digest('hex').slice(0, 16);
}

/**
 * The newest `limit` tool calls at or after `since`, in CHRONOLOGICAL order.
 *
 * `DESC` in the query is how you get the *newest* N out of the store; it is not the
 * order the detector reasons in, so the window is returned oldest-first — analysing the
 * descending array directly would invert every cycle it looks for.
 *
 * The window is then sorted by the tool's own `state.time.start` rather than left in
 * `time_created` order. The two nearly agree, but not exactly: across the 72 stored
 * runs, 3 of 1200 adjacent pairs are inverted (up to 13.5s apart), because a part row
 * is not necessarily written in the order its tool call started. The detector reasons
 * purely about sequence, so feeding it the actual call order matters; `start` is present
 * on every tool part in the corpus, and `time_created` remains the fallback.
 *
 * Returns null when the store can't be read at all, so the caller can tell "no loop"
 * from "no data" rather than reporting an all-clear it never established.
 */
export async function recentCalls(
  dataDir: string, since: number, limit: number = LOOP_TAIL,
): Promise<RecentCall[] | null> {
  const dbPath = path.join(dataDir, DB_REL);
  if (!fs.existsSync(dbPath)) return null;
  let DatabaseSync: any;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (_) { return null; }
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (_) {
    return null;
  }
  try {
    const rows = db
      .prepare('select time_created, data from part where time_created >= ? order by time_created desc limit ?')
      .all(since, limit) as Array<{ time_created: number; data: string }>;

    const calls: RecentCall[] = [];
    for (const row of rows) {
      let part: any;
      try { part = JSON.parse(String(row.data)); } catch (_) { continue; }
      if (!part || part.type !== 'tool' || !part.tool) continue;
      const state = part.state || {};
      const start = state.time && state.time.start;
      calls.push({
        at: Number(start) || Number(row.time_created) || 0,
        tool: String(part.tool),
        fingerprint: fingerprintInput(state.input),
      });
    }
    // Stable sort, so ties keep the store's own insertion order.
    return calls.sort((a, b) => a.at - b.at);
  } catch (_) {
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

// ── Detection ─────────────────────────────────────────────────────────────────

export interface LoopHit {
  /** Dedup identity: the tool, or the cycle's tools joined by '+'. */
  tool: string;
  shape: 'repeat' | 'cycle';
  /** Cycle length (1 for a straight repeat). */
  period: number;
  /** How many back-to-back repetitions run to the newest call. */
  reps: number;
}

// NUL-delimited so a tool name can never run into the fingerprint and fake a match.
// Written as an ESCAPE, never as a literal control byte: a raw NUL in the source makes
// git classify this file as binary, which silently costs every diff, blame and review.
const key = (c: RecentCall): string => `${c.tool}\0${c.fingerprint}`;

/**
 * Is the agent looping *now*?
 *
 * Both rules are anchored at the END of the array, deliberately. The question is not
 * "did it ever repeat itself in the last 200 calls" — an agent that thrashed five times
 * and then moved on is working, not stuck, and reporting that as a live loop trains the
 * user to ignore the warning.
 *
 *  - a straight repeat: the last `repeats` calls are all the same (tool, fingerprint)
 *  - a cycle: the suffix decomposes into 2–4 DISTINCT (tool, fingerprint) pairs repeated
 *    back to back at least `minCycleReps` times, running to the newest call
 */
export function detectLoop(
  calls: RecentCall[] | null,
  repeats = 5,
  minCycleReps = 3,
): LoopHit | null {
  if (!calls || calls.length < 2) return null;
  const keys = calls.map(key);
  const n = keys.length;

  // Rule 1 — straight repeat.
  if (repeats >= 2 && n >= repeats) {
    const last = keys[n - 1];
    let same = 1;
    while (same < n && keys[n - 1 - same] === last) same++;
    if (same >= repeats) {
      return { tool: calls[n - 1].tool, shape: 'repeat', period: 1, reps: same };
    }
  }

  // Rule 2 — cycle of 2..4 distinct pairs.
  for (let period = 2; period <= 4; period++) {
    if (n < period * minCycleReps) continue;
    const block = keys.slice(n - period);
    // A block with a duplicate is not a cycle of distinct pairs; a straight repeat is
    // rule 1's business, and admitting it here would double-report.
    if (new Set(block).size !== period) continue;
    let reps = 0;
    for (let start = n - period; start >= 0; start -= period) {
      let match = true;
      for (let j = 0; j < period; j++) {
        if (keys[start + j] !== block[j]) { match = false; break; }
      }
      if (!match) break;
      reps++;
    }
    if (reps >= minCycleReps) {
      // Stable across episodes of the same cycle, which is what the dedup key needs:
      // an agent that loops on read→edit→read, recovers, and does it again is one story.
      const tools = [...new Set(calls.slice(n - period).map((c) => c.tool))].join('+');
      return { tool: tools, shape: 'cycle', period, reps };
    }
  }

  return null;
}
