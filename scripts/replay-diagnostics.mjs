#!/usr/bin/env node
// Run the diagnostics classifier over every stored history record and print what it
// finds. OBSERVATIONAL, not a gate — treat a change in its output as a prompt to look,
// never as a build failure. `npm run diagnostics:test` is the gate.
//
// Two limitations, stated rather than papered over:
//
//  1. Stored `logs` are a MERGED stdout+stderr stream (run() funnelled both into one
//     emit at capture time), so replay cannot exercise the stream-isolation guard and
//     will over-report relative to live behaviour. Everything here is scanned as if it
//     were stderr.
//  2. Entry logs are capped at ENTRY_LOG_CAP (800) with a FIFO shift, so for a run that
//     exceeded it an early provider error is simply not on disk any more. Live detection
//     is unaffected — it classifies at emit time, before the cap applies.
//
// Expected result today: exactly one hit, run-20260813T113807-b1d9, provider-down. If
// the ANSI strip is ever dropped this prints ZERO hits everywhere — which is precisely
// the failure that would look like "no false positives" while matching nothing at all.

import fs from 'fs';
import path from 'path';
import { parseProviderError, isToolFailureLabel } from '../src/capture/diagnostics.ts';
import { recentCalls, detectLoop } from '../src/capture/loop.ts';

const explicit = process.argv[2];
const dir = explicit || path.join('sessions', 'history');
if (!fs.existsSync(dir)) {
  // A path the caller named and got wrong is an error; the default simply being absent
  // is the normal state of a fresh clone (sessions/ is gitignored run data), and this is
  // an observational tool, not a gate — reporting "nothing to replay" is the honest answer.
  if (explicit) {
    console.error(`no history dir at ${dir}`);
    process.exit(2);
  }
  console.log(`no run history at ${dir} — nothing to replay (run a matrix first)`);
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)).sort();
let scannedLines = 0, hits = 0, suppressed = 0;
const byKind = new Map();

for (const f of files) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  // A stored log ENTRY is one emit chunk and routinely holds several physical lines
  // (26% of the corpus does). Splitting is what the live framer does; skipping it here
  // would silently under-report.
  const lines = (rec.logs || []).flatMap((l) => String(l).split(/\r\n|\n|\r/));
  let prev = '';
  for (const line of lines) {
    scannedLines++;
    const afterToolFailure = isToolFailureLabel(prev);
    prev = line;
    const info = parseProviderError(line);
    if (!info) continue;
    if (afterToolFailure) { suppressed++; continue; }
    hits++;
    byKind.set(info.kind, (byKind.get(info.kind) || 0) + 1);
    console.log(`${f}\n  ${info.kind} (code ${info.code}) — ${info.message}\n  ${info.detail}\n`);
  }
}

console.log(`scanned ${files.length} records, ${scannedLines} lines`);
console.log(`hits: ${hits}${byKind.size ? ' — ' + [...byKind].map(([k, n]) => `${k}:${n}`).join(', ') : ''}`);
if (suppressed) console.log(`suppressed ${suppressed} payload(s) following an MCP tool failure`);

// ── Detector C, against the real opencode stores kept under sessions/ ─────────
//
// Unlike the log replay above, this exercises the REAL code path end to end: the same
// SQLite reader, the same fingerprinting, the same cycle rules the live poller uses.
// The stores are per-entry leftovers from past matrix runs, so this is a genuine
// false-positive check — every loop reported here is one a real run would have shown.

function findStores(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === 'opencode.db' && path.basename(dir) === 'opencode') out.push(path.dirname(dir));
    }
  };
  walk(root, 0);
  return out;
}

const stores = findStores('sessions');
if (!stores.length) {
  console.log('');
  console.log('no opencode stores under sessions/ — skipping the loop replay');
} else {
  let readable = 0, unreadable = 0, loops = 0, totalCalls = 0;
  for (const dir of stores) {
    const calls = await recentCalls(dir, 0);
    if (calls === null) { unreadable++; continue; }
    readable++;
    totalCalls += calls.length;
    const hit = detectLoop(calls, Number(process.env.AGENT_LOOP_REPEATS || 5));
    if (hit) {
      loops++;
      console.log('');
      console.log(`LOOP ${dir}`);
      console.log(`  ${hit.tool} — ${hit.shape}, period ${hit.period}, ${hit.reps}× to the newest call`);
    }
  }
  console.log('');
  console.log(`loop replay: ${readable} store(s) read (${unreadable} unreadable), ` +
    `${totalCalls} tool calls, ${loops} loop(s) detected`);
}
