// History view: sortable Ignite UI grid with master-detail run inspection.
import { $, fmt, fmtWhen, fmtDur } from './util.ts';
import { getJSON, postJSON, del } from './api.ts';

interface HistoryGridRow {
  id: string;
  whenTs: number;
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
const runById = new Map<string, any>();
let templatesBound = false;
let defaultSortApplied = false;
let gridDataBound = false;

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
    whenTs: Date.parse(r.startedAt) || 0,
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

function sameValue(a: any, b: any): boolean {
  return a === b;
}

function rowsEqual(a: HistoryGridRow, b: HistoryGridRow): boolean {
  return Object.keys(a).every((key) => sameValue((a as any)[key], (b as any)[key]));
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
      <div class="detail" data-run-id=${row.id}>
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
          <div class="shots">
            <details class="shot-details">
              <summary>Screenshots (${shots.filter((s: any) => s.ok).length}/${shots.length})</summary>
              <div class="shot-strip">${shots.map((s: any) => s.ok
                ? html`<a class="shot" href="${art(s.file)}" target="_blank" rel="noopener">
                    <img loading="lazy" decoding="async" fetchpriority="low" width="150" height="100"
                      src="${art(s.file)}" alt="${s.route}">
                    <span class="cap">${s.route}</span>
                  </a>`
                : html`<div class="shot fail">${s.route}<br><small>failed</small></div>`)}
              </div>
            </details>
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
  // The grid shows whenDisplay via the template above, but the Excel exporter ignores
  // body templates and exports the raw field value — which for the numeric whenTs column
  // would be a bare epoch number. The exporter does honour the column formatter, so map
  // the epoch back to the same human-readable timestamp for the exported cell.
  $('#historyWhen').formatter = (value: number) => (value ? fmtWhen(new Date(value).toISOString()) : '—');
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
  // Export the same human-readable duration as the cell shows, not the raw millisecond
  // field value (the exporter ignores the body template but honours the formatter).
  $('#historyDuration').formatter = (value: number | null) => fmtDur(value);
  $('#historyActions').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    const isMatrix = !!row.matrixId;
    const active = row.status === 'running' || row.status === 'pending';
    const playDisabled = !isMatrix || active;
    const stopDisabled = !isMatrix || !active;
    const playTitle = !isMatrix ? 'Re-run is only available for matrix runs'
      : active ? 'Run is still in progress' : 'Re-run this configuration';
    const stopTitle = !isMatrix ? 'Cancel is only available for matrix runs'
      : active ? 'Cancel this run' : 'Run is not in progress';
    return html`<span class="history-actions-cell">
      <button class="play material-icons" title=${playTitle} ?disabled=${playDisabled}
        @click=${(ev: Event) => { ev.stopPropagation(); rerunRun(row.id); }}>play_arrow</button>
      <button class="stop material-icons" title=${stopTitle} ?disabled=${stopDisabled}
        @click=${(ev: Event) => { ev.stopPropagation(); stopRun(row.id); }}>stop</button>
      <button class="del" title="Delete run"
        @click=${(ev: Event) => { ev.stopPropagation(); deleteRun(row.id); }}>X</button>
    </span>`;
  };

  // Expand/collapse a row when any of its cells is clicked (not just the chevron).
  // Interactive cells (rating, matrix tag, delete) call stopPropagation in their own
  // handlers, so the grid's cellClick never fires for them and they don't toggle.
  g.addEventListener('cellClick', (event: any) => {
    const id = getCellRow(event.detail).id;
    if (id != null) g.toggleRow(id);
  });

  g.addEventListener('rowToggle', (event: any) => {
    const detail = event.detail;
    if (!detail || detail.expanded) return;
    closeNestedDetailToggles(detail.rowKey ?? detail.rowID);
  });
  document.addEventListener('selectionchange', syncHistoryClipboardOptions);
  document.addEventListener('focusin', syncHistoryClipboardOptions);
  document.addEventListener('pointerdown', syncHistoryClipboardOptions, true);
  document.addEventListener('keydown', syncHistoryClipboardOptions, true);
}

function closeNestedDetailToggles(rowId: any) {
  const id = String(rowId);
  document.querySelectorAll<HTMLElement>('.detail[data-run-id]').forEach((detail) => {
    if (detail.dataset.runId !== id) return;
    detail.querySelectorAll<HTMLDetailsElement>('details[open]').forEach((toggle) => {
      toggle.open = false;
    });
  });
}

function syncHistoryClipboardOptions() {
  const g = grid();
  const options = g.clipboardOptions || {};
  const enabled = !isHistoryDetailActive();
  if (options.enabled === enabled) return;
  g.clipboardOptions = { ...options, enabled };
}

