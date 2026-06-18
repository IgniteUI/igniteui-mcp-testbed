// History view: sortable Ignite UI grid with master-detail run inspection.
import { $, fmt, fmtWhen, fmtDur } from './util.ts';
import { getJSON, postJSON, del } from './api.ts';

interface HistoryGridRow {
  id: string;
  whenDate: Date;
  whenDisplay: string;
  matrixId: string;
  framework: string;
  model: string;
  skills: string;
  mcps: string;
  status: string;
  rating: number;
  msgs: number;
  tok: number;
  costSort: number | null;
  costDisplay: string;
  durationMs: number | null;
  durationDisplay: string;
  actions: string;
}

let runsData: any[] = [];
let matrixFilter: string | null = null; // when set, show only entries of this matrixId
let historyTimer: number | null = null;
const expandedRuns = new Set<string>(); // run ids kept open across auto-refresh
const runById = new Map<string, any>();
let templatesBound = false;
let defaultSortApplied = false;

const grid = () => $('#runsGrid') as any;
const html = (...args: any[]) => {
  const tag = (window as any).igniteuiHtml;
  if (!tag) throw new Error('Ignite UI template helper is not loaded');
  return tag(...args);
};

// Flatten a record into the comparable values shown in the grid.
function rowVals(r: any): HistoryGridRow {
  const st = r.stats || {};
  const cost = st.cost && st.cost.available ? st.cost.amount : null;
  const xs = (r.config.excludedSkills || []).length;
  return {
    id: r.id,
    whenDate: new Date(r.startedAt || 0),
    whenDisplay: fmtWhen(r.startedAt || ''),
    matrixId: r.matrixId || '',
    framework: r.config.framework || '—',
    model: (r.config.models || []).join(', ') || '—',
    skills: r.config.skills ? (xs ? `on (-${xs})` : 'on') : 'off',
    mcps: (r.config.enabledMcps || []).join(', ') || '—',
    status: r.status || '—',
    rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : 0,
    msgs: (st.messages || {}).total || 0,
    tok: (st.tokens || {}).total || 0,
    costSort: cost,
    costDisplay: cost == null ? 'n/a' : `$${cost.toFixed(4)}`,
    durationMs: r.durationMs,
    durationDisplay: fmtDur(r.durationMs),
    actions: '',
  };
}

function matrixTagInfo(matrixId: string): { label: string; color: string } | null {
  if (!matrixId) return null;
  let h = 0;
  for (let i = 0; i < matrixId.length; i++) h = (h * 31 + matrixId.charCodeAt(i)) >>> 0;
  return { label: matrixId.split('-').pop() || matrixId, color: `hsl(${h % 360},55%,62%)` };
}

function updateHistMeta(shown: number) {
  const meta = $('#historyMeta');
  if (matrixFilter) {
    const label = matrixFilter.split('-').pop();
    meta.textContent = '';
    meta.append(
      document.createTextNode(`${shown} run${shown === 1 ? '' : 's'} in matrix #${label} · `),
    );
    const clear = document.createElement('a');
    clear.href = '#';
    clear.id = 'historyClear';
    clear.style.color = 'var(--teal)';
    clear.textContent = 'show all';
    clear.onclick = (ev: any) => { ev.preventDefault(); matrixFilter = null; renderRuns(); };
    meta.append(clear);
  } else {
    meta.textContent = `${runsData.length} run${runsData.length === 1 ? '' : 's'}`;
  }
}

function setHistoryMessage(message: string, visible: boolean) {
  const empty = $('#historyEmpty');
  empty.textContent = message;
  empty.hidden = !visible;
}

function getCellRow(ctx: any): HistoryGridRow {
  return ctx?.cell?.row?.data || {};
}

function isRateable(status: string): boolean {
  return !['running', 'pending'].includes(status);
}

