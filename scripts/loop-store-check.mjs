#!/usr/bin/env node
// Detector C's store reader, against opencode's REAL `part` schema.
//
// The fixture gate drives the collector through an injected stub, which proves the
// lifecycle but never touches SQLite. The corpus replay reads 72 real stores but can
// only prove the NEGATIVE (no false positives). This file closes the gap: a store built
// with opencode's actual schema, containing an actual loop, must actually be caught.
// Deterministic, dependency-free (node:sqlite is built in) and self-cleaning, so it is
// part of the gate rather than a manual check.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { recentCalls, detectLoop } from '../src/capture/loop.ts';

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + n + (x ? '  ' + x : '')); if (!c) fails++; };

function makeStore(parts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loopdb-'));
  const dir = path.join(root, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE `part` (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL)');
  const ins = db.prepare('insert into part (id, message_id, session_id, time_created, time_updated, data) values (?,?,?,?,?,?)');
  parts.forEach((p, i) => ins.run(String(i), 'm', 's', 1000 + i, 1000 + i, JSON.stringify(p)));
  db.close();
  return root;
}

const toolPart = (tool, input, t) => ({
  type: 'tool', tool, callID: 'c' + t,
  state: { status: 'completed', input, time: { start: 1000 + t, end: 1001 + t } },
});

// 1. A straight repeat through the real reader.
{
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(toolPart('read', { path: 'a' + i }, parts.length));
  for (let i = 0; i < 6; i++) parts.push(toolPart('igniteui-cli_get_doc', { q: 'grid' }, parts.length));
  const dir = makeStore(parts);
  const calls = await recentCalls(dir, 0);
  ok('reader parses the real schema', calls?.length === 9, JSON.stringify(calls?.length));
  ok('non-tool rows would be excluded (all rows here are tools)', calls.every((c) => c.tool));
  const hit = detectLoop(calls, 5);
  ok('a straight repeat is detected through SQLite', hit?.shape === 'repeat' && hit.tool === 'igniteui-cli_get_doc',
    JSON.stringify(hit));
  ok('reps counted correctly', hit?.reps === 6, String(hit?.reps));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. Same tool, DIFFERENT inputs is progress, not a loop — the case that separates this
//    detector from a naive "same tool N times" counter.
{
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(toolPart('edit', { path: 'src/a.ts', body: 'v' + i }, i));
  const dir = makeStore(parts);
  const calls = await recentCalls(dir, 0);
  ok('same tool with differing inputs is not a loop', detectLoop(calls, 5) === null);
  ok('and their fingerprints really do differ', new Set(calls.map((c) => c.fingerprint)).size === 8);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. A read->edit cycle through the real reader.
{
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(toolPart('read', { path: 'x.ts' }, parts.length));
    parts.push(toolPart('edit', { path: 'x.ts', body: 'same' }, parts.length));
  }
  const dir = makeStore(parts);
  const hit = detectLoop(await recentCalls(dir, 0), 5);
  ok('a 2-step cycle is detected through SQLite', hit?.shape === 'cycle' && hit.tool === 'read+edit', JSON.stringify(hit));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. `since` scopes the read, so a shared store cannot leak a previous run's calls.
{
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(toolPart('old', { q: 1 }, i));
  const dir = makeStore(parts);
  const all = await recentCalls(dir, 0);
  const scoped = await recentCalls(dir, 1004);
  ok('since filters older calls out', all.length === 6 && scoped.length === 2,
    `all=${all.length} scoped=${scoped.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5. Non-tool parts (text, reasoning, step-finish) must be ignored — they are the bulk
//    of a real store.
{
  const parts = [
    { type: 'text', text: 'hello' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'step-finish' },
    toolPart('read', { p: 1 }, 3),
  ];
  const dir = makeStore(parts);
  const calls = await recentCalls(dir, 0);
  ok('non-tool parts are ignored', calls.length === 1 && calls[0].tool === 'read', JSON.stringify(calls));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. A missing store is null ("no data"), never an empty array ("no loop").
{
  ok('a missing store returns null, not []', (await recentCalls(path.join(os.tmpdir(), 'nope-' + Date.now()), 0)) === null);
}

console.log(fails ? `\n${fails} FAILED` : '\nSQLite path verified');
process.exit(fails ? 1 : 0);
