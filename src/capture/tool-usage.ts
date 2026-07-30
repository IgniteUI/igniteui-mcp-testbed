'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ToolUsage, ToolCallStat, ToolEvent, ToolUsageSet } from '../types.ts';

// Which MCP tools and skills the agent actually invoked during a run.
//
// This is the metric the testbed exists to measure: an MCP server or skill can be
// configured perfectly and still never be reached for, and a run that "succeeded"
// without ever calling `igniteui-cli_get_doc` tells you something very different from
// one that called it twelve times. Tokens/cost (src/capture/usage.ts) say how much the
// agent worked; this says *what it worked with*.
//
// Source of truth is opencode's own store: a SQLite db at
// `<dataDir>/opencode/opencode.db`, whose `part` table holds one row per message part.
// Tool parts look like:
//   { type:'tool', tool:'igniteui-cli_get_doc', callID:'…',
//     state:{ status:'completed'|'error'|'running'|'pending', input:{…}, output:'…',
//             metadata:{…}, time:{ start:<ms>, end:<ms> }, error?:'…' } }
// MCP tools are named `<serverName>_<toolName>`; skills all come through the built-in
// `skill` tool with the skill name in `state.input.name` / `state.metadata.name`.
//
// Both the schema and the tool naming are opencode-version-dependent, so everything
// here is defensive: an unreadable/renamed store falls back to parsing the permission
// lines in `<dataDir>/opencode/log/*.log`, and a total miss returns null rather than
// throwing (the run's `tools` record simply stays null).

// opencode's own tools. Anything else that looks namespaced is treated as MCP.
// Extend this if a future opencode version adds built-ins — a missing entry only
// mis-labels a tool as `mcp`, it never drops it.
const BUILTIN_TOOLS = new Set([
  'read', 'write', 'edit', 'multiedit', 'patch', 'bash', 'glob', 'grep', 'list', 'ls',
  'todowrite', 'todoread', 'task', 'webfetch', 'websearch', 'skill', 'question',
  'invalid', 'think', 'lsp_diagnostics', 'lsp_hover',
]);

// Permission names that are evaluated *around* a tool call rather than being one
// (they'd double-count against the tool's own line in the log fallback).
const NON_TOOL_PERMISSIONS = new Set(['external_directory', 'plan_enter', 'plan_exit']);

// A long agent run can make thousands of calls; the per-tool aggregate is what gets
// compared, so the ordered timeline is capped to keep the history record small.
const TIMELINE_CAP = 500;

const DB_REL = path.join('opencode', 'opencode.db');
const LOG_REL = path.join('opencode', 'log');

export interface CollectOpts {
  /** XDG_DATA_HOME-style dir holding opencode's store (contains `opencode/opencode.db`). */
  dataDir: string;
  /** Ignore anything created before this epoch ms — scopes a shared store to one run. */
  since?: number;
  /** MCP server names this run configured (from opencode.json's `mcp` block). */
  mcpServers?: string[];
  /** Skill names installed for this run (see `installedSkills`). */
  skillNames?: string[];
}

// Split a raw opencode tool name into its kind/server/display name. `servers` is the
// set of configured MCP server names, checked longest-first so a server whose name is
// a prefix of another (or contains an underscore) still resolves correctly.
export function classifyTool(
  tool: string,
  servers: string[] = [],
): { kind: ToolCallStat['kind']; server: string | null; name: string } {
  if (tool === 'skill') return { kind: 'skill', server: null, name: tool };

  const byLength = [...servers].sort((a, b) => b.length - a.length);
  for (const s of byLength) {
    if (tool === s) return { kind: 'mcp', server: s, name: tool };
    if (tool.startsWith(s + '_')) return { kind: 'mcp', server: s, name: tool.slice(s.length + 1) };
  }

  if (BUILTIN_TOOLS.has(tool)) return { kind: 'builtin', server: null, name: tool };

  // Namespaced but not from a server we know about (a server renamed since the run,
  // or one classify() left disabled that opencode loaded anyway). Still MCP — record
  // it under the inferred server rather than silently calling it a built-in.
  const us = tool.indexOf('_');
  if (us > 0) return { kind: 'mcp', server: tool.slice(0, us), name: tool.slice(us + 1) };

  return { kind: 'builtin', server: null, name: tool };
}

