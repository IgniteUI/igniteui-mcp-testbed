'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Stats, Tokens } from '../types.ts';

// opencode's SQLite store (1.x `part`, 2.x `session_message`), always opened read-only.

const DB_REL = path.join('opencode', 'opencode.db');

export interface StoreToolCall {
  at: number;
  tool: string;
  input: unknown;
  skill: string | null;
  ok: boolean;
  ms: number | null;
}

export type StoreSchema = 'part' | 'session_message';

export interface Store {
  schema: StoreSchema;
  db: any;
  close(): void;
}

// Code Mode's own helpers (`opencode.*` stays in Code Mode even with `codemode:false`).
const CODEMODE_INTERNAL_NS = new Set(['opencode']);

export async function openStore(dataDir: string): Promise<Store | null> {
  const dbPath = path.join(dataDir, DB_REL);
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let schema: StoreSchema | null;
  try {
    const tables = new Set((db.prepare("select name from sqlite_master where type='table'").all() as any[])
      .map((r) => r.name));
    // 1.19 ships an empty `session_message` next to the `part` table it writes to.
    const v2HasRows = tables.has('session_message')
      && !!db.prepare('select 1 from session_message limit 1').get();
    schema = tables.has('session_message') && (v2HasRows || !tables.has('part'))
      ? 'session_message'
      : tables.has('part') ? 'part' : null;
  } catch (e) {
    try { db.close(); } catch (_) {}
    throw e;
  }
  if (!schema) {
    db.close();
    throw new Error('no known opencode schema (neither `part` nor `session_message`)');
  }
  return { schema, db, close: () => { try { db.close(); } catch (_) {} } };
}

const parse = (s: unknown): any => { try { return JSON.parse(String(s)); } catch (_) { return null; } };
const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);

export function readToolCalls(store: Store, since: number, newest?: number): StoreToolCall[] {
  const calls = store.schema === 'part' ? partCalls(store.db, since, newest) : messageCalls(store.db, since, newest);
  calls.sort((a, b) => a.at - b.at);
  return newest ? calls.slice(-newest) : calls;
}

function partCalls(db: any, since: number, newest?: number): StoreToolCall[] {
  const rows = (newest
    ? db.prepare('select time_created, data from part where time_created >= ? order by time_created desc limit ?').all(since, newest)
    : db.prepare('select time_created, data from part where time_created >= ? order by time_created asc').all(since)
  ) as Array<{ time_created: number; data: string }>;
  const calls: StoreToolCall[] = [];
  for (const row of rows) {
    const part = parse(row.data);
    if (!part || part.type !== 'tool' || !part.tool) continue;
    const state = part.state || {};
    const start = num(state.time?.start), end = num(state.time?.end);
    calls.push({
      at: start ?? Number(row.time_created),
      tool: String(part.tool),
      input: state.input,
      skill: state.input?.name || state.metadata?.name || null,
      ok: state.status !== 'error',
      ms: start != null && end != null ? end - start : null,
    });
  }
  return calls;
}

function assistantRows(db: any, since: number, newest?: number): Array<{ time_created: number; data: any }> {
  // Approximate tail: a message holds zero or more tool parts.
  const rows = (newest
    ? db.prepare("select time_created, data from session_message where type = 'assistant' and time_created >= ? order by time_created desc, seq desc limit ?").all(since, newest)
    : db.prepare("select time_created, data from session_message where type = 'assistant' and time_created >= ? order by time_created asc, seq asc").all(since)
  ) as Array<{ time_created: number; data: string }>;
  return rows.map((r) => ({ time_created: Number(r.time_created), data: parse(r.data) })).filter((r) => r.data);
}

function messageCalls(db: any, since: number, newest?: number): StoreToolCall[] {
  const calls: StoreToolCall[] = [];
  for (const row of assistantRows(db, since, newest)) {
    for (const c of row.data.content || []) {
      if (!c || c.type !== 'tool' || !c.name) continue;
      const state = c.state || {};
      const ran = num(c.time?.ran) ?? num(c.time?.created), done = num(c.time?.completed);
      const at = ran ?? row.time_created;
      calls.push({
        at,
        tool: String(c.name),
        input: state.input,
        skill: state.input?.id || state.input?.name || state.metadata?.name || null,
        ok: state.status !== 'error',
        ms: ran != null && done != null ? done - ran : null,
      });
      // Code Mode: surface the MCP calls made inside `execute`.
      if (c.name === 'execute') {
        for (const inner of state.metadata?.toolCalls || []) {
          const name = String(inner?.tool || '');
          const dot = name.indexOf('.');
          if (dot <= 0 || CODEMODE_INTERNAL_NS.has(name.slice(0, dot))) continue;
          calls.push({
            at,
            tool: `${name.slice(0, dot)}_${name.slice(dot + 1)}`,
            input: inner.input,
            skill: null,
            ok: inner.status !== 'error',
            ms: null,
          });
        }
      }
    }
  }
  return calls;
}

export interface StoreUsage {
  stats: Stats;
  models: string[];
}

export interface StoreMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  tokens: Tokens;
  cost: number;
  model: string | null;
  completed: boolean;
}

export function readMessages(store: Store, since: number): StoreMessage[] {
  if (store.schema !== 'session_message') return [];
  const rows = store.db.prepare(
    "select id, session_id, type, data from session_message where type in ('user', 'assistant') and time_created >= ? order by time_created asc, seq asc",
  ).all(since) as Array<{ id: string; session_id: string; type: 'user' | 'assistant'; data: string }>;
  const out: StoreMessage[] = [];
  for (const r of rows) {
    const m = parse(r.data) || {};
    const t = m.tokens || {};
    const cache = typeof t.cache === 'number' ? t.cache : (Number(t.cache?.read) || 0) + (Number(t.cache?.write) || 0);
    const tokens: Tokens = { input: Number(t.input) || 0, output: Number(t.output) || 0, reasoning: Number(t.reasoning) || 0, cache, total: 0 };
    tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cache;
    out.push({
      id: String(r.id),
      sessionID: String(r.session_id),
      role: r.type,
      tokens,
      cost: Number(m.cost) || 0,
      model: m.model?.providerID && m.model?.id ? `${m.model.providerID}/${m.model.id}` : null,
      completed: r.type === 'user' || !!m.time?.completed,
    });
  }
  return out;
}

export function readUsage(store: Store, since: number): StoreUsage | null {
  if (store.schema !== 'session_message') return null;
  const zero = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: 0, total: 0 });
  const tokens = zero();
  const perModel: NonNullable<Stats['perModel']> = {};
  let cost = 0, user = 0, assistant = 0;
  for (const m of readMessages(store, since)) {
    if (m.role === 'user') { user++; continue; }
    assistant++;
    const pm = perModel[m.model || 'unknown'] ||= { tokens: zero(), cost: 0 };
    for (const k of Object.keys(m.tokens) as Array<keyof Tokens>) { tokens[k] += m.tokens[k]; pm.tokens[k] += m.tokens[k]; }
    pm.cost += m.cost;
    cost += m.cost;
  }
  return {
    stats: {
      tokens,
      cost: { amount: cost, currency: 'USD', available: true },
      messages: { total: user + assistant, user, assistant },
      perModel,
      parsed: true,
    },
    models: Object.keys(perModel).filter((m) => m !== 'unknown'),
  };
}
