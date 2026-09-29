#!/usr/bin/env node
// Build a single HTML page that compares finished runs SIDE BY SIDE.
//
// Every existing surface is row-per-run: the History grid, the portable export and
// report.html all list a run and hide its screenshots inside a detail panel. That
// answers "how did this run go", not "which of these ten models built the better
// page" — and a model sweep is ten separate matrixIds (one container each), so no
// report.html can span it. This flips the axis: rows are ROUTES, columns are RUNS,
// so the same route across every model lines up horizontally. Screenshots are stored
// as sanitize(route) + '.png' with the route kept on the record, so that alignment is
// exact rather than positional.
//
// Host-side and static on purpose: a matrix config with "exitOnDone" leaves no
// container running, so the in-container UI is gone exactly when you want to compare.
//
//   node scripts/compare-runs.mjs                    every run in sessions/history
//   node scripts/compare-runs.mjs --name luna --name mimo
//   node scripts/compare-runs.mjs --since 12h --out /tmp/compare.html
//   node scripts/compare-runs.mjs --inline           self-contained (large) file
//
// Options: --dir <historyDir> --out <file> --since <ISO|Nh|Nd> --matrix <id,...>
//          --name <substr,...> --status <s,...> --limit <n> --inline
//          --jpeg [quality]  re-encode the inlined screenshots as JPEG (default 78).
//                            Full-page PNGs inline to ~13 MB; as JPEG the same page is
//                            a few MB, which is the difference between a page you can
//                            send someone and one they wait on.
//          --fragment        emit body-only HTML (no doctype/html/head/body) for hosts
//                            that supply their own document skeleton.
//          --title <text>    override the page title.
//
// Without --inline the page links into sessions/history/artifacts/, so it stays small
// but travels only with that folder. --inline embeds the PNGs and is portable.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { statusMeta, pillClass } from '../src/status-meta.ts';

const args = process.argv.slice(2);
const opt = {
  dir: path.join('sessions', 'history'), out: null, since: null,
  inline: false, limit: 0, matrix: [], name: [], status: [],
  fragment: false, title: null, jpeg: 0,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => { const v = args[++i]; if (v === undefined) die(a + ' needs a value'); return v; };
  switch (a) {
    case '--dir': opt.dir = val(); break;
    case '--out': opt.out = val(); break;
    case '--since': opt.since = val(); break;
    case '--matrix': opt.matrix.push(...val().split(',')); break;
    case '--name': opt.name.push(...val().split(',')); break;
    case '--status': opt.status.push(...val().split(',')); break;
    case '--limit': opt.limit = Number(val()) || 0; break;
    case '--inline': opt.inline = true; break;
    case '--fragment': opt.fragment = true; break;
    case '--title': opt.title = val(); break;
    case '--jpeg': {
      const nxt = args[i + 1];
      opt.jpeg = nxt && /^\d+$/.test(nxt) ? Number(args[++i]) : 78;
      break;
    }
    case '-h': case '--help': case 'help': usage(); process.exit(0); break;
    default: die('unknown argument: ' + a);
  }
}

