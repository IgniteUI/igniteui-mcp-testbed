'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { collectToolUsage } from './capture/tool-usage.ts';
import type { Tokens, Stats, ToolContext, ToolUsage } from './types.ts';

const EMPTY_TOKENS = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cache: 0, total: 0 });
const TOKEN_KEYS: (keyof Tokens)[] = ['input', 'output', 'reasoning', 'cache', 'total'];

interface NormMsg {
  id: string;
  role: 'user' | 'assistant';
  sessionID: string | null;
  tokens: Tokens;
  cost: number;
  model: string | null;
  completed: boolean;
}

interface StatsOpts {
  port: number;
  dir: string;
  model?: string | null;
  costAvailable?: boolean;
}

// Pull a normalized record out of whatever message-shaped object opencode hands us.
// Returns null if it doesn't look like a message.
export function normalizeMessage(info: any): NormMsg | null {
  if (!info || typeof info !== 'object') return null;
  const role = info.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const id = info.id || info.messageID;
  if (!id) return null;

  const t = info.tokens || {};
  const cache = typeof t.cache === 'object' && t.cache
    ? Number(t.cache.read || 0) + Number(t.cache.write || 0)
    : Number(t.cache || 0);
  const tokens: Tokens = {
    input: Number(t.input || 0),
    output: Number(t.output || 0),
    reasoning: Number(t.reasoning || 0),
    cache,
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cache;

  const model = [info.providerID, info.modelID].filter(Boolean).join('/') || null;
  const completed = !!(info.time && info.time.completed);

  return {
    id,
    role,
    sessionID: info.sessionID || info.sessionId || null,
    tokens,
    cost: Number(info.cost || 0),
    model,
    completed,
  };
}

// Find message-shaped objects anywhere obvious in an SSE event payload.
export function extractMessages(event: any): NormMsg[] {
  const out: NormMsg[] = [];
  const props = event && event.properties ? event.properties : event;
  if (!props) return out;
  for (const v of [props.info, props.message, props]) {
    const m = normalizeMessage(v);
    if (m) out.push(m);
  }
  return out;
}

export class StatsCollector {
  port: number;
  dir: string;
  model: string | null;
  costAvailable: boolean;
  jsonPath: string;
  ndjsonPath: string;
  messages: Map<string, NormMsg>;
  loggedIds: Set<string>;
  stopped: boolean;
  req: http.ClientRequest | null;
  writeTimer: NodeJS.Timeout | null;
  reconcileTimer: NodeJS.Timeout | null;
  backoff: number;
  warnedShape: boolean;
  // Tool/skill usage for the live session. Unlike tokens/cost (which come off the
  // opencode API), this is read from opencode's SQLite store, so it is polled on the
  // reconcile tick rather than pushed. Null until the pipeline hands over the context.
  toolCtx: ToolContext | null;
  tools: ToolUsage | null;
  toolsBusy: boolean;
  warnedTools: boolean;
  _onUpdate?: (snap: Stats) => void;
  _onTools?: (usage: ToolUsage) => void;
  _onWarn?: (msg: string) => void;
  _onTick?: () => void;

  constructor({ port, dir, model, costAvailable }: StatsOpts) {
    this.port = port;
    this.dir = dir;
    this.model = model || null;
    this.costAvailable = costAvailable !== false;

    this.jsonPath = path.join(dir, 'stats.json');
    this.ndjsonPath = path.join(dir, 'stats.ndjson');

    this.messages = new Map(); // id -> normalized record (latest wins, no double count)
    this.loggedIds = new Set();

    this.stopped = false;
    this.req = null;
    this.writeTimer = null;
    this.reconcileTimer = null;
    this.backoff = 500;
    this.warnedShape = false;

    this.toolCtx = null;
    this.tools = null;
    this.toolsBusy = false;
    this.warnedTools = false;
  }

  start(): this {
    if (this.stopped) this.stopped = false;
    this._connect();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => {
        this._backfill();
        this._collectTools();
        // Anything else that wants this cadence (the diagnostics loop detector) rides
        // here rather than opening a second timer against the same store.
        if (this._onTick) { try { this._onTick(); } catch (_) {} }
      }, 30000);
      this.reconcileTimer.unref && this.reconcileTimer.unref();
    }
    return this;
  }

  setModel(model: string | null): void {
    if (model) this.model = model;
    this._scheduleWrite();
  }

  // Point the collector at this run's opencode store so it can start reporting which
  // MCP tools and skills the agent invokes. Reads once immediately, then on each tick.
  setToolContext(ctx: ToolContext | null): void {
    this.toolCtx = ctx;
    if (ctx) this._collectTools();
  }

  stop(): void {
    this.stopped = true;
    // One last read before shutting down, so the record reflects the whole session and
    // not just up to the final 30s tick. Fire-and-forget: the write is atomic.
    this._collectTools();
    if (this.req) { try { this.req.destroy(); } catch (_) {} this.req = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; this._writeNow(); }
  }

  onUpdate(cb: (snap: Stats) => void): void { this._onUpdate = cb; }
  onTools(cb: (usage: ToolUsage) => void): void { this._onTools = cb; }
  onWarn(cb: (msg: string) => void): void { this._onWarn = cb; }
  onTick(cb: () => void): void { this._onTick = cb; }

  // Re-read tool/skill usage from the store. Overlapping reads are skipped rather than
  // queued — the next tick catches up, and a slow read must not stack up behind itself.
  _collectTools(): void {
    if (!this.toolCtx || this.toolsBusy) return;
    this.toolsBusy = true;
    collectToolUsage(this.toolCtx)
      .then((usage) => {
        if (!usage) return;
        this.tools = usage;
        if (this._onTools) { try { this._onTools(usage); } catch (_) {} }
      })
      .catch((e) => {
        // A live store can be transiently locked; a warning once is enough.
        if (!this.warnedTools) {
          this.warnedTools = true;
          if (this._onWarn) this._onWarn(`stats: could not read tool usage (${e && e.message ? e.message : e})`);
        }
      })
      .finally(() => { this.toolsBusy = false; });
  }

  _connect(): void {
    if (this.stopped) return;
    this._backfill();
    const req = http.get(
      { host: '127.0.0.1', port: this.port, path: '/event', headers: { Accept: 'text/event-stream' } },
      (res) => {
        this.backoff = 500;
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let sep;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            this._handleBlock(block);
          }
        });
        res.on('end', () => this._reconnect());
        res.on('error', () => this._reconnect());
      }
    );
    req.on('error', () => this._reconnect());
    this.req = req;
  }

  _reconnect(): void {
    if (this.stopped) return;
    if (this.req) { try { this.req.destroy(); } catch (_) {} this.req = null; }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 10000);
    const t = setTimeout(() => this._connect(), delay);
    t.unref && t.unref();
  }

  _handleBlock(block: string): void {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch (_) { return; }
    const found = extractMessages(event);
    if (!found.length) {
      if (!this.warnedShape && event.type === 'message.updated') {
        this.warnedShape = true;
        if (this._onWarn) this._onWarn(`stats: unrecognized opencode "message.updated" shape; relying on REST backfill`);
      }
      return;
    }
    let changed = false;
    for (const m of found) { if (this._upsert(m)) changed = true; }
    if (changed) this._scheduleWrite();
  }

  _upsert(m: NormMsg): boolean {
    if (!m.model && this.model) m.model = this.model;
    this.messages.set(m.id, m);

    if (m.role === 'assistant' && m.completed && !this.loggedIds.has(m.id)) {
      this.loggedIds.add(m.id);
      this._appendTimeline(m);
    }
    return true;
  }

  _aggregate(): Stats {
    const tokens = EMPTY_TOKENS();
    const messages = { total: 0, user: 0, assistant: 0 };
    const sessions = new Set<string>();
    const perModel: Record<string, { tokens: Tokens; cost: number }> = {};
    let cost = 0;
    let sawCost = false;

    for (const m of this.messages.values()) {
      messages.total += 1;
      messages[m.role] += 1;
      if (m.sessionID) sessions.add(m.sessionID);
      for (const k of TOKEN_KEYS) tokens[k] += m.tokens[k];
      cost += m.cost;
      if (m.cost > 0) sawCost = true;

      const key = m.model || this.model || 'unknown';
      const pm = perModel[key] || (perModel[key] = { tokens: EMPTY_TOKENS(), cost: 0 });
      for (const k of TOKEN_KEYS) pm.tokens[k] += m.tokens[k];
      pm.cost += m.cost;
    }

    return {
      model: this.model,
      sessions: sessions.size,
      messages,
      tokens,
      cost: {
        amount: Number(cost.toFixed(6)),
        currency: 'USD',
        available: this.costAvailable && (sawCost || cost > 0),
      },
      perModel,
    };
  }

  snapshot(): Stats {
    return { updatedAt: new Date().toISOString(), ...this._aggregate() };
  }

  _scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = null; this._writeNow(); }, 500);
    this.writeTimer.unref && this.writeTimer.unref();
  }

  _writeNow(): void {
    const snap = this.snapshot();
    try {
      const tmp = this.jsonPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
      fs.renameSync(tmp, this.jsonPath);
    } catch (_) {}
    if (this._onUpdate) { try { this._onUpdate(snap); } catch (_) {} }
  }

  _appendTimeline(m: NormMsg): void {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      sessionID: m.sessionID,
      messageID: m.id,
      model: m.model || this.model,
      tokens: m.tokens,
      cost: m.cost,
    });
    try { fs.appendFileSync(this.ndjsonPath, line + '\n'); } catch (_) {}
  }

  _backfill(): void {
    this._getJson('/session', (sessions) => {
      if (!Array.isArray(sessions)) return;
      for (const s of sessions) {
        const id = s && (s.id || s.sessionID);
        if (!id) continue;
        this._getJson(`/session/${id}/messages`, (rows) => {
          if (!Array.isArray(rows)) return;
          let changed = false;
          for (const row of rows) {
            const m = normalizeMessage(row && row.info ? row.info : row);
            if (m && this._upsert(m)) changed = true;
          }
          if (changed) this._scheduleWrite();
        });
      }
    });
  }

  _getJson(p: string, cb: (data: any) => void): void {
    const req = http.get({ host: '127.0.0.1', port: this.port, path: p }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { cb(JSON.parse(body)); } catch (_) {} });
    });
    req.on('error', () => {});
  }
}
