// History view: sortable, expandable run table with screenshots + delete actions.
import { $, esc, fmt, fmtWhen, fmtDur } from './util.ts';
import { getJSON, del } from './api.ts';

let runsData: any[] = [];
let sortKey = 'when', sortDir = -1; // newest first
let matrixFilter: string | null = null; // when set, show only entries of this matrixId
let histTimer: number | null = null;
const expandedRuns = new Set<string>(); // run ids kept open across auto-refresh

// Flatten a record into the comparable values shown in the table.
function rowVals(r: any): any {
  const st = r.stats || {};
  const cost = st.cost && st.cost.available ? st.cost.amount : null;
  const xs = (r.config.excludedSkills || []).length;
  return {
    when: r.startedAt || '',
    mode: r.mode || 'interactive',
    matrix: r.matrixId || '',
    framework: r.config.framework || '—',
    model: (r.config.models || []).join(', ') || '—',
    skills: r.config.skills ? (xs ? `on (−${xs})` : 'on') : 'off',
    mcps: (r.config.enabledMcps || []).join(', ') || '—',
    status: r.status || '—',
    msgs: (st.messages || {}).total || 0,
    tok: (st.tokens || {}).total || 0,
    cost,
  };
}

// Short, color-stable tag for a matrix submission. The id is mx-<stamp>-<rand>;
// the trailing rand keeps the label short, and a hash→hue gives every entry of the
// same matrix the same color so they read as a group.
function matrixTag(matrixId: any): string {
  if (!matrixId) return '<span class="mxtag muted">—</span>';
  let h = 0;
  for (let i = 0; i < matrixId.length; i++) h = (h * 31 + matrixId.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const label = matrixId.split('-').pop();
  return `<span class="mxtag" style="color:hsl(${hue},55%,62%)" data-matrix="${esc(matrixId)}" title="${esc(matrixId)} — click to filter">#${esc(label)}</span>`;
}

function detailHtml(r: any): string {
  const c = r.config, st = r.stats, stg = r.stages || {};
  const timings = Object.entries(stg.timings || {})
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtDur(v as number)}</dd>`).join('') || '<dt>—</dt><dd></dd>';
  const completed = (stg.completed || []).join(' → ') || '—';
  const perModel = st && st.perModel
    ? Object.entries(st.perModel).map(([m, pm]: [string, any]) =>
        `<dt>${esc(m)}</dt><dd>${fmt(pm.tokens.total)} tok${pm.cost ? ` · $${pm.cost.toFixed(4)}` : ''}</dd>`).join('')
    : '<dt>—</dt><dd></dd>';

  const shots = r.screenshots || [];
  const art = (file: string) => `/history/artifacts/${encodeURIComponent(r.id)}/${encodeURIComponent(file)}`;
  const shotHtml = shots.length ? `<div class="shots"><h4>Screenshots (${shots.filter((s: any) => s.ok).length}/${shots.length})</h4>
    <div class="shot-strip">${shots.map((s: any) => s.ok
      ? `<a class="shot" href="${art(s.file)}" target="_blank" rel="noopener"><img loading="lazy" src="${art(s.file)}" alt="${esc(s.route)}"><span class="cap">${esc(s.route)}</span></a>`
      : `<div class="shot fail">${esc(s.route)}<br><small>failed</small></div>`).join('')}</div></div>` : '';
  const promptHtml = r.prompt
    ? `<div class="shots"><h4>Prompt</h4><div class="note" style="margin:0;color:#bfe6df">${esc(r.prompt)}</div></div>` : '';
  const logsHtml = (r.logs && r.logs.length)
    ? `<div class="shots"><h4>Log</h4><details><summary style="cursor:pointer;color:var(--steel)">${r.logs.length} lines</summary>
      <pre class="usage" style="max-height:320px;overflow:auto;white-space:pre-wrap">${esc(r.logs.join('\n'))}</pre></details></div>` : '';

  return `<div class="detail">
    <div><h4>Config</h4><dl>
      <dt>Mode</dt><dd>${esc(r.mode || 'interactive')}</dd>
      <dt>Project type</dt><dd>${esc(c.projectType || '—')}</dd>
      <dt>Theme</dt><dd>${esc(c.theme || '—')}</dd>
      <dt>Base URL</dt><dd>${esc(c.customBaseUrl || '—')}</dd>
      <dt>Excluded skills</dt><dd>${esc((c.excludedSkills || []).join(', ') || '—')}</dd>
      <dt>Run id</dt><dd>${esc(r.id)}</dd>
      ${r.matrixId ? `<dt>Matrix</dt><dd>${esc(r.matrixId)}</dd>` : ''}
    </dl></div>
    <div><h4>Stages</h4><dl>
      <dt>Completed</dt><dd>${esc(completed)}</dd>
      ${timings}
    </dl></div>
    <div><h4>Per model</h4><dl>${perModel}</dl></div>
    ${promptHtml}
    ${shotHtml}
    ${logsHtml}
    ${r.error ? `<div class="err"><strong>Error:</strong> ${esc(r.error)}</div>` : ''}
    ${r.matrixId ? `<div class="delgroup"><button data-delmatrix="${esc(r.matrixId)}">Delete entire matrix #${esc(r.matrixId.split('-').pop())}</button></div>` : ''}
  </div>`;
}

function renderRuns() {
  const body = $('#runsBody');
  const empty = $('#histEmpty'), table = $('#runsTable');
  const data = matrixFilter ? runsData.filter((r) => r.matrixId === matrixFilter) : runsData;
  updateHistMeta(data.length);
  if (!data.length) { empty.hidden = false; table.hidden = true; return; }
  empty.hidden = true; table.hidden = false;

  const rows = data.map((r) => ({ r, v: rowVals(r) }));
  rows.sort((a, b) => {
    const x = a.v[sortKey], y = b.v[sortKey];
    const cmp = (typeof x === 'number' && typeof y === 'number')
      ? x - y : String(x).localeCompare(String(y));
    return cmp * sortDir;
  });

  body.innerHTML = rows.map(({ r, v }) => {
    const cost = v.cost == null ? 'n/a' : `$${v.cost.toFixed(4)}`;
    const open = expandedRuns.has(r.id);
    return `<tr class="run-row" data-id="${esc(r.id)}" aria-expanded="${open}">
      <td><span class="rcaret">▸</span>${esc(fmtWhen(v.when))}</td>
      <td>${matrixTag(v.matrix)}</td>
      <td>${esc(v.framework)}</td>
      <td>${esc(v.model)}</td>
      <td>${esc(v.skills)}</td>
      <td>${esc(v.mcps)}</td>
      <td><span class="pill ${esc(v.status)}">${esc(v.status)}</span></td>
      <td class="num">${fmt(v.msgs)}</td>
      <td class="num">${fmt(v.tok)}</td>
      <td class="num">${cost}</td>
      <td class="num">${fmtDur(r.durationMs)}</td>
      <td><button class="del" data-del="${esc(r.id)}" title="Delete run">✕</button></td>
    </tr>
    <tr class="detail-row"${open ? '' : ' hidden'}><td colspan="12">${detailHtml(r)}</td></tr>`;
  }).join('');

  document.querySelectorAll<any>('#runsTable th[data-sort]').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === sortKey && sortDir === 1);
    th.classList.toggle('sort-desc', th.dataset.sort === sortKey && sortDir === -1);
  });
}

function updateHistMeta(shown: number) {
  const meta = $('#histMeta');
  if (matrixFilter) {
    meta.innerHTML = `${shown} run${shown === 1 ? '' : 's'} in matrix #${esc(matrixFilter.split('-').pop())} · <a href="#" id="histClear" style="color:var(--teal)">show all</a>`;
    const c = $('#histClear');
    if (c) c.onclick = (ev: any) => { ev.preventDefault(); matrixFilter = null; renderRuns(); };
  } else {
    meta.textContent = `${runsData.length} run${runsData.length === 1 ? '' : 's'}`;
  }
}