function bindGridTemplates() {
  if (templatesBound) return;
  templatesBound = true;

  const g = grid();
  const exporter = $('#historyExcelExporter');
  exporter.exportCSV = false;
  exporter.exportPDF = false;
  exporter.exportExcel = true;
  exporter.filename = 'ignite-ui-run-history';

  g.detailTemplate = (ctx: any) => {
    const row = ctx.implicit as HistoryGridRow;
    const r = runById.get(row.id);
    if (!r) return html``;

    const c = r.config, st = r.stats, stg = r.stages || {};
    const timings = Object.entries(stg.timings || {});
    const completed = (stg.completed || []).join(' → ') || '—';
    const perModel = st && st.perModel ? Object.entries(st.perModel) : [];
    const shots = r.screenshots || [];
    const art = (file: string) => `/history/artifacts/${encodeURIComponent(r.id)}/${encodeURIComponent(file)}`;

    return html`
      <div class="detail">
        <div><h4>Config</h4><dl>
          <dt>Mode</dt><dd>${r.mode || 'interactive'}</dd>
          <dt>Project type</dt><dd>${c.projectType || '—'}</dd>
          <dt>Theme</dt><dd>${c.theme || '—'}</dd>
          <dt>Base URL</dt><dd>${c.customBaseUrl || '—'}</dd>
          <dt>Excluded skills</dt><dd>${(c.excludedSkills || []).join(', ') || '—'}</dd>
          <dt>Run id</dt><dd>${r.id}</dd>
          ${r.matrixId ? html`<dt>Matrix</dt><dd>${r.matrixId}</dd>` : html``}
        </dl></div>
        <div><h4>Stages</h4><dl>
          <dt>Completed</dt><dd>${completed}</dd>
          ${timings.length
            ? timings.map(([k, v]) => html`<dt>${k}</dt><dd>${fmtDur(v as number)}</dd>`)
            : html`<dt>—</dt><dd></dd>`}
        </dl></div>
        <div><h4>Per model</h4><dl>
          ${perModel.length
            ? perModel.map(([m, pm]: [string, any]) =>
                html`<dt>${m}</dt><dd>${fmt(pm.tokens.total)} tok${pm.cost ? ` · $${pm.cost.toFixed(4)}` : ''}</dd>`)
            : html`<dt>—</dt><dd></dd>`}
        </dl></div>
        ${r.prompt
          ? html`<div class="shots"><h4>Prompt</h4><div class="note detail-note">${r.prompt}</div></div>`
          : html``}
        ${shots.length ? html`
          <div class="shots"><h4>Screenshots (${shots.filter((s: any) => s.ok).length}/${shots.length})</h4>
            <div class="shot-strip">${shots.map((s: any) => s.ok
              ? html`<a class="shot" href="${art(s.file)}" target="_blank" rel="noopener">
                  <img loading="lazy" src="${art(s.file)}" alt="${s.route}">
                  <span class="cap">${s.route}</span>
                </a>`
              : html`<div class="shot fail">${s.route}<br><small>failed</small></div>`)}
            </div>
          </div>` : html``}
        ${r.logs && r.logs.length ? html`
          <div class="shots"><h4>Log</h4><details>
            <summary class="log-summary">${r.logs.length} lines</summary>
            <pre class="usage detail-log">${r.logs.join('\n')}</pre>
          </details></div>` : html``}
        ${r.error ? html`<div class="err"><strong>Error:</strong> ${r.error}</div>` : html``}
        ${r.matrixId ? html`
          <div class="delgroup">
            <igc-button class="danger-button" variant="contained"
              @click=${(ev: Event) => { ev.stopPropagation(); deleteMatrix(r.matrixId); }}>
              Delete entire matrix #${r.matrixId.split('-').pop()}
            </igc-button>
          </div>` : html``}
      </div>`;
  };

  $('#historyWhen').bodyTemplate = (ctx: any) => html`<span class="history-when">${getCellRow(ctx).whenDisplay}</span>`;
  $('#historyMatrix').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    const tag = matrixTagInfo(row.matrixId);
    if (!tag) return html`<span class="mxtag muted">—</span>`;
    return html`
      <span class="mxtag" style="color:${tag.color}" title="${row.matrixId} — click to filter"
        @click=${(ev: Event) => {
          ev.stopPropagation();
          matrixFilter = matrixFilter === row.matrixId ? null : row.matrixId;
          renderRuns();
        }}>#${tag.label}</span>`;
  };
  $('#historyStatus').bodyTemplate = (ctx: any) => html`<span class="pill ${getCellRow(ctx).status}">${getCellRow(ctx).status}</span>`;
  $('#historyRating').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    const readonly = !isRateable(row.status);
    return html`<igc-rating class="history-rating ${readonly ? 'is-readonly' : ''}" max="5" step="1"
      .value=${row.rating}
      .readOnly=${readonly}
      @click=${(ev: Event) => ev.stopPropagation()}
      @igcChange=${(ev: CustomEvent<number>) => {
        ev.stopPropagation();
        saveRating(row.id, Number(ev.detail || 0));
      }}></igc-rating>`;
  };
  $('#historyMsgs').bodyTemplate = (ctx: any) => html`<span class="num-cell">${fmt(getCellRow(ctx).msgs)}</span>`;
  $('#historyTokens').bodyTemplate = (ctx: any) => html`<span class="num-cell">${fmt(getCellRow(ctx).tok)}</span>`;
  $('#historyCost').bodyTemplate = (ctx: any) => html`<span class="num-cell">${getCellRow(ctx).costDisplay}</span>`;
  $('#historyDuration').bodyTemplate = (ctx: any) => html`<span class="num-cell">${getCellRow(ctx).durationDisplay}</span>`;
  $('#historyActions').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    return html`<span class="history-actions-cell">
      <button class="del" title="Delete run"
        @click=${(ev: Event) => { ev.stopPropagation(); deleteRun(row.id); }}>X</button>
    </span>`;
  };

  g.addEventListener('expansionStatesChange', (e: any) => syncExpandedRuns(e.detail));
}

