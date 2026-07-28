// History view: sortable Ignite UI grid with master-detail run inspection.
// The view chrome (head, meta, empty note, dialog, lightbox) renders with our bundled
// lit; the igc-grid's cell/detail templates are built with window.igniteuiHtml so the
// grid's own lit instance (inside vendor igniteui.js) renders them — see web/lit.ts.
import { html, render, keyed } from './lit.ts';
import { $, fmt, fmtWhen, fmtDur } from './util.ts';
import { getJSON, postJSON, del } from './api.ts';
import type { IgcCarouselComponent, IgcDialogComponent } from 'igniteui-webcomponents';

interface HistoryGridRow {
  id: string;
  whenTs: number;
  whenDisplay: string;
  matrixId: string;
  matrixName: string;
  framework: string;
  model: string;
  skills: string;
  mcps: string;
  status: string;
  rating: number;
  testsSort: number;
  testsDisplay: string;
  testsState: string;
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

// View-chrome state (everything the lit template renders from).
const st = {
  emptyMsg: 'No runs recorded yet.',
  emptyVisible: true,
  gridVisible: false,
  shownCount: 0,
  rerunSummary: '',
  lb: {
    gen: 0, // bumped per open — keyed() then builds a FRESH carousel (see openLightbox)
    shots: [] as Array<{ file: string; route: string }>,
    art: ((f: string) => '') as (f: string) => string,
    idx: 0,
  },
};

function openLightbox(okShots: Array<{ file: string; route: string }>, idx: number, art: (f: string) => string) {
  st.lb.shots = okShots;
  st.lb.art = art;
  st.lb.idx = Math.max(0, Math.min(idx, okShots.length - 1));
  // Re-using a carousel with replaced children leaves its internal slide cache stale,
  // which breaks prev/next navigation. Bumping the keyed() generation makes lit build
  // a fresh element each open, which always starts with clean state.
  st.lb.gen++;
  // The native <dialog> traps focus and restores it on close, but does not lock
  // background scroll — keep that one piece ourselves.
  document.body.style.overflow = 'hidden';
  update();
  ($('#shotLightbox') as IgcDialogComponent).show();
  // Navigate to the correct starting slide after the component has connected
  // to the DOM and processed its slotchange microtasks.
  Promise.resolve().then(() => {
    const carousel = document.getElementById('shotCarousel') as IgcCarouselComponent | null;
    if (!carousel) return;
    const slides = Array.from(carousel.querySelectorAll('igc-carousel-slide'));
    if (slides[st.lb.idx]) {
      carousel.select(slides[st.lb.idx]);
    }
  });
}

// Single close/cleanup path. Wired to both the × button and igcClosed because
// dialog.hide() (the button path) does NOT emit igcClosed — only user-initiated
// closes (Esc, outside click) do; on that path hide() is already a no-op.
function closeLightbox() {
  document.body.style.overflow = '';
  ($('#shotLightbox') as IgcDialogComponent | null)?.hide();
}

const grid = () => $('#runsGrid') as any;
// Grid templates MUST come from the vendor bundle's lit (the grid renders them).
const gridHtml = (...args: any[]) => {
  const tag = (window as any).igniteuiHtml;
  if (!tag) throw new Error('Ignite UI template helper is not loaded');
  return tag(...args);
};

// Format a framework id for display in the History grid. Only the four known
// IgniteUI-native ids get the " - Ignite UI" suffix so external 3rd-party UI
// frameworks are shown as-is.
const IGNITEUI_FRAMEWORK_IDS = new Set(['angular', 'react', 'webcomponents', 'blazor']);
function fmtFramework(fw: string | undefined): string {
  if (!fw) return '—';
  return IGNITEUI_FRAMEWORK_IDS.has(fw) ? `${fw} - Ignite UI` : fw;
}

// One-word summary of a run's skill mode for the grid (matches the matrix 4-way axis).
function skillSummary(c: any): string {
  const xs = (c.excludedSkills || []).length;
  const gen = c.skills ? (xs ? `default (-${xs})` : 'default') : null;
  if (c.overrideSkills) {
    if (c.localSkillsOnly || !c.skills) return 'local';
    return `${gen} + local`;
  }
  return gen || 'off';
}

// One-word summary of a run's injected-test verification outcome for the grid.
function testSummary(t: any): { display: string; sort: number; state: string } {
  if (!t) return { display: '—', sort: -1, state: 'none' };
  if (!t.ran) return { display: 'error', sort: -2, state: 'error' };
  // Sort key: failing runs first (negative), then by pass ratio.
  const sort = t.failed > 0 ? -100 - t.failed : (t.total ? t.passed / t.total : 1) * 100;
  return { display: `${t.passed}/${t.total}`, sort, state: t.ok ? 'pass' : 'fail' };
}

// Flatten a record into the comparable values shown in the grid.
function rowVals(r: any): HistoryGridRow {
  const stats = r.stats || {};
  const cost = stats.cost && stats.cost.available ? stats.cost.amount : null;
  const ts = testSummary(r.tests);
  return {
    id: r.id,
    whenTs: Date.parse(r.startedAt) || 0,
    whenDisplay: fmtWhen(r.startedAt || ''),
    matrixId: r.matrixId || '',
    matrixName: r.matrixName || '',
    framework: fmtFramework(r.config.framework),
    model: (r.config.models || []).join(', ') || '—',
    skills: skillSummary(r.config),
    mcps: (r.config.enabledMcps || []).join(', ') || '—',
    status: r.status || '—',
    rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : 0,
    testsSort: ts.sort,
    testsDisplay: ts.display,
    testsState: ts.state,
    msgs: (stats.messages || {}).total || 0,
    tok: (stats.tokens || {}).total || 0,
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

function setHistoryMessage(message: string, visible: boolean) {
  st.emptyMsg = message;
  st.emptyVisible = visible;
}

function getCellRow(ctx: any): HistoryGridRow {
  return ctx?.cell?.row?.data || {};
}

function isRateable(status: string): boolean {
  return !['running', 'pending'].includes(status);
}

function rowsEqual(a: HistoryGridRow, b: HistoryGridRow): boolean {
  return Object.keys(a).every((key) => (a as any)[key] === (b as any)[key]);
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
    if (!r) return gridHtml``;

    const c = r.config, stats = r.stats, stg = r.stages || {};
    const timings = Object.entries(stg.timings || {});
    const completed = (stg.completed || []).join(' → ') || '—';
    const perModel = stats && stats.perModel ? Object.entries(stats.perModel) : [];
    const shots = r.screenshots || [];
    const art = (file: string) => `/history/artifacts/${encodeURIComponent(r.id)}/${encodeURIComponent(file)}`;
    const okShots = shots.filter((s: any) => s.ok);

    return gridHtml`
      <div class="detail" data-run-id=${row.id}>
        <div><h4>Config</h4><dl>
          <dt>Mode</dt><dd>${r.mode || 'interactive'}</dd>
          <dt>Project type</dt><dd>${c.projectType || '—'}</dd>
          <dt>Theme</dt><dd>${c.theme || '—'}</dd>
          <dt>Base URL</dt><dd>${c.customBaseUrl || '—'}</dd>
          <dt>Skills</dt><dd>${skillSummary(c)}</dd>
          <dt>Excluded skills</dt><dd>${(c.excludedSkills || []).join(', ') || '—'}</dd>
          <dt>Tests selected</dt><dd>${(c.selectedTests || []).length ? `${c.selectedTests.length} file(s)` : 'none'}</dd>
          <dt>Run id</dt><dd>${r.id}</dd>
          ${r.matrixId ? gridHtml`<dt>Matrix</dt><dd>${r.matrixName ? `${r.matrixName} · ` : ''}${r.matrixId}</dd>` : gridHtml``}
        </dl></div>
        <div><h4>Stages</h4><dl>
          <dt>Completed</dt><dd>${completed}</dd>
          ${timings.length
            ? timings.map(([k, v]) => gridHtml`<dt>${k}</dt><dd>${fmtDur(v as number)}</dd>`)
            : gridHtml`<dt>—</dt><dd></dd>`}
        </dl></div>
        <div><h4>Per model</h4><dl>
          ${perModel.length
            ? perModel.map(([m, pm]: [string, any]) =>
                gridHtml`<dt>${m}</dt><dd>${fmt(pm.tokens.total)} tok${pm.cost ? ` · $${pm.cost.toFixed(4)}` : ''}</dd>`)
            : gridHtml`<dt>—</dt><dd></dd>`}
        </dl></div>
        ${r.prompt
          ? gridHtml`<div class="shots"><h4>Prompt</h4><div class="note detail-note">${r.prompt}</div></div>`
          : gridHtml``}
        ${shots.length ? gridHtml`
          <div class="shots">
            <details class="shot-details">
              <summary>Screenshots (${shots.filter((s: any) => s.ok).length}/${shots.length})</summary>
              <div class="shot-strip">${shots.map((s: any) => s.ok
                ? gridHtml`<button type="button" class="shot" title="View ${s.route}"
                    @click=${() => openLightbox(okShots, okShots.indexOf(s), art)}>
                    <img loading="lazy" decoding="async" fetchpriority="low" width="150" height="100"
                      src="${art(s.file)}" alt="${s.route}">
                    <span class="cap">${s.route}</span>
                  </button>`
                : gridHtml`<div class="shot fail">${s.route}<br><small>failed</small></div>`)}
              </div>
            </details>
          </div>` : gridHtml``}
        ${r.tests ? gridHtml`
          <div class="shots"><h4>Tests</h4>
            <div class="test-summary ${r.tests.ran ? (r.tests.ok ? 'pass' : 'fail') : 'error'}">
              ${r.tests.ran
                ? gridHtml`${r.tests.passed}/${r.tests.total} passed${r.tests.failed ? ` · ${r.tests.failed} failed` : ''}${r.tests.flaky ? ` · ${r.tests.flaky} flaky` : ''}${r.tests.skipped ? ` · ${r.tests.skipped} skipped` : ''}`
                : gridHtml`could not run: ${r.tests.error || 'unknown error'}`}
              ${r.tests.reportFile ? gridHtml` · <a href="${art(r.tests.reportFile)}" target="_blank" rel="noopener">report.json</a>` : gridHtml``}
            </div>
            ${(r.tests.failures && r.tests.failures.length) ? gridHtml`
              <details class="shot-details">
                <summary>${r.tests.failures.length} failing test${r.tests.failures.length === 1 ? '' : 's'}</summary>
                <div class="test-failures">${r.tests.failures.map((f: any) => gridHtml`
                  <div class="test-failure"><strong>${f.title}</strong> <small>${f.file}</small>
                    <pre class="usage detail-log">${f.error}</pre></div>`)}
                </div>
              </details>` : gridHtml``}
            ${(r.tests.files && r.tests.files.length) ? gridHtml`<div class="note detail-note">files: ${r.tests.files.join(', ')}</div>` : gridHtml``}
          </div>` : gridHtml``}
        ${r.logs && r.logs.length ? gridHtml`
          <div class="shots"><h4>Log</h4><details>
            <summary class="log-summary">${r.logs.length} lines</summary>
            <pre class="usage detail-log">${r.logs.join('\n')}</pre>
          </details></div>` : gridHtml``}
        ${r.error ? gridHtml`<div class="err"><strong>Error:</strong> ${r.error}</div>` : gridHtml``}
        ${r.matrixId ? gridHtml`
          <div class="delgroup">
            <igc-button class="danger-button" variant="contained"
              @click=${(ev: Event) => { ev.stopPropagation(); deleteMatrix(r.matrixId); }}>
              Delete entire matrix #${r.matrixId.split('-').pop()}
            </igc-button>
          </div>` : gridHtml``}
      </div>`;
  };

  $('#historyWhen').bodyTemplate = (ctx: any) => gridHtml`<span class="history-when">${getCellRow(ctx).whenDisplay}</span>`;
  // The grid shows whenDisplay via the template above, but the Excel exporter ignores
  // body templates and exports the raw field value — which for the numeric whenTs column
  // would be a bare epoch number. The exporter does honour the column formatter, so map
  // the epoch back to the same human-readable timestamp for the exported cell.
  $('#historyWhen').formatter = (value: number) => (value ? fmtWhen(new Date(value).toISOString()) : '—');
  $('#historyMatrix').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    const tag = matrixTagInfo(row.matrixId);
    if (!tag) return gridHtml`<span class="mxtag muted">—</span>`;
    return gridHtml`
      <span class="mxtag" style="color:${tag.color}" title="${row.matrixName ? `${row.matrixName} — ` : ''}${row.matrixId} — click to filter"
        @click=${(ev: Event) => {
          ev.stopPropagation();
          matrixFilter = matrixFilter === row.matrixId ? null : row.matrixId;
          renderRuns();
        }}>#${tag.label}</span>`;
  };
  $('#historyStatus').bodyTemplate = (ctx: any) => gridHtml`<span class="pill ${getCellRow(ctx).status}">${getCellRow(ctx).status}</span>`;
  $('#historyTests').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    return gridHtml`<span class="tests-cell ${row.testsState}" title="Playwright verification">${row.testsDisplay}</span>`;
  };
  // The exporter ignores body templates; map the numeric sort field back to the display.
  $('#historyTests').formatter = (_v: number, row: any) => (row && row.testsDisplay) || '—';
  $('#historyRating').bodyTemplate = (ctx: any) => {
    const row = getCellRow(ctx);
    const readonly = !isRateable(row.status);
    return gridHtml`<igc-rating class="history-rating ${readonly ? 'is-readonly' : ''}" max="5" step="1"
      .value=${row.rating}
      .readOnly=${readonly}
      @click=${(ev: Event) => ev.stopPropagation()}
      @igcChange=${(ev: CustomEvent<number>) => {
        ev.stopPropagation();
        saveRating(row.id, Number(ev.detail || 0));
      }}></igc-rating>`;
  };
  $('#historyMsgs').bodyTemplate = (ctx: any) => gridHtml`<span class="num-cell">${fmt(getCellRow(ctx).msgs)}</span>`;
  $('#historyTokens').bodyTemplate = (ctx: any) => gridHtml`<span class="num-cell">${fmt(getCellRow(ctx).tok)}</span>`;
  $('#historyCost').bodyTemplate = (ctx: any) => gridHtml`<span class="num-cell">${getCellRow(ctx).costDisplay}</span>`;
  $('#historyDuration').bodyTemplate = (ctx: any) => gridHtml`<span class="num-cell">${getCellRow(ctx).durationDisplay}</span>`;
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
    return gridHtml`<span class="history-actions-cell">
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
  const data = matrixFilter ? runsData.filter((r) => r.matrixId === matrixFilter) : runsData;
  st.shownCount = data.length;
  runById.clear();
  for (const r of data) runById.set(r.id, r);

  if (!data.length) {
    reconcileGridRows([]);
    st.gridVisible = false;
    setHistoryMessage(matrixFilter ? 'No runs match this matrix filter.' : 'No runs recorded yet.', true);
    update();
    return;
  }

  setHistoryMessage('', false);
  st.gridVisible = true;
  update();
  reconcileGridRows(data.map(rowVals));
}

export async function loadHistory() {
  const hadData = runsData.length > 0;
  if (!hadData) {
    st.gridVisible = false;
    setHistoryMessage('Loading run history...', true);
    update();
  }
  try {
    const j = await getJSON('/api/history');
    if (!j || !j.ok) throw new Error(j && j.error ? j.error : 'failed to load history');
    runsData = j.runs || [];
    if (matrixFilter && !runsData.some((r) => r.matrixId === matrixFilter)) matrixFilter = null;
    renderRuns();
  } catch (err: any) {
    st.gridVisible = false;
    setHistoryMessage(`Could not load run history: ${err.message}`, true);
    update();
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
  st.rerunSummary = `${c.framework || '—'} · ${(c.models || [])[0] || '—'}${snippet ? ` · "${snippet}"` : ''}`;
  update();
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
    variants: [{ mcps: c.enabledMcps || [], skills: !!c.skills, localSkills: !!c.overrideSkills }],
    model: (c.models || [])[0],
    prompt: r.prompt,
    apiKey,
    customBaseUrl: c.customBaseUrl || undefined,
    selectedTests: Array.isArray(c.selectedTests) ? c.selectedTests : undefined,
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

function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.click();
}

// ---------- templates ----------

function metaTpl() {
  if (matrixFilter) {
    const label = matrixFilter.split('-').pop();
    return html`${st.shownCount} run${st.shownCount === 1 ? '' : 's'} in matrix #${label} ·
      <a href="#" id="historyClear" style="color:var(--teal)"
        @click=${(ev: Event) => { ev.preventDefault(); matrixFilter = null; renderRuns(); }}>show all</a>`;
  }
  return html`${runsData.length} run${runsData.length === 1 ? '' : 's'}`;
}

function lightboxTpl() {
  const { shots, art, idx, gen } = st.lb;
  return html`
  <igc-dialog id="shotLightbox" aria-label="Screenshot viewer"
    close-on-outside-click hide-default-action
    @igcClosed=${closeLightbox}>
    <button id="shotLightboxClose" aria-label="Close (Esc)" title="Close (Esc)" @click=${closeLightbox}>&times;</button>
    ${keyed(gen, html`
      <igc-carousel id="shotCarousel" class="shot-carousel" loop="false"
        @igcSlideChanged=${(ev: any) => { if (typeof ev.target.current === 'number') st.lb.idx = ev.target.current; }}>
        ${shots.map((s, i) => html`
          <igc-carousel-slide .active=${i === idx}>
            <div class="shot-slide">
              <img src=${art(s.file)} alt=${s.route}>
              <div class="shot-slide-cap">${s.route}  ·  ${i + 1} / ${shots.length}</div>
            </div>
          </igc-carousel-slide>`)}
      </igc-carousel>`)}
  </igc-dialog>`;
}

function tpl() {
  return html`
  <div class="history-head">
    <p class="eyebrow" style="margin:0">Run history</p>
    <igc-button type="button" id="historyRefresh" class="history-refresh" variant="outlined" @click=${() => loadHistory()}>Refresh</igc-button>
    <igc-button type="button" id="historyExport" class="history-refresh" variant="outlined" @click=${() => download('/api/history/export')}>Export HTML</igc-button>
    <igc-button type="button" id="historyExportJson" class="history-refresh" variant="outlined" @click=${() => download('/api/history/export.json')}>Export JSON</igc-button>
    <span class="note" id="historyMeta" style="margin:0">${metaTpl()}</span>
  </div>
  <p class="note" id="historyEmpty" ?hidden=${!st.emptyVisible}>${st.emptyMsg}</p>
  <igc-grid id="runsGrid" class="runs-grid" auto-generate="false" primary-key="id" cell-selection="none" ?hidden=${!st.gridVisible}>
    <igc-grid-toolbar>
      <igc-grid-toolbar-actions>
        <igc-grid-toolbar-exporter id="historyExcelExporter"></igc-grid-toolbar-exporter>
      </igc-grid-toolbar-actions>
    </igc-grid-toolbar>
    <igc-column id="historyWhen" field="whenTs" header="When" data-type="number" sortable="true" resizable="true" width="13%"></igc-column>
    <igc-column id="historyMatrix" field="matrixId" header="Matrix" sortable="true" resizable="true" width="7%"></igc-column>
    <igc-column id="historyFramework" field="framework" header="Framework" sortable="true" resizable="true" width="7%"></igc-column>
    <igc-column id="historyModel" field="model" header="Model" sortable="true" resizable="true" width="11%"></igc-column>
    <igc-column id="historySkills" field="skills" header="Skills" sortable="false" resizable="true" width="4%"></igc-column>
    <igc-column id="historyMcps" field="mcps" header="MCPs" sortable="false" resizable="true"></igc-column>
    <igc-column id="historyStatus" field="status" header="Status" sortable="true" resizable="true" width="110px"></igc-column>
    <igc-column id="historyTests" field="testsSort" header="Tests" data-type="number" sortable="false" resizable="true" width="5%"></igc-column>
    <igc-column id="historyRating" field="rating" header="Rating" data-type="number" sortable="true" resizable="true" width="135px"></igc-column>
    <igc-column id="historyMsgs" field="msgs" header="Msgs" data-type="number" sortable="true" resizable="true" width="5%"></igc-column>
    <igc-column id="historyTokens" field="tok" header="Tokens" data-type="number" sortable="true" resizable="true" width="6%"></igc-column>
    <igc-column id="historyCost" field="costSort" header="Cost (USD)" data-type="number" sortable="true" resizable="true" width="6%"></igc-column>
    <igc-column id="historyDuration" field="durationMs" header="Duration" data-type="number" sortable="true" resizable="true" width="5%"></igc-column>
    <igc-column id="historyActions" field="actions" header="Actions" resizable="true" width="6%" max-width="85px"></igc-column>
  </igc-grid>

  <!-- API-key prompt for re-running a matrix configuration from the History tab. -->
  <igc-dialog id="rerunDialog" title="Re-run configuration">
    <p class="note" id="rerunSummary">${st.rerunSummary}</p>
    <igc-input outlined id="rerunKey" label="API key" type="password" autocomplete="off"></igc-input>
    <igc-button slot="footer" id="rerunCancel" variant="flat"
      @click=${() => { pendingRerun = null; ($('#rerunDialog') as any).hide(); }}>Cancel</igc-button>
    <igc-button slot="footer" id="rerunConfirm" variant="contained" @click=${confirmRerun}>Re-run</igc-button>
  </igc-dialog>

  <!-- Screenshot viewer — igc-carousel inside a fullscreen igc-dialog (native
       <dialog>: modal focus trap, Esc close, focus restore on close). -->
  ${lightboxTpl()}`;
}

let mountEl: HTMLElement | null = null;

function update() {
  if (!mountEl) return;
  render(tpl(), mountEl);
}

export function mountHistory(el: HTMLElement) {
  mountEl = el;
  update();
}