export async function loadHistory() {
  try {
    const j = await getJSON('/api/history');
    runsData = (j && j.runs) || [];
    if (matrixFilter && !runsData.some((r) => r.matrixId === matrixFilter)) matrixFilter = null;
    renderRuns();
  } catch (_) {}
}

export function startHistoryPolling() {
  if (!histTimer) histTimer = setInterval(loadHistory, 5000);
}
export function stopHistoryPolling() {
  if (histTimer) { clearInterval(histTimer); histTimer = null; }
}

async function deleteRun(id: string) {
  if (!confirm('Delete this run and its screenshots?')) return;
  try {
    const j = await del(`/api/history/${encodeURIComponent(id)}`);
    if (!j.ok) { alert(j.error || 'delete failed'); return; }
    expandedRuns.delete(id);
    loadHistory();
  } catch (err: any) { alert(err.message); }
}

async function deleteMatrix(matrixId: string) {
  if (!confirm(`Delete every run in matrix #${matrixId.split('-').pop()} and its screenshots?`)) return;
  try {
    const j = await del(`/api/history/matrix/${encodeURIComponent(matrixId)}`);
    if (!j.ok) { alert(j.error || 'delete failed'); return; }
    if (matrixFilter === matrixId) matrixFilter = null;
    loadHistory();
  } catch (err: any) { alert(err.message); }
}

$('#runsBody').addEventListener('click', (e: any) => {
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) { e.stopPropagation(); deleteRun(delBtn.dataset.del); return; }
  const delMx = e.target.closest('[data-delmatrix]');
  if (delMx) { e.stopPropagation(); deleteMatrix(delMx.dataset.delmatrix); return; }
  const tag = e.target.closest('[data-matrix]');
  if (tag) { e.stopPropagation(); matrixFilter = (matrixFilter === tag.dataset.matrix) ? null : tag.dataset.matrix; renderRuns(); return; }

  const row = e.target.closest('tr.run-row');
  if (!row) return;
  const detail = row.nextElementSibling;
  const open = detail.hidden;
  detail.hidden = !open;
  row.setAttribute('aria-expanded', String(open));
  if (open) expandedRuns.add(row.dataset.id); else expandedRuns.delete(row.dataset.id);
});

document.querySelectorAll<any>('#runsTable th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    renderRuns();
  });
});

$('#histRefresh').addEventListener('click', loadHistory);
