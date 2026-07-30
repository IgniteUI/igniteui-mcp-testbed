'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { HistoryRecord } from './types.ts';
import { ARTIFACT_DIR } from './config.ts';

// Read a screenshot file and return a base64 data-URL, or null on any error.
async function toDataUrl(runId: string, filename: string): Promise<string | null> {
  try {
    const p = path.join(ARTIFACT_DIR, runId, filename);
    const buf = await fs.promises.readFile(p);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export interface ExportShot {
  route: string;
  ok: boolean;
  dataUrl: string | null;
}

export interface ExportRun extends Omit<HistoryRecord, 'screenshots'> {
  screenshotData: ExportShot[];
}

// Enrich each history record with base64-encoded screenshot data-URLs.
// The original `screenshots` array (server file paths) is replaced with
// `screenshotData` (route + ok flag + data-URL) so the result is fully portable.
export async function buildExportRuns(runs: HistoryRecord[]): Promise<ExportRun[]> {
  return Promise.all(
    runs.map(async (r) => {
      const screenshotData: ExportShot[] = await Promise.all(
        (r.screenshots || []).map(async (s) => ({
          route: s.route,
          ok: s.ok,
          dataUrl: s.ok ? await toDataUrl(r.id, s.file) : null,
        })),
      );
      const { screenshots: _dropped, ...rest } = r as any;
      return { ...rest, screenshotData } as ExportRun;
    }),
  );
}

// Build the complete self-contained export HTML string.
export async function buildExportHtml(runs: HistoryRecord[]): Promise<string> {
  const exportRuns = await buildExportRuns(runs);

  const exportedAt = new Date().toISOString();
  // JSON.stringify with minimal escaping; the string is embedded inside a <script> block.
  // We escape </script> occurrences to prevent early termination.
  const dataJson = JSON.stringify(exportRuns).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ignite UI Run History &mdash; ${exportedAt.slice(0, 10)}</title>
<style>
:root{--ink:#e7f0ef;--steel:#8ea6a4;--fog:#0a1211;--surface:#10201e;--header:#070d0c;--line:#20342f;--teal:#1aa99e;--green:#2bb368;--amber:#caa23c;--red:#e06a55;--mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;--sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--fog);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.5}
header{display:flex;align-items:center;gap:.7rem;padding:.9rem 1.4rem;background:var(--header);border-bottom:3px solid var(--teal);flex-wrap:wrap;row-gap:.3rem}
header h1{font-size:.95rem;letter-spacing:.14em;text-transform:uppercase;margin:0;font-weight:600}
.sub{font-family:var(--mono);font-size:.72rem;color:#7fa6a3;margin-left:auto}
.toolbar{display:flex;align-items:center;gap:.8rem;padding:.55rem 1rem;border-bottom:1px solid var(--line);background:var(--surface)}
.toolbar input{background:var(--fog);border:1px solid var(--line);color:var(--ink);font-family:var(--mono);font-size:.79rem;border-radius:4px;padding:.28rem .6rem;flex:1;max-width:320px;outline:none}
.toolbar input:focus{border-color:var(--teal)}
.run-count{font-family:var(--mono);font-size:.73rem;color:var(--steel);white-space:nowrap}
table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:.78rem}
thead th{text-align:left;font-weight:500;color:var(--steel);border-bottom:1px solid var(--line);padding:.5rem .6rem;cursor:pointer;white-space:nowrap;user-select:none;background:var(--fog)}
thead th:hover{color:var(--ink)}
thead th.sort-asc::after{content:" \u25b2";color:var(--teal)}
thead th.sort-desc::after{content:" \u25bc";color:var(--teal)}
tbody tr.run-row{border-bottom:1px solid var(--line);cursor:pointer}
tbody tr.run-row:hover{background:#13312c}
tbody tr.run-row td{padding:.42rem .6rem;color:var(--ink);vertical-align:middle}
tbody tr.detail-row td{padding:0;background:#07211f}
tbody tr.detail-row{display:none}
tbody tr.detail-row.open{display:table-row}
.pill{display:inline-block;padding:.05rem .5rem;border-radius:10px;font-size:.7rem}
.pill.success{background:rgba(43,179,104,.15);color:var(--green)}
.pill.error{background:rgba(224,106,85,.16);color:var(--red)}
.pill.build-error{background:rgba(202,162,60,.18);color:var(--amber)}
.pill.test-failed{background:rgba(224,106,85,.16);color:var(--red)}
.pill.running,.pill.pending{background:rgba(202,162,60,.16);color:var(--amber)}
.pill.cancelled,.pill.interrupted{background:rgba(142,166,164,.15);color:var(--steel)}
.mxtag{display:inline-block;padding:.05rem .45rem;border-radius:10px;font-size:.7rem;border:1px solid currentColor}
.num-r{text-align:right;display:block;font-variant-numeric:tabular-nums}
.stars{color:var(--amber);font-size:.85rem;letter-spacing:.04em}
.chevron{display:inline-block;transition:transform .15s;color:var(--steel);margin-right:.35rem;font-size:.7rem}
tr.run-row.expanded .chevron{transform:rotate(90deg)}
.detail{padding:.9rem 1rem;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem 1.6rem;font-family:var(--mono);font-size:.78rem}
@media(max-width:760px){.detail{grid-template-columns:1fr}}
.detail h4{margin:0 0 .4rem;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--steel)}
.detail dl{margin:0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.15rem .7rem}
.detail dt{color:var(--steel)}
.detail dd{margin:0;text-align:right;color:var(--ink);overflow-wrap:anywhere}
.full-col{grid-column:1/-1}
.detail-err{color:#ff9c8a}
.detail-note{color:#bfe6df;margin:.25rem 0 0;white-space:pre-wrap;word-break:break-word}
.shots-wrap{grid-column:1/-1}
.shot-strip{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}
.shot-btn{background:none;border:1px solid var(--line);border-radius:6px;overflow:hidden;cursor:pointer;padding:0;display:block}
.shot-btn:hover{border-color:var(--teal)}
.shot-btn img{display:block;width:150px;height:100px;object-fit:cover;object-position:top;background:#0c1a18}
.shot-btn .cap{display:block;font-size:.66rem;color:var(--steel);padding:.2rem .35rem;text-align:left;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shot-fail{display:inline-block;padding:.4rem .5rem;font-size:.7rem;color:#ff9c8a;border:1px solid var(--line);border-radius:6px}
.log-details summary{cursor:pointer;color:var(--steel);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;user-select:none}
.log-pre{max-height:300px;overflow:auto;white-space:pre-wrap;font-family:var(--mono);font-size:.71rem;line-height:1.42;color:var(--steel);background:#050f0e;margin:.4rem 0 0;padding:.6rem .8rem;border:1px solid var(--line);border-radius:4px}
/* MCP-tool / skill usage */
.num-r.idle{color:var(--red);font-weight:600}
.num-r.unused{color:var(--amber)}
.num-r.none{color:var(--steel)}
.tool-summary{margin:.1rem 0 .3rem;color:var(--ink)}
.tool-warn{margin:.15rem 0;color:var(--amber)}
.tool-lists{margin:.2rem 0;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.15rem .7rem}
.tool-lists dt{color:var(--steel)}
.tool-lists dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.tool-table{width:100%;border-collapse:collapse;margin:.4rem 0 0;font-size:.72rem}
.tool-table th{text-align:left;color:var(--steel);font-weight:500;padding:.15rem .5rem .15rem 0}
.tool-table td{padding:.1rem .5rem .1rem 0;color:var(--ink);overflow-wrap:anywhere}
.tool-table tr.mcp td:first-child{color:var(--teal)}
.tool-table tr.skill td:first-child{color:var(--green)}
.tool-table tr.builtin td:first-child{color:var(--steel)}
/* Lightbox */
#lb{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center}
#lb.open{display:flex}
#lb-bd{position:absolute;inset:0;background:rgba(0,0,0,.90);cursor:pointer}
#lb-wrap{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:.4rem;max-width:90vw}
#lb-inner{display:flex;align-items:center;gap:.75rem}
#lb-img{display:block;max-width:82vw;max-height:78vh;object-fit:contain;border-radius:6px;background:#0c1a18;box-shadow:0 6px 32px rgba(0,0,0,.65)}
#lb-meta{font-family:var(--mono);font-size:.73rem;color:var(--steel);display:flex;justify-content:space-between;width:100%;padding:0 .2rem;gap:1rem}
#lb-close{position:fixed;top:1rem;right:1.2rem;z-index:10001;background:rgba(7,33,31,.9);border:1px solid #20342f;color:#8ea6a4;font-size:1.2rem;border-radius:50%;width:2rem;height:2rem;cursor:pointer;display:grid;place-items:center}
#lb-close:hover{color:#e7f0ef}
.lb-nav{background:rgba(7,33,31,.85);border:1px solid #20342f;color:#8ea6a4;font-size:2rem;border-radius:6px;width:2.5rem;height:4.5rem;cursor:pointer;display:grid;place-items:center;flex-shrink:0}
.lb-nav:hover:not([disabled]){color:#e7f0ef;background:rgba(26,169,158,.18);border-color:#1aa99e}
.lb-nav[disabled]{opacity:.25;cursor:not-allowed}
</style>
</head>
<body>
<header>
  <h1>&#9670; Ignite UI Run History</h1>
  <span class="sub">Exported ${exportedAt.replace('T', ' ').slice(0, 19)} UTC &nbsp;&bull;&nbsp; ${exportRuns.length} run${exportRuns.length === 1 ? '' : 's'}</span>
</header>
<div class="toolbar">
  <input id="filter-input" type="search" placeholder="Filter runs\u2026" aria-label="Filter runs" />
  <span class="run-count" id="run-count"></span>
</div>
<div style="overflow-x:auto">
  <table id="runs-table"></table>
</div>

<!-- Simple lightbox (no external deps) -->
<div id="lb" role="dialog" aria-modal="true" aria-label="Screenshot">
  <div id="lb-bd"></div>
  <button id="lb-close" aria-label="Close">&times;</button>
  <div id="lb-wrap">
    <div id="lb-inner">
      <button class="lb-nav" id="lb-prev" aria-label="Previous">&#x2039;</button>
      <img id="lb-img" src="" alt="" />
      <button class="lb-nav" id="lb-next" aria-label="Next">&#x203A;</button>
    </div>
    <div id="lb-meta">
      <span id="lb-cap"></span>
      <span id="lb-counter"></span>
    </div>
  </div>
</div>

<script>
const RUNS = ${dataJson};

// ---- Utilities ----
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtWhen(iso){if(!iso)return'\u2014';const d=new Date(iso);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())}
function pad(n){return String(n).padStart(2,'0')}
function fmtDur(ms){if(ms==null)return'\u2014';if(ms<1000)return ms+'ms';if(ms<60000)return(ms/1000).toFixed(1)+'s';return Math.floor(ms/60000)+'m '+Math.floor((ms%60000)/1000)+'s'}
function fmt(n){return n==null?'\u2014':Number(n).toLocaleString()}
function stars(n){if(!n)return'\u2014';return'\u2605'.repeat(n)+'\u2606'.repeat(5-n)}
function skillSummary(c){const xs=(c.excludedSkills||[]).length;const gen=c.skills?(xs?'default (-'+xs+')':'default'):null;if(c.overrideSkills){if(c.localSkillsOnly||!c.skills)return'local';return gen+' + local'}return gen||'off'}
/* Tool calls are usually tens of ms; fmtDur would render those as "0.1s". */
function fmtToolMs(ms){if(!ms)return'—';return ms<1000?Math.round(ms)+'ms':fmtDur(ms)}
/* Colour the MCP·Skill cell by whether configured tooling actually got used. */
function toolState(u){const hm=(u.servers?.configured||[]).length>0,hs=(u.skills?.configured||[]).length>0;
  if((hm&&!u.mcpCalls)||(hs&&!u.skillCalls))return'idle';
  if((u.servers?.unused||[]).length||(u.skills?.unused||[]).length)return'unused';return'ok'}
function toolNames(tools,kind){const of=(tools||[]).filter(t=>t.kind===kind);
  if(!of.length)return'none';return of.map(t=>esc(t.name)+(t.calls>1?' ×'+t.calls:'')).join(', ')}
function toolsBlock(r){const u=r.tools;
  if(!u)return'<div class="full-col"><h4>Tool usage</h4><div class="detail-note">Not recorded for this run.</div></div>';
  const us=u.servers?.unused||[],uk=u.skills?.unused||[];
  const noMcp=(u.servers?.configured||[]).length>0&&!u.mcpCalls;
  const noSkills=(u.skills?.configured||[]).length>0&&!u.skillCalls;
  const rows=(u.tools||[]).map(t=>'<tr class="'+esc(t.kind)+'"><td>'+esc(t.kind)+'</td><td>'+esc(t.server||'—')+'</td><td>'+esc(t.name)+'</td>'+
    '<td class="num-r">'+t.calls+'</td><td class="num-r">'+(t.errors||'—')+'</td><td class="num-r">'+esc(fmtToolMs(t.durationMs))+'</td></tr>').join('');
  return'<div class="full-col"><h4>Tool usage</h4>'+
    '<div class="tool-summary">'+u.calls+' tool call'+(u.calls===1?'':'s')+' &middot; <strong>'+u.mcpCalls+'</strong> MCP &middot; <strong>'+u.skillCalls+'</strong> skill'+(u.errors?' &middot; '+u.errors+' errored':'')+'</div>'+
    '<dl class="tool-lists"><dt>MCP tools</dt><dd>'+toolNames(u.tools,'mcp')+'</dd>'+
    '<dt>Skills</dt><dd>'+toolNames(u.tools,'skill')+'</dd>'+
    '<dt>MCP servers</dt><dd>'+esc((u.servers?.configured||[]).join(', ')||'none configured')+'</dd></dl>'+
    (noMcp?'<div class="tool-warn">The agent never called any MCP tool, though '+esc(us.join(', '))+' '+(us.length===1?'was':'were')+' configured.</div>':
      us.length?'<div class="tool-warn">MCP server'+(us.length===1?'':'s')+' never called: '+esc(us.join(', '))+'</div>':'')+
    (noSkills?'<div class="tool-warn">The agent never invoked a skill, though '+(u.skills?.configured||[]).length+' were installed.</div>':
      uk.length?'<div class="tool-warn">'+uk.length+' of '+(u.skills?.configured||[]).length+' skills never invoked: '+esc(uk.join(', '))+'</div>':'')+
    (rows?'<details class="log-details"><summary>All '+(u.tools||[]).length+' tools</summary><table class="tool-table">'+
      '<thead><tr><th>Kind</th><th>Server</th><th>Tool</th><th class="num-r">Calls</th><th class="num-r">Errors</th><th class="num-r">Time</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></details>':'')+
    (u.warning?'<div class="detail-note">'+esc(u.warning)+'</div>':'')+
    '</div>'}
function matrixColor(mid){if(!mid)return null;let h=0;for(let i=0;i<mid.length;i++)h=(h*31+mid.charCodeAt(i))>>>0;return'hsl('+(h%360)+',55%,62%)'}

// ---- Lightbox ----
let lbShots=[], lbIdx=0;
function openLb(shots,idx){lbShots=shots;lbIdx=idx;refreshLb();document.getElementById('lb').classList.add('open');document.body.style.overflow='hidden'}
function closeLb(){document.getElementById('lb').classList.remove('open');document.body.style.overflow=''}
function refreshLb(){const s=lbShots[lbIdx];if(!s)return;const img=document.getElementById('lb-img');img.src=s.dataUrl||'';img.alt=s.route;document.getElementById('lb-cap').textContent=s.route;document.getElementById('lb-counter').textContent=(lbIdx+1)+' / '+lbShots.length;document.getElementById('lb-prev').disabled=lbIdx===0;document.getElementById('lb-next').disabled=lbIdx===lbShots.length-1}
document.getElementById('lb-bd').onclick=closeLb;
document.getElementById('lb-close').onclick=closeLb;
document.getElementById('lb-prev').onclick=function(){if(lbIdx>0){lbIdx--;refreshLb()}};
document.getElementById('lb-next').onclick=function(){if(lbIdx<lbShots.length-1){lbIdx++;refreshLb()}};
document.addEventListener('keydown',function(e){if(!document.getElementById('lb').classList.contains('open'))return;if(e.key==='Escape')closeLb();else if(e.key==='ArrowLeft'&&lbIdx>0){lbIdx--;refreshLb()}else if(e.key==='ArrowRight'&&lbIdx<lbShots.length-1){lbIdx++;refreshLb()}});

// ---- Table ----
let sortField='startedAt', sortDir=-1, filterText='';

const COLS=[
  {field:'startedAt',     label:'When',     val:r=>r.startedAt||'',           cell:r=>'<span style="font-weight:600">'+esc(fmtWhen(r.startedAt))+'</span>'},
  {field:'_fw',           label:'Framework',val:r=>r.config.framework||'',    cell:r=>esc(r.config.framework||'\u2014')},
  {field:'_model',        label:'Model',    val:r=>(r.config.models||[])[0]||'',cell:r=>esc((r.config.models||[]).join(', ')||'\u2014')},
  {field:'_mcps',         label:'MCPs',     val:r=>(r.config.enabledMcps||[]).join(','),cell:r=>esc((r.config.enabledMcps||[]).join(', ')||'\u2014')},
  {field:'status',        label:'Status',   val:r=>r.status||'',              cell:r=>'<span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span>'},
  {field:'durationMs',    label:'Duration', val:r=>r.durationMs??-1,          cell:r=>'<span class="num-r">'+esc(fmtDur(r.durationMs))+'</span>'},
  {field:'rating',        label:'Rating',   val:r=>r.rating??-1,              cell:r=>'<span class="stars">'+esc(stars(r.rating))+'</span>'},
  {field:'_tools',        label:'MCP·Skill',val:r=>r.tools?r.tools.mcpCalls+r.tools.skillCalls/1000:-1,cell:r=>r.tools?'<span class="num-r '+toolState(r.tools)+'">'+r.tools.mcpCalls+' · '+r.tools.skillCalls+'</span>':'<span class="num-r none">—</span>'},
  {field:'_tok',          label:'Tokens',   val:r=>r.stats?.tokens?.total??-1,cell:r=>'<span class="num-r">'+esc(fmt(r.stats?.tokens?.total))+'</span>'},
  {field:'_cost',         label:'Cost (USD)',val:r=>r.stats?.cost?.available?r.stats.cost.amount:-1, cell:r=>'<span class="num-r">'+(r.stats?.cost?.available?'$'+r.stats.cost.amount.toFixed(4):'n/a')+'</span>'},
];

function getFilter(r){return[r.config?.framework,r.config?.models?.join(' '),r.status,r.matrixId,r.id,r.prompt,(r.config?.enabledMcps||[]).join(' '),(r.tools?.tools||[]).map(t=>t.name).join(' ')].join(' ').toLowerCase()}

function renderDetail(r){
  const c=r.config,st=r.stats,stg=r.stages||{};
  const timings=Object.entries(stg.timings||{});
  const completed=(stg.completed||[]).join(' \u2192')||'\u2014';
  const perModel=st?.perModel?Object.entries(st.perModel):[];
  const okShots=(r.screenshotData||[]).filter(s=>s.ok&&s.dataUrl);
  const mid=r.matrixId;
  const mc=matrixColor(mid);

  const shotsHtml=r.screenshotData?.length?
    '<div class="shots-wrap"><h4>Screenshots ('+okShots.length+'/'+(r.screenshotData||[]).length+')</h4><div class="shot-strip" data-run-id="'+esc(r.id)+'">'+
    okShots.map((s,i)=>'<button class="shot-btn" data-shot-idx="'+i+'" data-run-id="'+esc(r.id)+'" title="'+esc(s.route)+'"><img src="'+esc(s.dataUrl)+'" alt="'+esc(s.route)+'" loading="lazy" width="150" height="100"><span class="cap">'+esc(s.route)+'</span></button>').join('')+
    (r.screenshotData||[]).filter(s=>!s.ok).map(s=>'<div class="shot-fail">'+esc(s.route)+'<br><small>failed</small></div>').join('')+
    '</div></div>':'';

  const logsHtml=r.logs?.length?'<div class="full-col"><details class="log-details"><summary>Log ('+r.logs.length+' lines)</summary><pre class="log-pre">'+esc(r.logs.join('\\n'))+'</pre></details></div>':'';
  const promptHtml=r.prompt?'<div class="full-col"><h4>Prompt</h4><div class="detail-note">'+esc(r.prompt)+'</div></div>':'';
  const errHtml=r.error?'<div class="full-col detail-err"><strong>Error:</strong> '+esc(r.error)+'</div>':'';
  const matrixHtml=mid?'<div class="full-col" style="font-family:var(--mono);font-size:.74rem;color:var(--steel)">Matrix: <span class="mxtag" style="color:'+esc(mc||'')+'">'+esc(mid)+'</span></div>':'';

  return '<div class="detail">'+
    '<div><h4>Config</h4><dl>'+
    '<dt>Mode</dt><dd>'+esc(r.mode||'interactive')+'</dd>'+
    '<dt>Framework</dt><dd>'+esc(c.framework||'\u2014')+'</dd>'+
    '<dt>Project type</dt><dd>'+esc(c.projectType||'\u2014')+'</dd>'+
    '<dt>Theme</dt><dd>'+esc(c.theme||'\u2014')+'</dd>'+
    '<dt>Skills</dt><dd>'+esc(skillSummary(c))+'</dd>'+
    (c.excludedSkills?.length?'<dt>Excl. skills</dt><dd>'+esc(c.excludedSkills.join(', '))+'</dd>':'')+
    '<dt>MCPs</dt><dd>'+esc((c.enabledMcps||[]).join(', ')||'\u2014')+'</dd>'+
    '<dt>Run id</dt><dd style="font-size:.68rem">'+esc(r.id)+'</dd>'+
    '</dl></div>'+
    '<div><h4>Stages</h4><dl>'+
    '<dt>Completed</dt><dd>'+esc(completed)+'</dd>'+
    timings.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(fmtDur(v))+'</dd>').join('')+
    '</dl></div>'+
    '<div><h4>Per model</h4><dl>'+
    (perModel.length?perModel.map(([m,pm])=>'<dt style="overflow-wrap:anywhere">'+esc(m)+'</dt><dd>'+esc(fmt(pm.tokens?.total))+' tok'+(pm.cost?' &middot; $'+pm.cost.toFixed(4):'')+'</dd>').join(''):'<dt>\u2014</dt><dd></dd>')+
    '</dl></div>'+
    toolsBlock(r)+promptHtml+shotsHtml+logsHtml+errHtml+matrixHtml+
    '</div>';
}

// Map from runId → okShots array (built lazily on first expand).
const shotsByRun={};

function render(){
  const ft=filterText.toLowerCase();
  let rows=RUNS.filter(r=>!ft||getFilter(r).includes(ft));
  rows.sort((a,b)=>{
    const av=COLS.find(c=>c.field===sortField)?.val(a)??'';
    const bv=COLS.find(c=>c.field===sortField)?.val(b)??'';
    return(av<bv?-1:av>bv?1:0)*sortDir;
  });
  document.getElementById('run-count').textContent=rows.length+' run'+(rows.length===1?'':'s');

  const hdr='<tr>'+COLS.map(col=>'<th data-field="'+col.field+'"'+(sortField===col.field?' class="'+(sortDir===-1?'sort-desc':'sort-asc')+'"':'')+'>'+col.label+'</th>').join('')+'</tr>';

  const body=rows.flatMap(r=>[
    '<tr class="run-row" data-id="'+esc(r.id)+'">'+
      '<td><span class="chevron">\u203a</span>'+COLS[0].cell(r)+'</td>'+
      COLS.slice(1).map(col=>'<td>'+col.cell(r)+'</td>').join('')+
    '</tr>',
    '<tr class="detail-row" id="detail-'+esc(r.id)+'"><td colspan="'+COLS.length+'"></td></tr>',
  ]).join('');

  const tbl=document.getElementById('runs-table');
  tbl.innerHTML='<thead>'+hdr+'</thead><tbody>'+body+'</tbody>';

  // Row expand/collapse
  tbl.querySelectorAll('tr.run-row').forEach(function(row){
    row.addEventListener('click',function(){
      const id=row.dataset.id;
      const detailTr=document.getElementById('detail-'+id);
      if(!detailTr)return;
      const opening=!detailTr.classList.contains('open');
      detailTr.classList.toggle('open',opening);
      row.classList.toggle('expanded',opening);
      if(opening&&!detailTr.querySelector('.detail')){
        const run=RUNS.find(function(r){return r.id===id});
        if(run){
          detailTr.querySelector('td').innerHTML=renderDetail(run);
          shotsByRun[id]=(run.screenshotData||[]).filter(function(s){return s.ok&&s.dataUrl});
        }
      }
    });
  });

  // Screenshot lightbox delegation
  tbl.addEventListener('click',function(e){
    const btn=e.target.closest('.shot-btn');
    if(!btn)return;
    const runId=btn.dataset.runId;
    const idx=parseInt(btn.dataset.shotIdx,10);
    const shots=shotsByRun[runId]||[];
    openLb(shots,idx);
  });

  // Column sort
  tbl.querySelectorAll('thead th').forEach(function(th){
    th.addEventListener('click',function(){
      const f=th.dataset.field;
      if(sortField===f)sortDir*=-1;else{sortField=f;sortDir=-1}
      render();
    });
  });
}

document.getElementById('filter-input').addEventListener('input',function(e){filterText=e.target.value;render()});
render();
</script>
</body>
</html>`;
}