function isHistoryDetailActive(): boolean {
  if (selectionTouchesHistoryDetail()) return true;
  return !!nodeHistoryDetail(document.activeElement);
}

function selectionTouchesHistoryDetail(): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (
      nodeHistoryDetail(range.startContainer) ||
      nodeHistoryDetail(range.endContainer) ||
      nodeHistoryDetail(range.commonAncestorContainer)
    ) {
      return true;
    }
  }

  return false;
}

function nodeHistoryDetail(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return (el?.closest('.detail') as HTMLElement | null) || null;
}

function applyDefaultSort() {
  if (defaultSortApplied) return;
  defaultSortApplied = true;
  // SortingDirection.Desc is 2 in Ignite UI grid. Keep this as a plain value so
  // the app bundle does not need an additional runtime import. Sort on the numeric
  // whenTs (epoch ms) rather than a Date column: the grid's `date` type sorts by
  // calendar day only (same-day runs tie and fall back to data order) and Date
  // objects compare inconsistently, so a plain number is unambiguous.
  try { grid().sortingExpressions = [{ fieldName: 'whenTs', dir: 2 }]; } catch (_) {}
}

function reconcileGridRows(nextRows: HistoryGridRow[]) {
  const g = grid();
  if (!gridDataBound) {
    g.data = nextRows;
    gridDataBound = true;
    applyDefaultSort();
    return;
  }

  const currentRows = Array.isArray(g.data) ? g.data as HistoryGridRow[] : [];
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const nextIds = new Set(nextRows.map((row) => row.id));

  for (const row of currentRows) {
    if (!nextIds.has(row.id)) g.deleteRow(row.id);
  }

  for (const row of nextRows) {
    const current = currentById.get(row.id);
    if (!current) {
      g.addRow(row);
    } else if (!rowsEqual(current, row)) {
      g.updateRow(row, row.id);
    }
  }
}

function renderRuns() {
  bindGridTemplates();
  const g = grid();
  const data = matrixFilter ? runsData.filter((r) => r.matrixId === matrixFilter) : runsData;
  updateHistMeta(data.length);
  runById.clear();
  for (const r of data) runById.set(r.id, r);

  if (!data.length) {
    reconcileGridRows([]);
    g.hidden = true;
    setHistoryMessage(matrixFilter ? 'No runs match this matrix filter.' : 'No runs recorded yet.', true);
    return;
  }

  setHistoryMessage('', false);
  g.hidden = false;
  reconcileGridRows(data.map(rowVals));
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
    loadHistory();
  } catch (err: any) { alert(err.message); }
}

// Re-run a matrix configuration: copy the stored config + prompt into a fresh
// single-entry matrix submission, prompting for the (never-stored) API key first.
let pendingRerun: any = null;

function rerunRun(id: string) {
  const r = runById.get(id);
  if (!r || !r.matrixId) return;
  pendingRerun = r;
  const c = r.config || {};
  const prompt = (r.prompt || '').trim();
  const snippet = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
  $('#rerunSummary').textContent =
    `${c.framework || '—'} · ${(c.models || [])[0] || '—'}${snippet ? ` · "${snippet}"` : ''}`;
  ($('#rerunKey') as any).value = '';
  ($('#rerunDialog') as any).show();
}

async function confirmRerun() {
  const r = pendingRerun;
  if (!r) return;
  const c = r.config || {};
  const apiKey = ($('#rerunKey') as any).value;
  const body = {
    platforms: [c.framework],
    variants: [{ mcps: c.enabledMcps || [], skills: !!c.skills }],
    model: (c.models || [])[0],
    prompt: r.prompt,
    apiKey,
    customBaseUrl: c.customBaseUrl || undefined,
  };
  try {
    const j = await postJSON('/api/matrix', body);
    if (!j.ok) { alert(j.error || 'failed to start re-run'); return; }
    ($('#rerunDialog') as any).hide();
    pendingRerun = null;
    loadHistory();
  } catch (err: any) { alert(err.message); }
}

async function stopRun(id: string) {
  const r = runById.get(id);
  if (!r || !r.matrixId || (r.status !== 'running' && r.status !== 'pending')) return;
  if (!confirm('Cancel this run?')) return;
  try {
    const j = await postJSON(`/api/matrix/cancel/${encodeURIComponent(id)}`, {});
    if (!j.ok) { alert(j.error || 'cancel failed'); return; }
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
$('#rerunConfirm').addEventListener('click', confirmRerun);
$('#rerunCancel').addEventListener('click', () => { pendingRerun = null; ($('#rerunDialog') as any).hide(); });