function usage() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  const end = src.findIndex((l, i) => i > 1 && !l.startsWith('//'));
  console.log(src.slice(1, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

function die(msg) {
  console.error(msg);
  console.error('try: node scripts/compare-runs.mjs --help');
  process.exit(2);
}

// --since takes an ISO date or a relative "36h" / "7d" window.
function sinceMs(s) {
  if (!s) return 0;
  const m = /^(\d+)\s*([hd])$/i.exec(s.trim());
  if (m) return Date.now() - Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600e3 : 86400e3);
  const t = Date.parse(s);
  if (Number.isNaN(t)) die('--since: not a date or an Nh/Nd window: ' + s);
  return t;
}

const historyDir = path.resolve(opt.dir);
const artifactDir = path.join(historyDir, 'artifacts');
if (!fs.existsSync(historyDir)) die('history dir not found: ' + historyDir);

const floor = sinceMs(opt.since);
let records = fs.readdirSync(historyDir)
  .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8')); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => Date.parse(r.startedAt || '') >= floor)
  .filter((r) => !opt.matrix.length || opt.matrix.some((m) => (r.matrixId || '').includes(m)))
  .filter((r) => !opt.status.length || opt.status.includes(r.status))
  .filter((r) => !opt.name.length || opt.name.some((n) => {
    const hay = ((r.matrixName || '') + ' ' + (r.config?.models || []).join(' ')).toLowerCase();
    return hay.includes(n.toLowerCase());
  }))
  .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

if (opt.limit > 0) records = records.slice(-opt.limit);
if (!records.length) { console.error('no runs matched — nothing to compare'); process.exit(1); }

const outFile = path.resolve(opt.out || path.join(historyDir, 'compare.html'));
const outDir = path.dirname(outFile);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtMs = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
};
const fmtTok = (n) => (n == null ? '—'
  : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const fmtCost = (r) => (r.stats?.cost?.available ? '$' + (r.stats.cost.amount || 0).toFixed(4) : 'n/a');

let inlineBytes = 0;
const jpegCache = new Map();
function imageUrl(runId, file) {
  const abs = path.join(artifactDir, runId, file);
  if (!fs.existsSync(abs)) return null;
  if (opt.inline) {
    const hit = jpegCache.get(runId + '/' + file);
    if (hit) { inlineBytes += hit.length; return hit; }
    const buf = fs.readFileSync(abs);
    inlineBytes += buf.length;
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png';
    return 'data:image/' + mime + ';base64,' + buf.toString('base64');
  }
  let rel = null;
  try { rel = path.relative(outDir, abs); } catch { /* different drive */ }
  if (!rel || path.isAbsolute(rel)) return pathToFileURL(abs).href;
  return rel.split(path.sep).map(encodeURIComponent).join('/');
}

const variantOf = (c = {}) => {
  const mcps = (c.enabledMcps || []).length ? c.enabledMcps.join('+') : 'no mcp';
  return mcps + ' · ' + (c.skills ? 'skills' : 'no skills');
};

// One column per run. The label is the matrix name (the model, in a model sweep);
// duplicate labels get their platform appended so no two columns read the same.
const cols = records.map((r, i) => ({
  i,
  run: r,
  id: r.id,
  label: r.matrixName || (r.config?.models || [])[0] || r.id,
  model: (r.config?.models || [])[0] || '—',
  platform: r.config?.framework || '—',
  variant: variantOf(r.config),
  shots: new Map((r.screenshots || []).map((s) => [s.route, s])),
  liveDiags: (r.diagnostics || []).filter((d) => !d.resolvedAt && !d.supersededAt),
}));
const labelCount = {};
for (const c of cols) labelCount[c.label] = (labelCount[c.label] || 0) + 1;
for (const c of cols) if (labelCount[c.label] > 1) c.label = c.label + ' · ' + c.platform;

// Routes ordered by how many runs produced them: '/' first, then shared, then partial.
// A route only one run invented is not a comparison, so it gets its own section rather
// than a row that is one screenshot and nine blanks.
const routeHits = new Map();
for (const c of cols) for (const s of c.run.screenshots || []) routeHits.set(s.route, (routeHits.get(s.route) || 0) + 1);
const allRoutes = [...routeHits.keys()].sort((a, b) => {
  if (a === '/') return -1;
  if (b === '/') return 1;
  return (routeHits.get(b) - routeHits.get(a)) || a.localeCompare(b);
});
const sharedRoutes = allRoutes.filter((r) => r === '/' || routeHits.get(r) > 1);
const soloRoutes = allRoutes.filter((r) => !sharedRoutes.includes(r));

// Re-encode the inlined screenshots as JPEG. Chromium is the only image encoder on
// hand, so this borrows the browser Playwright already ships for the capture stage; a
// host with no browser at all keeps the PNGs and says so rather than failing the build.
async function buildJpegCache() {
  const wanted = [];
  for (const c of cols) {
    for (const s of c.run.screenshots || []) {
      if (!s.ok) continue;
      const abs = path.join(artifactDir, c.id, s.file);
      if (fs.existsSync(abs)) wanted.push({ key: c.id + '/' + s.file, abs });
    }
  }
  if (!wanted.length) return;
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { console.log('  note:    --jpeg needs playwright; keeping PNGs'); return; }
  let browser = null;
  for (const launch of [() => chromium.launch(), () => chromium.launch({ channel: 'chrome' }), () => chromium.launch({ channel: 'msedge' })]) {
    try { browser = await launch(); break; } catch { /* try the next one */ }
  }
  if (!browser) { console.log('  note:    --jpeg found no usable browser; keeping PNGs'); return; }
  try {
    const page = await browser.newPage();
    const q = Math.min(100, Math.max(1, opt.jpeg)) / 100;
    for (const w of wanted) {
      const src = 'data:image/png;base64,' + fs.readFileSync(w.abs).toString('base64');
      const out = await page.evaluate(async ([src, q]) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        return cv.toDataURL('image/jpeg', q);
      }, [src, q]);
      if (out && out.startsWith('data:image/jpeg')) jpegCache.set(w.key, out);
    }
  } finally {
    await browser.close();
  }
}
if (opt.inline && opt.jpeg) await buildJpegCache();

