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

// 5b. opencode 1.19 ships an EMPTY `session_message` table next to the `part` table it
//     actually writes to; picking the reader by table presence read nothing at all.
{
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(toolPart('igniteui-cli_get_doc', { q: i }, i));
  const dir = makeStore(parts);
  const db = new DatabaseSync(path.join(dir, 'opencode', 'opencode.db'));
  db.exec('CREATE TABLE `session_message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL)');
  db.close();
  const calls = await recentCalls(dir, 0);
  ok('1.19: an empty session_message does not shadow part', calls?.length === 3, JSON.stringify(calls?.length));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6. A missing store is null ("no data"), never an empty array ("no loop").
{
  ok('a missing store returns null, not []', (await recentCalls(path.join(os.tmpdir(), 'nope-' + Date.now()), 0)) === null);
}

// ── opencode 2.x: no `part` table; tool parts live inside `session_message.data.content[]`.
// Schema copied from a real 2.0.32 store.
const { collectToolUsage } = await import('../src/capture/tool-usage.ts');
const { openStore, readUsage } = await import('../src/capture/opencode-store.ts');

function makeStoreV2(messages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loopdb2-'));
  const dir = path.join(root, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE `session_v2` (`id` text PRIMARY KEY)');
  db.exec('CREATE TABLE `session_message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE)');
  db.prepare('insert into session_v2 (id) values (?)').run('s');
  const ins = db.prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?,?,?,?,?,?,?)');
  messages.forEach((m, i) => ins.run('m' + i, 's', m.type, i, 1000 + i * 10, 1000 + i * 10, JSON.stringify(m.data)));
  db.close();
  return root;
}
const tool2 = (name, input, t, extra = {}) => ({
  type: 'tool', id: 'c' + t, name,
  state: { status: 'completed', input, metadata: extra.metadata || {} },
  time: { created: 1000 + t, ran: 1001 + t, completed: 1003 + t },
});
const assistant = (content, extra = {}) => ({
  type: 'assistant',
  data: { model: { id: 'openai/gpt-6-luna', providerID: 'openrouter' }, content, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 100, write: 5 } }, cost: 0.01, ...extra },
});

// 7. A loop spread across several assistant messages is still one sequence.
{
  const msgs = [{ type: 'user', data: { text: 'go' } }];
  for (let i = 0; i < 6; i++) msgs.push(assistant([{ type: 'text', text: 'x' }, tool2('igniteui-cli_get_doc', { q: 'grid' }, i * 10)]));
  const dir = makeStoreV2(msgs);
  const calls = await recentCalls(dir, 0);
  ok('2.x: reader parses session_message', calls?.length === 6, JSON.stringify(calls?.length));
  const hit = detectLoop(calls, 5);
  ok('2.x: a straight repeat is detected through SQLite', hit?.shape === 'repeat' && hit.reps === 6, JSON.stringify(hit));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8. Tool usage: skill input is `{id}`, `shell` is a built-in, and Code Mode's `execute`
//    yields its inner MCP calls (but not its own `search` helper).
{
  const dir = makeStoreV2([
    assistant([tool2('skill', { id: 'igniteui-react-components' }, 0, { metadata: { name: 'igniteui-react-components' } })]),
    assistant([tool2('execute', { code: '…' }, 10, { metadata: { toolCalls: [
      { tool: 'search', status: 'completed', input: { query: 'grid' } },
      { tool: 'opencode.list_mcp_resources', status: 'completed', input: { server: 'igniteui-cli' } },
      { tool: 'igniteui-cli.get_doc', status: 'completed', input: { name: 'grid' } },
      { tool: 'igniteui-cli.resolve_import', status: 'error', input: {} },
    ] } })]),
    assistant([tool2('shell', { command: 'ls' }, 20)]),
  ]);
  const u = await collectToolUsage({ dataDir: dir, mcpServers: ['igniteui-cli', 'igniteui-theming'], skillNames: ['igniteui-react-components', 'other'] });
  ok('2.x usage: read from the db', u?.source === 'db', u?.source);
  ok('2.x usage: Code Mode MCP calls counted, search and opencode.* skipped', u?.mcpCalls === 2, String(u?.mcpCalls));
  ok('2.x usage: no phantom `opencode` server', !u?.servers.used.includes('opencode'), JSON.stringify(u?.servers.used));
  ok('2.x usage: inner MCP error counted', u?.errors === 1, String(u?.errors));
  ok('2.x usage: server marked used', JSON.stringify(u?.servers) === JSON.stringify({ configured: ['igniteui-cli', 'igniteui-theming'], used: ['igniteui-cli'], unused: ['igniteui-theming'] }), JSON.stringify(u?.servers));
  ok('2.x usage: skill name from input.id', u?.skills.used.join() === 'igniteui-react-components', JSON.stringify(u?.skills));
  ok('2.x usage: shell and execute are built-ins', u?.tools.filter((t) => t.kind === 'builtin').map((t) => t.name).sort().join() === 'execute,shell');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 9. Tokens/cost/models come from the messages (2.x `opencode stats` has no cost).
{
  const dir = makeStoreV2([
    { type: 'user', data: { text: 'go' } },
    assistant([]),
    assistant([], { model: { id: 'minimax-m3.1-flash-free', providerID: 'opencode' }, cost: 0 }),
  ]);
  const store = await openStore(dir);
  const u = readUsage(store, 0);
  store.close();
  ok('2.x usage: tokens summed, cache = read + write', u?.stats.tokens.total === 236 && u.stats.tokens.cache === 210, JSON.stringify(u?.stats.tokens));
  ok('2.x usage: cost summed', Math.abs(u?.stats.cost.amount - 0.01) < 1e-9, String(u?.stats.cost.amount));
  ok('2.x usage: messages counted', u?.stats.messages.total === 3, JSON.stringify(u?.stats.messages));
  ok('2.x usage: every model used is reported', u?.models.sort().join() === 'opencode/minimax-m3.1-flash-free,openrouter/openai/gpt-6-luna', JSON.stringify(u?.models));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 10. `since` scopes a 2.x read too.
{
  const dir = makeStoreV2([assistant([tool2('read', { p: 1 }, 0)]), assistant([tool2('read', { p: 2 }, 10)])]);
  ok('2.x: since filters older messages out', (await recentCalls(dir, 1005))?.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nSQLite path verified');
process.exit(fails ? 1 : 0);