function syncExpandedRuns(states?: any) {
  const stateMap = states || grid().expansionStates;
  if (!(stateMap instanceof Map)) return;
  expandedRuns.clear();
  for (const [id, expanded] of stateMap.entries()) {
    if (expanded) expandedRuns.add(String(id));
  }
}

function restoreExpandedRows() {
  const g = grid();
  for (const id of expandedRuns) {
    if (runById.has(id)) {
      try { g.expandRow(id); } catch (_) {}
    }
  }
}

function applyDefaultSort() {
  if (defaultSortApplied) return;
  defaultSortApplied = true;
  // SortingDirection.Desc is 2 in Ignite UI grid. Keep this as a plain value so
  // the app bundle does not need an additional runtime import.
  try { grid().sortingExpressions = [{ fieldName: 'whenDate', dir: 2, ignoreCase: true }]; } catch (_) {}
}

function renderRuns() {
  bindGridTemplates();
  const g = grid();
  const data = matrixFilter ? runsData.filter((r) => r.matrixId === matrixFilter) : runsData;
  updateHistMeta(data.length);
  runById.clear();
  for (const r of data) runById.set(r.id, r);

  if (!data.length) {
    g.hidden = true;
    setHistoryMessage(matrixFilter ? 'No runs match this matrix filter.' : 'No runs recorded yet.', true);
    g.data = [];
    return;
  }

  setHistoryMessage('', false);
  g.hidden = false;
  g.data = data.map(rowVals);
  applyDefaultSort();
  setTimeout(restoreExpandedRows, 0);
}

export async function loadHistory() {
  const hadData = runsData.length > 0;
  if (!hadData) {
    grid().hidden = true;
    setHistoryMessage('Loading run history...', true);
  }
  try {
    const j = await getJSON('/api/history');
    if (!j || !j.ok) throw new Error(j && j.error ? j.error : 'failed to load history');
    runsData = j.runs || [];
    if (matrixFilter && !runsData.some((r) => r.matrixId === matrixFilter)) matrixFilter = null;
    renderRuns();
  } catch (err: any) {
    grid().hidden = true;
    setHistoryMessage(`Could not load run history: ${err.message}`, true);
  }
}

export function startHistoryPolling() {
  if (!historyTimer) historyTimer = setInterval(loadHistory, 5000);
}
export function stopHistoryPolling() {
  if (historyTimer) { clearInterval(historyTimer); historyTimer = null; }
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

async function saveRating(id: string, rating: number) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;
  const run = runsData.find((r) => r.id === id);
  const previous = run ? run.rating : null;
  if (run) run.rating = rating;
  const mapped = runById.get(id);
  if (mapped) mapped.rating = rating;

  try {
    const j = await postJSON(`/api/history/${encodeURIComponent(id)}/rating`, { rating });
    if (!j.ok) throw new Error(j.error || 'failed to save rating');
    if (j.run && run) run.rating = j.run.rating;
  } catch (err: any) {
    if (run) run.rating = previous;
    const current = runById.get(id);
    if (current) current.rating = previous;
    renderRuns();
    alert(err.message);
  }
}

$('#historyRefresh').addEventListener('click', loadHistory);