const median = (xs) => {
  const v = xs.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const medDur = median(cols.map((c) => c.run.durationMs));
const medTok = median(cols.map((c) => c.run.stats?.tokens?.total));
const medCost = median(cols.map((c) => (c.run.stats?.cost?.available ? c.run.stats.cost.amount : null)));

// Ten raw numbers do not rank themselves; ten ratios against the median do.
const delta = (v, med) => {
  if (v == null || !med || !Number.isFinite(v) || v <= 0) return '';
  const cls = v > med * 1.15 ? 'hi' : v < med * 0.85 ? 'lo' : '';
  return '<span class="dx ' + cls + '">' + (v / med).toFixed(2) + '×</span>';
};

const pill = (s) => '<span class="pill ' + pillClass(s || 'other') + '" title="' + esc(statusMeta(s || '').label) + '">' + esc(s || 'missing') + '</span>';

function cellFor(c, route) {
  const shot = c.shots.get(route);
  const url = shot?.ok ? imageUrl(c.id, shot.file) : null;
  const attrs = 'data-route="' + esc(route) + '" data-col="' + c.i + '" data-label="' + esc(c.label) + '" data-status="' + esc(c.run.status) + '"';
  if (url) {
    return '<div class="cell shot" ' + attrs + ' data-src="' + esc(url) + '" tabindex="0">' +
      '<img src="' + esc(url) + '" alt="' + esc(c.label + ' ' + route) + '" loading="lazy"></div>';
  }
  // Never render an ambiguous blank — say which of the reasons it is.
  let why = 'route absent';
  if (shot && !shot.ok) why = 'capture failed';
  else if (shot?.ok) why = 'image file missing';
  else if (c.run.status === 'build-error') why = 'build failed';
  else if (c.run.status === 'running' || c.run.status === 'pending') why = 'still running';
  else if (!(c.run.screenshots || []).length) why = 'no screenshots · ' + c.run.status;
  return '<div class="cell empty" ' + attrs + '><span>' + esc(why) + '</span></div>';
}

function headCell(c) {
  const t = c.run.tools;
  const tests = c.run.tests?.ran ? c.run.tests.passed + '/' + c.run.tests.total : '—';
  const unused = [...(t?.servers?.unused || []), ...(t?.skills?.unused || [])];
  return '<div class="cell head">' +
    '<div class="h-label" title="' + esc(c.model) + '">' + esc(c.label) + '</div>' +
    '<div class="h-sub">' + esc(c.platform) + ' · ' + esc(c.variant) + '</div>' +
    '<div class="h-row">' + pill(c.run.status) + '<span class="h-tests">tests ' + esc(tests) + '</span></div>' +
    '<div class="h-metrics">' +
      '<span title="duration">' + esc(fmtMs(c.run.durationMs)) + '</span>' +
      '<span title="tokens">' + esc(fmtTok(c.run.stats?.tokens?.total)) + '</span>' +
      '<span title="cost">' + esc(fmtCost(c.run)) + '</span>' +
      '<span class="' + (t ? (t.mcpCalls ? '' : 'bad') : 'none') + '" title="MCP calls · skill invocations">' +
        (t ? t.mcpCalls + ' · ' + t.skillCalls : '—') + '</span>' +
    '</div>' +
    (unused.length ? '<div class="h-unused" title="' + esc(unused.join(', ')) + '">' + unused.length + ' never used</div>' : '') +
    (c.liveDiags.length ? '<div class="h-diag" title="' + esc(c.liveDiags.map((d) => d.title).join(' · ')) + '">⚠ ' + c.liveDiags.length + '</div>' : '') +
    '</div>';
}

function sheet(routes, id) {
  if (!routes.length) return '';
  const head = cols.map(headCell).join('');
  const rows = routes.map((route) =>
    '<div class="cell route" title="' + esc(route) + '">' + esc(route) +
      '<small>' + routeHits.get(route) + '/' + cols.length + '</small></div>' +
    cols.map((c) => cellFor(c, route)).join('')).join('');
  // A second scrollbar above the sheet: with sticky column headers the real one at the
  // bottom is often off-screen, so scrolling to a run on the right meant scrolling the
  // page down first. The spacer is sized to the sheet's scrollWidth and the two
  // containers mirror each other's scrollLeft.
  return '<div class="sheet-block">' +
    '<div class="sheet-scroll" aria-hidden="true"><div class="sheet-scroll-inner"></div></div>' +
    '<div class="sheet-wrap"><div class="sheet" id="' + id + '" style="--n:' + cols.length + '">' +
    '<div class="cell head corner">route</div>' + head + rows + '</div></div></div>';
}

const board = cols.map((c) => {
  const r = c.run;
  const t = r.tools;
  const dur = r.durationMs;
  const tok = r.stats?.tokens?.total;
  const cost = r.stats?.cost?.available ? r.stats.cost.amount : null;
  const shots = (r.screenshots || []).filter((s) => s.ok).length;
  const unused = [...(t?.servers?.unused || []), ...(t?.skills?.unused || [])];
  return '<tr>' +
    '<td data-sort="' + c.i + '">' + esc(c.label) + '<div class="sub">' + esc(c.model) + '</div></td>' +
    '<td data-sort="' + esc(r.status) + '">' + pill(r.status) + '</td>' +
    '<td class="num" data-sort="' + (r.tests?.ran ? r.tests.passed / Math.max(1, r.tests.total) : -1) + '">' +
      (r.tests?.ran ? r.tests.passed + '/' + r.tests.total : '—') + '</td>' +
    '<td class="num" data-sort="' + (dur ?? -1) + '">' + esc(fmtMs(dur)) + ' ' + delta(dur, medDur) + '</td>' +
    '<td class="num" data-sort="' + (tok ?? -1) + '">' + esc(fmtTok(tok)) + ' ' + delta(tok, medTok) + '</td>' +
    '<td class="num" data-sort="' + (cost ?? -1) + '">' + esc(fmtCost(r)) + ' ' + delta(cost, medCost) + '</td>' +
    '<td class="num ' + (t && !t.mcpCalls ? 'bad' : '') + '" data-sort="' + (t?.mcpCalls ?? -1) + '">' + (t ? t.mcpCalls : '—') + '</td>' +
    '<td class="num" data-sort="' + (t?.skillCalls ?? -1) + '">' + (t ? t.skillCalls : '—') + '</td>' +
    '<td class="num" data-sort="' + unused.length + '" title="' + esc(unused.join(', ')) + '">' + (t ? (unused.length || '—') : '—') + '</td>' +
    '<td class="num ' + (c.liveDiags.length ? 'warn' : '') + '" data-sort="' + c.liveDiags.length + '" title="' +
      esc(c.liveDiags.map((d) => d.title).join(' · ')) + '">' + (c.liveDiags.length || '—') + '</td>' +
    '<td class="num" data-sort="' + shots + '">' + shots + '</td>' +
    '<td class="num" data-sort="' + (r.rating ?? -1) + '">' + (r.rating ? '★'.repeat(r.rating) : '—') + '</td>' +
    '</tr>';
}).join('');

const prompts = [...new Set(records.map((r) => r.prompt).filter(Boolean))];
const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
const statusCounts = {};
for (const c of cols) statusCounts[c.run.status] = (statusCounts[c.run.status] || 0) + 1;
const countLine = Object.entries(statusCounts).map(([s, n]) => n + ' ' + s).join(' · ');

// Client script: no template literals (this file is one), no dependencies.
const clientJs = [
  "var sheets=document.querySelectorAll('.sheet');",
  "var zoom=document.getElementById('zoom'), fitBox=document.getElementById('fit');",
  "function applyView(){",
  "  var w=zoom.value+'px';",
  "  sheets.forEach(function(s){ s.style.setProperty('--cw',w); s.classList.toggle('contain',fitBox.checked); });",
  "  sizeBars();",
  "}",
  // Mirror scrollbar above each sheet. The spacer carries the sheet's full width so the
  // browser gives the top strip a real thumb; the two containers copy scrollLeft to each
  // other, guarded so the echo does not bounce back.
  "var blocks=[].slice.call(document.querySelectorAll('.sheet-block')).map(function(b){",
  "  var wrap=b.querySelector('.sheet-wrap'), bar=b.querySelector('.sheet-scroll'),",
  "      inner=b.querySelector('.sheet-scroll-inner'), sheet=b.querySelector('.sheet'), lock=false;",
  "  bar.addEventListener('scroll',function(){ if(lock){lock=false;return;} lock=true; wrap.scrollLeft=bar.scrollLeft; });",
  "  wrap.addEventListener('scroll',function(){ if(lock){lock=false;return;} lock=true; bar.scrollLeft=wrap.scrollLeft; });",
  "  return {wrap:wrap,bar:bar,inner:inner,sheet:sheet};",
  "});",
  "function sizeBars(){ blocks.forEach(function(b){",
  "  var w=b.sheet.scrollWidth; b.inner.style.width=w+'px';",
  "  b.bar.classList.toggle('hidden', w<=b.wrap.clientWidth+1);",
  "  b.wrap.classList.toggle('no-top', w<=b.wrap.clientWidth+1);",
  "}); }",
  "window.addEventListener('resize',sizeBars);",
  "zoom.addEventListener('input',applyView); fitBox.addEventListener('change',applyView); applyView(); sizeBars();",
  // Lightbox. Left/right step ACROSS models on the same route — that is the comparison
  // axis; up/down step across routes within one model.
  "var cells=[].slice.call(document.querySelectorAll('.cell.shot'));",
  "var lb=document.getElementById('lb'), lbImg=document.getElementById('lb-img'), lbCap=document.getElementById('lb-cap');",
  "var cur=-1;",
  "function open(i){ if(i<0||i>=cells.length)return; cur=i; var c=cells[i];",
  "  lbImg.src=c.getAttribute('data-src');",
  "  lbCap.textContent=c.getAttribute('data-label')+'  —  '+c.getAttribute('data-route')+'  ('+c.getAttribute('data-status')+')';",
  "  lb.classList.add('on'); }",
  "function close(){ lb.classList.remove('on'); lbImg.src=''; cur=-1; }",
  "function step(dRoute,dCol){ if(cur<0)return; var c=cells[cur];",
  "  var route=c.getAttribute('data-route'), col=+c.getAttribute('data-col');",
  "  var routes=[]; cells.forEach(function(x){ var r=x.getAttribute('data-route'); if(routes.indexOf(r)<0)routes.push(r); });",
  "  if(dCol){ var same=cells.filter(function(x){return x.getAttribute('data-route')===route;});",
  "    var at=same.indexOf(c); var nx=same[(at+dCol+same.length)%same.length]; open(cells.indexOf(nx)); return; }",
  "  var ri=routes.indexOf(route);",
  "  for(var k=1;k<=routes.length;k++){ var nr=routes[(ri+dRoute*k+routes.length*k)%routes.length];",
  "    var hit=cells.filter(function(x){return x.getAttribute('data-route')===nr;});",
  "    if(!hit.length)continue;",
  "    var best=hit.filter(function(x){return +x.getAttribute('data-col')===col;})[0]||hit[0];",
  "    open(cells.indexOf(best)); return; } }",
  "cells.forEach(function(c,i){ c.addEventListener('click',function(){open(i);});",
  "  c.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){e.preventDefault();open(i);} }); });",
  "lb.addEventListener('click',function(e){ if(e.target===lb||e.target.id==='lb-close')close(); });",
  "document.addEventListener('keydown',function(e){ if(!lb.classList.contains('on'))return;",
  "  if(e.key==='Escape')close();",
  "  else if(e.key==='ArrowRight')step(0,1); else if(e.key==='ArrowLeft')step(0,-1);",
  "  else if(e.key==='ArrowDown')step(1,0); else if(e.key==='ArrowUp')step(-1,0);",
  "  else return; e.preventDefault(); });",
  // Leaderboard sorting.
  "var tbl=document.getElementById('board');",
  "tbl.querySelectorAll('th').forEach(function(th,idx){ th.addEventListener('click',function(){",
  "  var dir=th.classList.contains('asc')?-1:1;",
  "  tbl.querySelectorAll('th').forEach(function(o){o.classList.remove('asc','desc');});",
  "  th.classList.add(dir===1?'asc':'desc');",
  "  var body=tbl.tBodies[0]; var rows=[].slice.call(body.rows);",
  "  rows.sort(function(a,b){ var x=a.cells[idx].getAttribute('data-sort'), y=b.cells[idx].getAttribute('data-sort');",
  "    var nx=parseFloat(x), ny=parseFloat(y);",
  "    if(!isNaN(nx)&&!isNaN(ny))return (nx-ny)*dir;",
  "    return String(x).localeCompare(String(y))*dir; });",
  "  rows.forEach(function(r){body.appendChild(r);}); }); });",
].join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opt.title || ('Run comparison — ' + cols.length + ' runs'))}</title>
<style>
  /* Palette mirrors src/matrix/report.ts so this reads as part of the same toolchain. */
  :root {
    --ink:#e7f0ef; --steel:#8ea6a4; --fog:#0a1211; --surface:#10201e;
    --header:#070d0c; --line:#20342f; --teal:#1aa99e;
    --green:#2bb368; --amber:#caa23c; --red:#e06a55;
    --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    --sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--fog); color:var(--ink); font-family:var(--sans); line-height:1.5;
         -webkit-font-smoothing:antialiased; }
  header { display:flex; align-items:baseline; gap:.7rem; flex-wrap:wrap; padding:1rem 1.4rem;
           background:var(--header); border-bottom:3px solid var(--teal); }
  header h1 { font-size:.95rem; letter-spacing:.14em; text-transform:uppercase; margin:0; font-weight:600; }
  header .sub { font-family:var(--mono); font-size:.74rem; color:#7fa6a3; margin-left:auto; }
  main { padding:1.2rem 1.4rem 3rem; }
  h2 { font-size:.8rem; letter-spacing:.12em; text-transform:uppercase; color:var(--steel);
       margin:1.8rem 0 .6rem; font-weight:600; }
  .meta { font-family:var(--mono); font-size:.74rem; color:var(--steel); margin:.2rem 0 1rem; }
  .meta b { color:var(--ink); font-weight:600; }
  .prompt { background:#07211f; color:#bfe6df; font-family:var(--mono); font-size:.78rem;
            border:1px solid #0f3b37; border-radius:8px; padding:.7rem .85rem; white-space:pre-wrap; margin:0 0 1rem; }
  .pill { display:inline-block; padding:.05rem .5rem; border-radius:10px; font-size:.68rem; }
  .pill.success { background:rgba(43,179,104,.15); color:var(--green); }
  .pill.error, .pill.test-failed { background:rgba(224,106,85,.16); color:var(--red); }
  .pill.build-error, .pill.rate-limited, .pill.provider-down, .pill.no-credits,
  .pill.auth, .pill.timed-out, .pill.running { background:rgba(202,162,60,.18); color:var(--amber); }
  .pill.pending, .pill.cancelled, .pill.interrupted, .pill.other { background:rgba(142,166,164,.15); color:var(--steel); }

  table { border-collapse:collapse; width:100%; font-family:var(--mono); font-size:.76rem; }
  th { text-align:left; font-weight:500; color:var(--steel); font-size:.68rem; letter-spacing:.09em;
       text-transform:uppercase; padding:.35rem .55rem; border-bottom:1px solid var(--line);
       cursor:pointer; user-select:none; white-space:nowrap; }
  th:hover { color:var(--ink); }
  th.asc::after { content:" ▲"; color:var(--teal); }
  th.desc::after { content:" ▼"; color:var(--teal); }
  td { padding:.35rem .55rem; border-bottom:1px solid var(--line); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td .sub { color:var(--steel); font-size:.68rem; }
  td.bad { color:var(--red); }
  td.warn { color:var(--amber); }
  .dx { color:var(--steel); font-size:.68rem; }
  .dx.hi { color:var(--amber); }
  .dx.lo { color:var(--green); }

  .controls { display:flex; align-items:center; gap:1.2rem; flex-wrap:wrap;
              font-family:var(--mono); font-size:.72rem; color:var(--steel); margin:.4rem 0 .8rem; }
  .controls input[type=range] { width:170px; vertical-align:middle; }
  .controls label { cursor:pointer; }

  .sheet-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:0 0 8px 8px; background:var(--surface); }
  .sheet-block .sheet-wrap.no-top { border-radius:8px; }
  /* Mirror of the sheet's horizontal scrollbar, above the table. Explicit ::-webkit
     rules so it stays visible on platforms that use overlay scrollbars. */
  /* An explicit height is load-bearing: the scrollbar is drawn INSIDE this element's
     box, and with only the 1px spacer for content there is nowhere for it to render. */
  .sheet-scroll { overflow-x:auto; overflow-y:hidden; height:15px; background:var(--surface);
                  border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; }
  .sheet-scroll-inner { height:1px; }
  .sheet-scroll::-webkit-scrollbar { height:12px; }
  .sheet-scroll::-webkit-scrollbar-track { background:#0c1a18; border-radius:6px; }
  .sheet-scroll::-webkit-scrollbar-thumb { background:#3d6560; border-radius:6px; }
  .sheet-scroll::-webkit-scrollbar-thumb:hover { background:#39605c; }
  .sheet-scroll { scrollbar-width:thin; scrollbar-color:#3d6560 #0c1a18; }
  .sheet-scroll.hidden { display:none; }
  .sheet { --cw:260px; display:grid; grid-template-columns:130px repeat(var(--n), var(--cw));
           width:max-content; min-width:100%; }
  .cell { border-right:1px solid var(--line); border-bottom:1px solid var(--line); min-width:0; }
  .cell.head { position:sticky; top:0; z-index:2; background:var(--header); padding:.5rem .6rem; }
  .cell.corner { position:sticky; left:0; z-index:3; font-family:var(--mono); font-size:.68rem;
                 color:var(--steel); text-transform:uppercase; letter-spacing:.09em; }
  .h-label { font-weight:600; font-size:.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .h-sub { font-family:var(--mono); font-size:.66rem; color:var(--steel); overflow:hidden;
           text-overflow:ellipsis; white-space:nowrap; }
  .h-row { display:flex; align-items:center; gap:.4rem; margin:.25rem 0 .15rem; }
  .h-tests { font-family:var(--mono); font-size:.66rem; color:var(--steel); }
  .h-metrics { display:flex; gap:.5rem; font-family:var(--mono); font-size:.68rem; color:var(--steel); flex-wrap:wrap; }
  .h-metrics .bad { color:var(--red); }
  .h-metrics .none { color:var(--steel); }
  .h-unused { font-family:var(--mono); font-size:.64rem; color:var(--amber); margin-top:.15rem; }
  .h-diag { font-family:var(--mono); font-size:.64rem; color:var(--amber); }
  .cell.route { position:sticky; left:0; z-index:1; background:var(--header); padding:.5rem .6rem;
                font-family:var(--mono); font-size:.72rem; color:var(--ink); overflow-wrap:anywhere; }
  .cell.route small { display:block; color:var(--steel); font-size:.64rem; }
  .cell.shot { padding:0; cursor:zoom-in; background:#000; }
  .cell.shot img { display:block; width:100%; height:calc(var(--cw) * 0.72); object-fit:cover;
                   object-position:top center; }
  .sheet.contain .cell.shot img { object-fit:contain; background:#05100f; }
  .cell.shot:focus { outline:2px solid var(--teal); outline-offset:-2px; }
  .cell.empty { display:flex; align-items:center; justify-content:center; padding:.6rem;
                min-height:calc(var(--cw) * 0.72); background:repeating-linear-gradient(45deg,#0c1a18,#0c1a18 8px,#0a1615 8px,#0a1615 16px);
                font-family:var(--mono); font-size:.68rem; color:var(--steel); text-align:center; }

  #lb { position:fixed; inset:0; background:rgba(3,8,8,.94); display:none; z-index:20;
        align-items:center; justify-content:center; flex-direction:column; gap:.7rem; padding:1.2rem; }
  #lb.on { display:flex; }
  #lb img { max-width:96vw; max-height:84vh; object-fit:contain; border:1px solid var(--line); background:#000; }
  #lb-cap { font-family:var(--mono); font-size:.8rem; color:var(--ink); }
  #lb-hint { font-family:var(--mono); font-size:.7rem; color:var(--steel); }
  #lb-close { position:absolute; top:.8rem; right:1.1rem; background:none; border:none;
              color:var(--steel); font-size:1.6rem; cursor:pointer; line-height:1; }
  .note { font-family:var(--mono); font-size:.72rem; color:var(--steel); margin:.6rem 0; }
</style>
</head>
<body>
<header>
  <h1>Run comparison</h1>
  <span class="sub">${esc(generatedAt)} UTC &nbsp;•&nbsp; ${cols.length} run${cols.length === 1 ? '' : 's'} &nbsp;•&nbsp; ${esc(countLine)}</span>
</header>
<main>

<div class="meta">
  Source: <b>${esc(historyDir)}</b>${opt.inline ? ' · images inlined' : ' · images linked from artifacts/'}
  ${prompts.length === 1 ? '' : ' · <b>prompts differ across these runs</b> — compare with that in mind'}
</div>
${prompts.length === 1 ? '<div class="prompt">' + esc(prompts[0]) + '</div>' : ''}

<h2>Leaderboard</h2>
<div class="note">Click a column to sort. Ratios are against the median of these runs (amber = above, green = below).
MCP calls of 0 means the agent never reached the server, whatever the screenshot looks like.</div>
<table id="board">
<thead><tr>
  <th>Run</th><th>Status</th><th class="num">Tests</th><th class="num">Duration</th>
  <th class="num">Tokens</th><th class="num">Cost</th><th class="num">MCP</th><th class="num">Skill</th>
  <th class="num">Unused</th><th class="num">Diag</th><th class="num">Shots</th><th class="num">Rating</th>
</tr></thead>
<tbody>${board}</tbody>
</table>

<h2>Screenshots by route</h2>
<div class="controls">
  <span>column width <input type="range" id="zoom" min="160" max="620" value="260"></span>
  <label><input type="checkbox" id="fit"> fit whole page (no crop)</label>
  <span>click a shot to enlarge · ←/→ same route across runs · ↑/↓ other routes</span>
</div>
${sheet(sharedRoutes, 'sheet-shared') || '<div class="note">No screenshots yet.</div>'}

${soloRoutes.length ? '<h2>Routes only one run produced</h2><div class="note">Not a comparison — each of these exists in a single run.</div>' + sheet(soloRoutes, 'sheet-solo') : ''}

</main>
<div id="lb">
  <button id="lb-close" aria-label="Close">×</button>
  <img id="lb-img" src="" alt="">
  <div id="lb-cap"></div>
  <div id="lb-hint">←/→ same route, other run &nbsp;·&nbsp; ↑/↓ other route &nbsp;·&nbsp; Esc closes</div>
</div>
<script>
${clientJs}
</script>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });

// Fragment mode: hand back the page's own <title>, <style> and body content, leaving the
// document skeleton to the host that asked for it. Extraction rather than a second
// template, so the two forms can never drift apart.
let output = html;
if (opt.fragment) {
  const title = (html.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
  const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  output = [title, style, body].join('\n');
}
fs.writeFileSync(outFile, output);

const size = fs.statSync(outFile).size;
console.log('compare page: ' + outFile);
console.log('  runs:    ' + cols.length + ' (' + countLine + ')');
console.log('  routes:  ' + sharedRoutes.length + ' shared, ' + soloRoutes.length + ' single-run');
console.log('  size:    ' + (size / 1048576).toFixed(2) + ' MB' + (opt.inline ? ' (images inlined)' : ' (images linked)'));
if (!opt.inline) console.log('  note:    links into ' + artifactDir + ' — keep it alongside, or re-run with --inline to embed');
if (opt.inline && inlineBytes > 60 * 1048576) console.log('  warning: over 60 MB of images embedded; browsers may open it slowly');