// Skills the run was given, by name (the folder name, which is what the `skill` tool
// receives). Reads both dirs opencode loads from: `.agents/skills/` (its native
// location) and `.claude/skills/` (written by ai-config's `claude` agent output).
export function installedSkills(appDir: string): string[] {
  const found = new Set<string>();
  for (const rel of [path.join('.agents', 'skills'), path.join('.claude', 'skills')]) {
    const dir = path.join(appDir, rel);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // A folder without a SKILL.md is not a loadable skill (overlaySkills warns about
      // these too), so it would never show up as "used" and must not count as unused.
      if (fs.existsSync(path.join(dir, e.name, 'SKILL.md'))) found.add(e.name);
    }
  }
  return [...found].sort();
}

// ── aggregation ───────────────────────────────────────────────────────────────

interface RawCall {
  at: number;
  tool: string;
  /** Skill name, when the raw tool is `skill`. */
  skill?: string | null;
  ok: boolean;
  ms: number | null;
}

function usageSet(configured: string[], used: Set<string>): ToolUsageSet {
  const conf = [...new Set(configured)].sort();
  const usedList = [...used].sort();
  return { configured: conf, used: usedList, unused: conf.filter((c) => !used.has(c)) };
}

// Fold a flat, time-ordered call list into the stored shape.
function aggregate(calls: RawCall[], source: ToolUsage['source'], opts: CollectOpts): ToolUsage {
  const servers = opts.mcpServers || [];
  const byKey = new Map<string, ToolCallStat>();
  const usedServers = new Set<string>();
  const usedSkills = new Set<string>();
  const timeline: ToolEvent[] = [];
  let errors = 0, mcpCalls = 0, skillCalls = 0;

  for (const c of calls) {
    const cls = classifyTool(c.tool, servers);
    // A skill invocation is only meaningful per skill, so key (and label) it by name.
    const name = cls.kind === 'skill' ? (c.skill || 'unknown') : cls.name;
    const key = cls.kind === 'skill' ? `skill:${name}` : c.tool;

    let stat = byKey.get(key);
    if (!stat) {
      stat = { tool: c.tool, kind: cls.kind, server: cls.server, name, calls: 0, errors: 0, durationMs: 0 };
      byKey.set(key, stat);
    }
    stat.calls++;
    if (!c.ok) { stat.errors++; errors++; }
    if (c.ms != null) stat.durationMs += c.ms;

    if (cls.kind === 'mcp') { mcpCalls++; if (cls.server) usedServers.add(cls.server); }
    else if (cls.kind === 'skill') { skillCalls++; usedSkills.add(name); }

    if (timeline.length < TIMELINE_CAP) {
      timeline.push({ at: c.at, tool: c.tool, kind: cls.kind, name, ok: c.ok, ms: c.ms });
    }
  }

  const tools = [...byKey.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    source,
    calls: calls.length,
    errors,
    mcpCalls,
    skillCalls,
    tools,
    servers: usageSet(servers, usedServers),
    skills: usageSet(opts.skillNames || [], usedSkills),
    timeline,
  };
}

// ── SQLite reader (primary) ───────────────────────────────────────────────────

