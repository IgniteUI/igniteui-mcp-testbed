'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as history from '../history.ts';
import { REPORTS_DIR } from '../config.ts';
import type { HistoryRecord, MatrixEntry, Tokens } from '../types.ts';

// Render a static, self-contained HTML report for a settled matrix from its history
// records. Written to REPORTS_DIR/<matrixId>/report.html (i.e. sessions/history/
// reports/... on the host), so it survives the container and needs no server to view.
// Screenshots are referenced relatively (../../artifacts/<runId>/<file>) — the report
// works both from the host filesystem and served at /history/reports/....
// Styling mirrors the wizard UI (public/css/app.css): same dark Material palette,
// mono/sans font stacks, status pills, and console-style blocks.

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const fmtMs = (ms: number | null | undefined): string => {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// Tool calls are usually tens of milliseconds, which fmtMs would flatten to "0s".
const fmtToolMs = (ms: number): string => {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return fmtMs(ms);
};

const fmtTokens = (n: number | undefined): string =>
  n == null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// input/output/reasoning/cache are recorded per run; the summary table has room only for
// the total, so the split rides along as the cell's tooltip and in the entry heading.
const TOKEN_PARTS: Array<[string, keyof Tokens]> = [
  ['input', 'input'], ['output', 'output'], ['reasoning', 'reasoning'], ['cache', 'cache'],
];

const tokenSplit = (t: Tokens | undefined): string =>
  !t || !t.total ? '—' : TOKEN_PARTS.map(([label, key]) => `${label} ${fmtTokens(t[key])}`).join(' · ');

// Summed across a matrix's entries, for the header rollup and summary.json's totals.
const sumTokens = (records: Array<HistoryRecord | null>): Tokens => {
  const out: Tokens = { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 };
  for (const r of records) {
    const t = r?.stats?.tokens;
    if (!t) continue;
    for (const k of Object.keys(out) as Array<keyof Tokens>) out[k] += Number(t[k]) || 0;
  }
  return out;
};

const fmtCost = (r: HistoryRecord): string => {
  const c = r.stats?.cost;
  return c?.available ? `${c.amount.toFixed(4)} ${c.currency || 'USD'}` : '—';
};

// Statuses with a dedicated .pill class in the UI; anything else renders as .pill.other.
const PILL_STATUSES = new Set(['success', 'error', 'build-error', 'test-failed', 'running', 'pending', 'cancelled', 'interrupted']);
const pill = (status: string | undefined): string => {
  const s = status || 'missing';
  return `<span class="pill ${PILL_STATUSES.has(s) ? esc(s) : 'other'}">${esc(s)}</span>`;
};

const variantOf = (e: MatrixEntry): string => e.variantLabel || '—';

// "get_doc ×3, search_api" — the per-tool call list for one kind.
const toolList = (r: HistoryRecord | null, kind: 'mcp' | 'skill'): string => {
  const tools = (r?.tools?.tools || []).filter((t) => t.kind === kind);
  if (!tools.length) return 'none';
  return tools.map((t) => `${esc(t.name)}${t.calls > 1 ? ` &times;${t.calls}` : ''}`).join(', ');
};

// The tool/skill block for one entry. This is the comparison the matrix exists to make:
// two variants can both build and still differ entirely in whether the agent reached for
// the MCP servers and skills it was given.
function toolsSection(r: HistoryRecord): string {
  const u = r.tools;
  if (!u) return '<p class="muted">tool usage: not recorded</p>';
  const rows = u.tools.map((t) => `<tr>
  <td>${esc(t.kind)}</td><td>${esc(t.server || '—')}</td><td>${esc(t.name)}</td>
  <td class="num">${t.calls}</td><td class="num">${t.errors || '—'}</td><td class="num">${fmtToolMs(t.durationMs || 0)}</td>
</tr>`).join('\n');
  const unusedServers = u.servers.unused.length
    ? `<p class="warn">MCP servers configured but never called: <b>${u.servers.unused.map(esc).join('</b>, <b>')}</b></p>` : '';
  const unusedSkills = u.skills.unused.length
    ? `<details><summary>${u.skills.unused.length} of ${u.skills.configured.length} skills never invoked</summary><p class="muted">${u.skills.unused.map(esc).join(', ')}</p></details>` : '';
  return `<div class="tools">
  <p class="muted">${u.calls} tool calls · <b>${u.mcpCalls}</b> MCP · <b>${u.skillCalls}</b> skill${u.errors ? ` · ${u.errors} errored` : ''}${u.source === 'log' ? ' · from log (no timings)' : ''}</p>
  <p class="muted">MCP tools: ${toolList(r, 'mcp')}</p>
  <p class="muted">skills: ${toolList(r, 'skill')}</p>
  ${unusedServers}
  ${unusedSkills}
  ${rows ? `<details><summary>all ${u.tools.length} tools</summary><table class="tools-table">
<thead><tr><th>Kind</th><th>Server</th><th>Tool</th><th class="num">Calls</th><th class="num">Err</th><th class="num">Time</th></tr></thead>
<tbody>${rows}</tbody></table></details>` : ''}
</div>`;
}

function entrySection(e: MatrixEntry, r: HistoryRecord | null): string {
  if (!r) return `<section class="entry"><h2>#${e.index + 1} ${esc(e.platform)} · ${esc(variantOf(e))}</h2><p class="muted">history record missing</p></section>`;
  const tests = r.tests
    ? r.tests.ran
      ? `${r.tests.passed}/${r.tests.total} passed${r.tests.failed ? `, ${r.tests.failed} failed` : ''}`
      : `did not run${r.tests.error ? ` — ${esc(r.tests.error)}` : ''}`
    : 'none';
  const stages = Object.entries(r.stages?.timings || {})
    .map(([name, ms]) => `<span class="stage">${esc(name)} <b>${fmtMs(ms)}</b></span>`).join(' ');
  const shots = (r.screenshots || []).map((s) =>
    s.ok
      ? `<a class="shot" href="../../artifacts/${esc(r.id)}/${esc(s.file)}"><img loading="lazy" src="../../artifacts/${esc(r.id)}/${esc(s.file)}" alt="${esc(s.route)}"><span class="cap">${esc(s.route)}</span></a>`
      : `<span class="shot fail">✖ ${esc(s.route)} — ${esc(s.error || 'capture failed')}</span>`
  ).join('');
  const failures = (r.tests?.failures || []).map((f) =>
    `<li><b>${esc(f.title)}</b> <small>${esc(f.file)}</small><pre>${esc(f.error)}</pre></li>`).join('');
  const logTail = (r.logs || []).slice(-60).join('\n');
  return `<section class="entry" id="entry-${e.index}">
  <h2>#${e.index + 1} ${esc(e.platform)} · ${esc(variantOf(e))}
    ${pill(r.status)}
    <span class="muted">${fmtMs(r.durationMs)} · ${fmtTokens(r.stats?.tokens?.total)} tokens · ${esc(fmtCost(r))}</span>
  </h2>
  <p class="muted">tokens: ${tokenSplit(r.stats?.tokens)}</p>
  ${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}
  ${stages ? `<p class="stages">${stages}</p>` : ''}
  <p class="muted">tests: ${tests}</p>
  ${toolsSection(r)}
  ${failures ? `<ul class="failures">${failures}</ul>` : ''}
  ${shots ? `<div class="shot-strip">${shots}</div>` : '<p class="muted">no screenshots</p>'}
  ${logTail ? `<details><summary>log tail (${Math.min(60, (r.logs || []).length)} of ${(r.logs || []).length} lines)</summary><pre class="console">${esc(logTail)}</pre></details>` : ''}
</section>`;
}

// Write both post-run artifacts — report.html (human) and summary.json (machine, for
// CI to see *which* combo regressed rather than just the exit code) — into
// REPORTS_DIR/<matrixId>/.
export function writeMatrixReport(
  matrixId: string,
  entries: MatrixEntry[],
  meta: { prompt: string; model: string; cancelled: boolean; name?: string | null },
): { reportFile: string; summaryFile: string } {
  const records = entries.map((e) => (e.runId ? history.get(e.runId) : null));
  const counts: Record<string, number> = {};
  for (const r of records) { const s = r?.status || 'missing'; counts[s] = (counts[s] || 0) + 1; }
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ');
  const totalMs = records.reduce((acc, r) => acc + (r?.durationMs || 0), 0);
  const tokenTotals = sumTokens(records);
  const totalTokens = tokenTotals.total;
  const costs = records.filter((r) => r?.stats?.cost?.available);
  const totalCost = costs.reduce((acc, r) => acc + (r!.stats!.cost.amount || 0), 0);
  const generatedAt = new Date().toISOString();
  // Prompt images are fixed across a matrix, so any entry's record carries the set.
  // Only the names go in the report: the files live in the host's ./prompt-images/
  // folder, outside the artifact store this report links into.
  const promptImages = records.find((r) => r?.config?.promptImages?.length)?.config.promptImages || [];

  const rows = entries.map((e, i) => {
    const r = records[i];
    return `<tr>
  <td><a href="#entry-${e.index}">#${e.index + 1}</a></td>
  <td>${esc(e.platform)}</td><td>${esc(variantOf(e))}</td>
  <td>${pill(r?.status)}</td>
  <td class="num">${fmtMs(r?.durationMs)}</td>
  <td class="num" title="${esc(tokenSplit(r?.stats?.tokens))}">${fmtTokens(r?.stats?.tokens?.total)}</td>
  <td class="num">${r ? esc(fmtCost(r)) : '—'}</td>
  <td class="num">${r?.tests?.ran ? `${r.tests.passed}/${r.tests.total}` : '—'}</td>
  <td class="num">${r?.tools ? r.tools.mcpCalls : '—'}</td>
  <td class="num">${r?.tools ? r.tools.skillCalls : '—'}</td>
  <td class="num">${(r?.screenshots || []).filter((s) => s.ok).length}</td>
</tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Matrix report ${esc(meta.name || matrixId)}</title>
<style>
  /* Palette + type mirror public/css/app.css (the wizard UI). */
  :root {
    --ink:#e7f0ef; --steel:#8ea6a4; --fog:#0a1211; --surface:#10201e;
    --header:#070d0c; --line:#20342f; --teal:#1aa99e;
    --green:#2bb368; --amber:#caa23c; --red:#e06a55; --circle:#0c1a18;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    --sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--fog); color:var(--ink); font-family:var(--sans);
         -webkit-font-smoothing:antialiased; line-height:1.5; }
  header { display:flex; align-items:baseline; gap:.7rem; flex-wrap:wrap; padding:1rem 1.4rem;
           background:var(--header); border-bottom:3px solid var(--teal); }
  header h1 { font-size:.95rem; letter-spacing:.14em; text-transform:uppercase; margin:0; font-weight:600; }
  header .name { font-size:.9rem; font-weight:600; }
  header code { font-family:var(--mono); font-size:.8rem; color:var(--teal); }
  header .sub { font-family:var(--mono); font-size:.74rem; color:#7fa6a3; margin-left:auto; }
  main { max-width:1100px; margin:0 auto; padding:1.4rem 1.5rem; }
  a { color:var(--teal); }
  .muted { color:var(--steel); font-weight:normal; font-family:var(--mono); font-size:.74rem; }
  .meta { font-family:var(--mono); font-size:.74rem; color:var(--steel); margin:.2rem 0 1rem; }
  .meta b { color:var(--ink); font-weight:600; }
  .pill { display:inline-block; padding:.05rem .5rem; border-radius:10px; font-size:.7rem; font-family:var(--sans); }
  .pill.success { background:rgba(43,179,104,.15); color:var(--green); }
  .pill.error, .pill.test-failed { background:rgba(224,106,85,.16); color:var(--red); }
  .pill.build-error { background:rgba(202,162,60,.18); color:var(--amber); }
  .pill.running { background:rgba(202,162,60,.16); color:var(--amber); }
  .pill.pending, .pill.cancelled, .pill.interrupted, .pill.other { background:rgba(142,166,164,.15); color:var(--steel); }
  .prompt { background:#07211f; color:#bfe6df; font-family:var(--mono); font-size:.8rem; line-height:1.45;
            border:1px solid #0f3b37; border-radius:8px; padding:.8rem .9rem; white-space:pre-wrap; margin:0 0 1.2rem; }
  table { border-collapse:collapse; width:100%; margin:0 0 1.4rem; font-family:var(--mono); font-size:.78rem; }
  th { text-align:left; font-weight:500; color:var(--steel); font-size:.72rem; letter-spacing:.1em;
       text-transform:uppercase; padding:.35rem .6rem; border-bottom:1px solid var(--line); }
  td { padding:.35rem .6rem; border-bottom:1px solid var(--line); color:var(--ink); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td a { text-decoration:none; }
  .entry { background:var(--surface); border:1px solid var(--line); border-radius:8px;
           padding:1rem 1.2rem; margin:0 0 .9rem; }
  h2 { font-size:.92rem; font-weight:600; margin:0 0 .5rem; display:flex; align-items:baseline;
       gap:.6rem; flex-wrap:wrap; }
  .error { color:#ff9c8a; font-family:var(--mono); font-size:.78rem; white-space:pre-wrap; }
  .stages { margin:.4rem 0; }
  .stages .stage { display:inline-block; background:var(--circle); border:1px solid var(--line);
                   border-radius:6px; padding:.15rem .5rem; margin:0 .3rem .3rem 0;
                   font-family:var(--mono); font-size:.72rem; color:var(--steel); }
  .stages .stage b { color:var(--ink); font-weight:600; }
  .shot-strip { display:flex; flex-wrap:wrap; gap:.5rem; align-content:flex-start; margin-top:.5rem; }
  .shot { display:block; border:1px solid var(--line); border-radius:6px; overflow:hidden; text-decoration:none; }
  .shot:hover { border-color:var(--teal); }
  .shot img { display:block; width:150px; height:100px; object-fit:cover; object-position:top; background:var(--circle); }
  .shot .cap { display:block; font-size:.66rem; color:var(--steel); padding:.2rem .35rem; text-align:left; max-width:150px;
               font-family:var(--mono); overflow-wrap:anywhere; }
  .shot.fail { padding:.4rem .5rem; font-size:.7rem; color:#ff9c8a; max-width:220px; font-family:var(--mono); }
  .failures { list-style:none; margin:.4rem 0; padding:0; display:flex; flex-direction:column; gap:.5rem;
              font-family:var(--mono); font-size:.78rem; }
  .failures small { color:var(--steel); margin-left:.4rem; }
  .console, .failures pre { background:#07211f; color:#bfe6df; font-family:var(--mono); font-size:.78rem;
    line-height:1.45; border:1px solid #0f3b37; border-radius:8px; padding:.8rem .9rem;
    overflow:auto; white-space:pre-wrap; margin:.4rem 0 0; }
  .console { max-height:340px; }
  .failures pre { max-height:200px; }
  details summary { cursor:pointer; color:var(--steel); font-family:var(--mono); font-size:.72rem;
                    letter-spacing:.1em; text-transform:uppercase; }
  details summary:hover { color:var(--ink); }
  .tools { margin:.4rem 0; }
  .tools p { margin:.15rem 0; }
  .tools .warn { color:var(--amber); font-family:var(--mono); font-size:.74rem; }
  .tools-table { margin:.4rem 0 0; font-size:.74rem; }
  .tools-table th { text-transform:none; letter-spacing:0; }
</style>
</head>
<body>
<header>
  <h1>Matrix report</h1>
  ${meta.name ? `<span class="name">${esc(meta.name)}</span>` : ''}
  <code>${esc(matrixId)}</code>
  ${meta.cancelled ? '<span class="pill cancelled">cancelled</span>' : ''}
  <span class="sub">generated ${esc(generatedAt)}</span>
</header>
<main>
<p class="meta">model <b>${esc(meta.model)}</b> · ${entries.length} entries — ${esc(summary)} · total run time <b>${fmtMs(totalMs)}</b> · <b>${fmtTokens(totalTokens)}</b> tokens${costs.length ? ` · <b>${totalCost.toFixed(4)} USD</b>` : ''}</p>
<p class="meta">tokens: ${tokenSplit(tokenTotals)}</p>
<p class="prompt">${esc(meta.prompt)}</p>
${promptImages.length ? `<p class="meta">prompt images: <b>${promptImages.map((n) => esc(n)).join('</b>, <b>')}</b></p>` : ''}
<table>
<thead><tr><th>#</th><th>Platform</th><th>Variant</th><th>Status</th><th class="num">Duration</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Tests</th><th class="num">MCP</th><th class="num">Skill</th><th class="num">Shots</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
${entries.map((e, i) => entrySection(e, records[i])).join('\n')}
</main>
</body>
</html>
`;

  const summaryDoc = {
    matrixId,
    name: meta.name || null,
    generatedAt,
    model: meta.model,
    prompt: meta.prompt,
    promptImages,
    cancelled: meta.cancelled,
    totals: {
      entries: entries.length,
      byStatus: counts,
      allSucceeded: entries.length > 0 && records.every((r) => r?.status === 'success'),
      durationMs: totalMs,
      tokens: totalTokens,
      // Additive: `tokens` stays the total so existing CI assertions keep working.
      tokensBreakdown: {
        input: tokenTotals.input, output: tokenTotals.output,
        reasoning: tokenTotals.reasoning, cache: tokenTotals.cache,
      },
      cost: costs.length ? { amount: totalCost, currency: 'USD' } : null,
    },
    entries: entries.map((e, i) => {
      const r = records[i];
      return {
        index: e.index,
        runId: e.runId,
        platform: e.platform,
        variant: variantOf(e),
        mcps: e.mcps,
        skills: e.skills,
        localSkills: e.localSkills,
        status: r?.status || 'missing',
        error: r?.error || null,
        durationMs: r?.durationMs ?? null,
        stages: r?.stages?.timings || {},
        tokens: r?.stats?.tokens?.total ?? null,
        tokensBreakdown: r?.stats?.tokens
          ? {
            input: r.stats.tokens.input, output: r.stats.tokens.output,
            reasoning: r.stats.tokens.reasoning, cache: r.stats.tokens.cache,
          }
          : null,
        cost: r?.stats?.cost?.available ? r.stats!.cost.amount : null,
        tests: r?.tests
          ? { ran: r.tests.ran, ok: r.tests.ok, total: r.tests.total, passed: r.tests.passed, failed: r.tests.failed }
          : null,
        // Which tooling the agent actually exercised — the per-variant comparison a CI
        // consumer wants alongside pass/fail (a green run that never called the MCP
        // server proves the app builds, not that the toolchain works).
        tools: r?.tools
          ? {
            calls: r.tools.calls,
            errors: r.tools.errors,
            mcpCalls: r.tools.mcpCalls,
            skillCalls: r.tools.skillCalls,
            mcp: r.tools.tools.filter((t) => t.kind === 'mcp')
              .map((t) => ({ server: t.server, tool: t.name, calls: t.calls, errors: t.errors })),
            skills: r.tools.tools.filter((t) => t.kind === 'skill')
              .map((t) => ({ skill: t.name, calls: t.calls })),
            serversUnused: r.tools.servers.unused,
            skillsUnused: r.tools.skills.unused,
          }
          : null,
        screenshots: {
          ok: (r?.screenshots || []).filter((s) => s.ok).length,
          failed: (r?.screenshots || []).filter((s) => !s.ok).length,
        },
      };
    }),
  };

  const dir = path.join(REPORTS_DIR, matrixId);
  fs.mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, 'report.html');
  fs.writeFileSync(reportFile, html);
  const summaryFile = path.join(dir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summaryDoc, null, 2));
  return { reportFile, summaryFile };
}
