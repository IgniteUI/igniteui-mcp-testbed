'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const EMPTY_TOKENS = () => ({ input: 0, output: 0, reasoning: 0, cache: 0, total: 0 });

// Pull a normalized record out of whatever message-shaped object opencode hands us.
// Returns null if it doesn't look like a message.
function normalizeMessage(info) {
  if (!info || typeof info !== 'object') return null;
  const role = info.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const id = info.id || info.messageID;
  if (!id) return null;

  const t = info.tokens || {};
  const cache = typeof t.cache === 'object' && t.cache
    ? Number(t.cache.read || 0) + Number(t.cache.write || 0)
    : Number(t.cache || 0);
  const tokens = {
    input: Number(t.input || 0),
    output: Number(t.output || 0),
    reasoning: Number(t.reasoning || 0),
    cache,
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
function extractMessages(event) {
  const out = [];
  const props = event && event.properties ? event.properties : event;
  if (!props) return out;
  for (const v of [props.info, props.message, props]) {
    const m = normalizeMessage(v);
    if (m) out.push(m);
  }
  return out;
}

class StatsCollector {
  constructor({ port, dir, model, costAvailable }) {
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
  }

  start() {
    if (this.stopped) this.stopped = false;
    this._connect();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this._backfill(), 30000);
      this.reconcileTimer.unref && this.reconcileTimer.unref();
    }
    return this;
  }

  setModel(model) {
    if (model) this.model = model;
    this._scheduleWrite();
  }

  stop() {
    this.stopped = true;
    if (this.req) { try { this.req.destroy(); } catch (_) {} this.req = null; }
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; this._writeNow(); }
  }

  onUpdate(cb) { this._onUpdate = cb; }
  onWarn(cb) { this._onWarn = cb; }

  _connect() {
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

  _reconnect() {
    if (this.stopped) return;
    if (this.req) { try { this.req.destroy(); } catch (_) {} this.req = null; }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 10000);
    const t = setTimeout(() => this._connect(), delay);
    t.unref && t.unref();
  }

  _handleBlock(block) {
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

  _upsert(m) {
    if (!m.model && this.model) m.model = this.model;
    this.messages.set(m.id, m);

    if (m.role === 'assistant' && m.completed && !this.loggedIds.has(m.id)) {
      this.loggedIds.add(m.id);
      this._appendTimeline(m);
    }
    return true;
  }

  _aggregate() {
    const tokens = EMPTY_TOKENS();
    const messages = { total: 0, user: 0, assistant: 0 };
    const sessions = new Set();
    const perModel = {};
    let cost = 0;
    let sawCost = false;

    for (const m of this.messages.values()) {
      messages.total += 1;
      messages[m.role] += 1;
      if (m.sessionID) sessions.add(m.sessionID);
      for (const k of ['input', 'output', 'reasoning', 'cache', 'total']) tokens[k] += m.tokens[k];
      cost += m.cost;
      if (m.cost > 0) sawCost = true;

      const key = m.model || this.model || 'unknown';
      const pm = perModel[key] || (perModel[key] = { tokens: EMPTY_TOKENS(), cost: 0 });
      for (const k of ['input', 'output', 'reasoning', 'cache', 'total']) pm.tokens[k] += m.tokens[k];
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

  snapshot() {
    return { updatedAt: new Date().toISOString(), ...this._aggregate() };
  }

  _scheduleWrite() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = null; this._writeNow(); }, 500);
    this.writeTimer.unref && this.writeTimer.unref();
  }

  _writeNow() {
    const snap = this.snapshot();
    try {
      const tmp = this.jsonPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
      fs.renameSync(tmp, this.jsonPath);
    } catch (_) {}
    if (this._onUpdate) { try { this._onUpdate(snap); } catch (_) {} }
  }

  _appendTimeline(m) {
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

  _backfill() {
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

  _getJson(p, cb) {
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

module.exports = { StatsCollector, normalizeMessage };