// `node:sqlite` is built into Node >= 22.5 but lazily imported (like playwright in
// src/capture/screenshots.ts) so a runtime without it degrades to the log fallback
// instead of failing at module load.
async function readDb(dbPath: string, since: number): Promise<RawCall[]> {
  const { DatabaseSync } = await import('node:sqlite');
  // Read-only: opencode may still hold this db open (an interactive session polls it
  // live), and we must never take a write lock on its store.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare('select time_created, data from part where time_created >= ? order by time_created asc')
      .all(since) as Array<{ time_created: number; data: string }>;

    const calls: RawCall[] = [];
    for (const row of rows) {
      let part: any;
      try { part = JSON.parse(String(row.data)); } catch (_) { continue; }
      if (!part || part.type !== 'tool' || !part.tool) continue;
      const state = part.state || {};
      const status = state.status;
      // 'running'/'pending' calls are in flight — count them (the agent did reach for
      // the tool) but don't mark them failed.
      const time = state.time || {};
      const ms = Number.isFinite(time.start) && Number.isFinite(time.end)
        ? Number(time.end) - Number(time.start)
        : null;
      calls.push({
        at: Number(time.start) || Number(row.time_created) || 0,
        tool: String(part.tool),
        skill: (state.input && state.input.name) || (state.metadata && state.metadata.name) || null,
        ok: status !== 'error',
        ms,
      });
    }
    return calls;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

// ── log reader (fallback) ─────────────────────────────────────────────────────

// opencode logs one line per evaluated permission, which is one per tool call:
//   message=evaluated permission=skill pattern=igniteui-angular-components …
//   message=evaluated permission=igniteui-theming_detect_platform pattern=* …
// Less information than the db (no duration, no error status), but enough to answer
// "was this MCP server / skill ever used".
const PERM_RE = /timestamp=(\S+).*?message=evaluated permission=(\S+) pattern=(\S+)/;

export function parseToolLog(text: string, since: number): RawCall[] {
  const calls: RawCall[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = PERM_RE.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]) || 0;
    if (at && since && at < since) continue;
    const perm = m[2];
    if (NON_TOOL_PERMISSIONS.has(perm)) continue;
    // `permission=skill` carries the skill name in `pattern`; every other permission
    // *is* the tool name and its pattern is the argument (a path, a glob, or '*').
    if (perm === 'skill') calls.push({ at, tool: 'skill', skill: m[3], ok: true, ms: null });
    else calls.push({ at, tool: perm, skill: null, ok: true, ms: null });
  }
  return calls;
}

function readLogs(logDir: string): string | null {
  let files: string[];
  try { files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort(); } catch (_) { return null; }
  if (!files.length) return null;
  const parts: string[] = [];
  for (const f of files) {
    try { parts.push(fs.readFileSync(path.join(logDir, f), 'utf8')); } catch (_) {}
  }
  return parts.length ? parts.join('\n') : null;
}

// ── entry point ───────────────────────────────────────────────────────────────

// Collect this run's tool usage. Returns null when opencode left nothing readable
// behind (no db and no log) — the caller leaves the record's `tools` null rather than
// storing a misleading all-zeroes result.
export async function collectToolUsage(opts: CollectOpts): Promise<ToolUsage | null> {
  const since = opts.since || 0;
  const dbPath = path.join(opts.dataDir, DB_REL);
  let dbError: string | null = null;

  if (fs.existsSync(dbPath)) {
    try {
      return aggregate(await readDb(dbPath, since), 'db', opts);
    } catch (e: any) {
      dbError = e && e.message ? e.message : String(e);
    }
  }

  const text = readLogs(path.join(opts.dataDir, LOG_REL));
  if (text != null) {
    const usage = aggregate(parseToolLog(text, since), 'log', opts);
    usage.warning = dbError
      ? `could not read opencode.db (${dbError}); tool usage parsed from the log (no timings/errors)`
      : 'opencode.db not found; tool usage parsed from the log (no timings/errors)';
    return usage;
  }

  return null;
}

// One-line summary for the run log, so a matrix entry's captured output says what the
// agent reached for without having to open the History detail.
export function summarizeToolUsage(u: ToolUsage): string {
  const mcp = u.tools.filter((t) => t.kind === 'mcp');
  const skills = u.tools.filter((t) => t.kind === 'skill');
  const list = (stats: ToolCallStat[]) =>
    stats.map((t) => `${t.name}${t.calls > 1 ? `×${t.calls}` : ''}`).join(', ') || 'none';
  const parts = [
    `${u.calls} tool call(s)`,
    `MCP: ${u.mcpCalls} (${list(mcp)})`,
    `skills: ${u.skillCalls} (${list(skills)})`,
  ];
  if (u.servers.unused.length) parts.push(`MCP servers never called: ${u.servers.unused.join(', ')}`);
  if (u.skills.unused.length) parts.push(`skills never invoked: ${u.skills.unused.length}`);
  return parts.join(' · ');
}
