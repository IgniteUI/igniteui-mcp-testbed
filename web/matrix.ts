// Matrix view: platform × variant grid of one-shot headless runs, streamed live.
import { $, esc, validateMcpJson } from './util.ts';
import { getJSON, postJSON } from './api.ts';
import { isSessionLive } from './wizard.ts';

// Live-validate the shared custom MCP JSON (mirrors the wizard's own field).
function refreshMxCustomMcpErr(): boolean {
  if ($('#mxCustomMcp').hidden) { $('#mxCustomMcpErr').hidden = true; return true; }
  const err = validateMcpJson($('#mxCustomMcp').value);
  $('#mxCustomMcpErr').textContent = err || '';
  $('#mxCustomMcpErr').hidden = !err;
  return !err;
}
$('#mxCustomMcp').addEventListener('igcInput', refreshMxCustomMcpErr);

// The shared JSON field only matters while at least one variant row has its Custom
// MCP checkbox on — keep it hidden otherwise.
function syncMxCustomMcpEnabled() {
  const on = [...document.querySelectorAll<any>('#mxVariants igc-checkbox[data-mcp="custom"]')].some((c) => c.checked);
  $('#mxCustomMcp').hidden = !on;
  refreshMxCustomMcpErr();
}

// igc-checkbox exposes `.checked` as a property (not the CSS :checked pseudo).
const mxPlatforms = () => [...document.querySelectorAll<any>('#mxPlatforms igc-checkbox')].filter((c) => c.checked).map((c) => c.value);

// Skill mode <-> {skills, localSkills} (the 4-way axis): off / default / local / merge.
// local = local-only (generated wiped); merge = generated + local overlaid.
function skillModeOf(v: { skills: boolean; localSkills: boolean }): string {
  if (v.localSkills) return v.skills ? 'merge' : 'local';
  return v.skills ? 'default' : 'off';
}
function flagsFromMode(mode: string): { skills: boolean; localSkills: boolean } {
  switch (mode) {
    case 'default': return { skills: true, localSkills: false };
    case 'local': return { skills: false, localSkills: true };
    case 'merge': return { skills: true, localSkills: true };
    default: return { skills: false, localSkills: false };
  }
}

// Variant builder: each row = which MCPs are enabled + a skill mode (the axis).
function addVariantRow(preset: { mcps: string[]; skills: boolean; localSkills: boolean } = { mcps: ['igniteui', 'theming'], skills: true, localSkills: false }) {
  const row: any = document.createElement('div');
  row.className = 'mx-variant';
  const has = (m: string) => preset.mcps.includes(m) ? 'checked' : '';
  const mode = skillModeOf(preset);
  const sel = (m: string) => mode === m ? 'selected' : '';
  row.innerHTML = `
    <igc-checkbox data-mcp="igniteui" ${has('igniteui')}>Ignite UI CLI MCP</igc-checkbox>
    <igc-checkbox data-mcp="theming" ${has('theming')}>Theming MCP</igc-checkbox>
    <igc-checkbox data-mcp="custom" ${has('custom')}>Custom MCP</igc-checkbox>
    <select data-skills title="Skills" class="mx-skills">
      <option value="off" ${sel('off')}>No skills</option>
      <option value="default" ${sel('default')}>Default skills</option>
      <option value="local" ${sel('local')}>Local skills</option>
      <option value="merge" ${sel('merge')}>Default + local</option>
    </select>
    <button type="button" class="rm" title="Remove variant">✕</button>`;
  row.querySelector('.rm').addEventListener('click', () => { row.remove(); updateMxCount(); });
  row.querySelectorAll('igc-checkbox').forEach((c: any) => c.addEventListener('igcChange', updateMxCount));
  row.querySelector('select[data-skills]').addEventListener('change', updateMxCount);
  $('#mxVariants').appendChild(row);
  updateMxCount();
}

// Read + dedupe the variant rows into [{mcps:[], skills:bool, localSkills:bool}].
function mxVariants() {
  const seen = new Set<string>(), out: { mcps: string[]; skills: boolean; localSkills: boolean }[] = [];
  for (const row of document.querySelectorAll<any>('#mxVariants .mx-variant')) {
    const mcps = [...row.querySelectorAll('igc-checkbox[data-mcp]')].filter((c: any) => c.checked).map((c: any) => c.dataset.mcp);
    const { skills, localSkills } = flagsFromMode(row.querySelector('select[data-skills]').value);
    const key = mcps.join(',') + '|' + skills + '|' + localSkills;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ mcps, skills, localSkills });
  }
  return out;
}

export function updateMxCount() {
  const p = mxPlatforms().length, v = mxVariants().length;
  $('#mxCount').textContent = `${p * v} run${p * v === 1 ? '' : 's'} (${p} platform${p === 1 ? '' : 's'} × ${v} variant${v === 1 ? '' : 's'})`;
  refreshMxLocalSkills();
  refreshMxTestFiles();
  syncMxCustomMcpEnabled();
}

// Show which local skills are available per selected platform — but only when a variant
// actually uses local skills (local/merge mode), since each entry overlays only its own
// platform's ./local-skills/<fw> folder.
async function refreshMxLocalSkills() {
  const note = $('#mxLocalSkills');
  const platforms = mxPlatforms();
  if (!platforms.length || !mxVariants().some((v) => v.localSkills)) { note.hidden = true; return; }
  try {
    const j = await getJSON('/api/local-skills');
    const map = j.byPlatform || {};
    const lines = platforms.map((p) => {
      const valid = (map[p] || []).filter((s: any) => s.valid).map((s: any) => s.name);
      return `${p}: ${valid.length ? valid.join(', ') : 'none'}`;
    });
    note.textContent = `Local skills — ${lines.join(' · ')}`;
  } catch {
    note.textContent = 'Could not list local skills.';
  }
  note.hidden = false;
}

// Show the Playwright specs the verify stage would run: the shared set (every platform)
// plus each selected platform's overlay. Informational; the Skip tests toggle opts out.
async function refreshMxTestFiles() {
  const note = $('#mxTestsList');
  const platforms = mxPlatforms();
  if (!platforms.length) { note.hidden = true; return; }
  try {
    const j = await getJSON('/api/tests');
    const shared = j.shared || [];
    const map = j.byPlatform || {};
    const lines = platforms.map((p) => `${p}: ${(map[p] || []).length ? map[p].join(', ') : '—'}`);
    const total = shared.length + platforms.reduce((n, p) => n + (map[p] || []).length, 0);
    note.textContent = total
      ? `Tests — shared: ${shared.length ? shared.join(', ') : '—'} · ${lines.join(' · ')}`
      : `No test files found under ${j.dir} — add Playwright specs to ./tests/shared/ or ./tests/<platform>/.`;
  } catch {
    note.textContent = 'Could not list test files.';
  }
  note.hidden = false;
}
document.querySelectorAll<any>('#mxPlatforms igc-checkbox').forEach((c) => c.addEventListener('igcChange', updateMxCount));
$('#mxAddVariant').addEventListener('click', () => addVariantRow({ mcps: [], skills: false, localSkills: false }));
addVariantRow(); // seed one default variant (igniteui+theming, default skills)

let mxES: EventSource | null = null;
let mxTotal = 0, mxDone = 0;
let matrixActive = false;
const mxEntryEls = new Map<number, any>(); // index -> { el, pill, step, mini, log }

// A matrix run drives the same app/opencode processes and fixed ports as an
// interactive session, so the Wizard "Launch session" button is locked while one runs.
export function setMatrixActive(active: boolean) {
  matrixActive = active;
  $('#wizBlocked').hidden = !active;
  $('#mxCancel').hidden = !active;
  if (active) { $('#go').disabled = true; $('#fw').disabled = true; }
  else if (!isSessionLive()) { $('#go').disabled = false; $('#fw').disabled = false; }
}

$('#mxCancel').addEventListener('click', async () => {
  $('#mxCancel').disabled = true;
  try { await fetch('/api/matrix/cancel', { method: 'POST' }); } catch (_) {}
  $('#mxCancel').disabled = false;
});

function mxEntry(e: any) {
  let rec = mxEntryEls.get(e.index);
  if (!rec) {
    const li: any = document.createElement('li');
    li.className = 'mx-entry';
    li.innerHTML = `<div class="top"><span class="caret">▸</span><span class="pill ${e.status || 'pending'}" data-pill>${e.status || 'pending'}</span>
      <span class="who">${esc(e.platform || '')} · ${esc(e.variantLabel || '')}</span><span class="step" data-step></span></div>
      <div class="mini" data-mini></div>`;
    li.querySelector('.top').addEventListener('click', () => {
      const opened = li.classList.toggle('open');
      if (opened) { const mini = li.querySelector('[data-mini]'); mini.scrollTop = mini.scrollHeight; }
    });
    $('#mxEntries').appendChild(li);
    rec = { el: li, pill: li.querySelector('[data-pill]'), step: li.querySelector('[data-step]'), mini: li.querySelector('[data-mini]'), log: [] };
    mxEntryEls.set(e.index, rec);
  }
  return rec;
}
function mxStatus(rec: any, status: string) { rec.pill.className = `pill ${status}`; rec.pill.textContent = status; }
function mxOverall() { $('#mxOverall').textContent = mxTotal ? `${mxDone}/${mxTotal}` : ''; }

function startMatrixStream() {
  if (mxES) mxES.close();
  mxEntryEls.clear();
  $('#mxEntries').innerHTML = '';
  mxES = new EventSource('/api/matrix/stream');
  mxES.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleMx(m); };
}

// Open the matrix stream once when the view is first shown (idempotent).
export function ensureMatrixStream() {
  if (!mxES) startMatrixStream();
}

function handleMx(m: any) {
  if (m.type === 'state') {
    const s = m.state || {};
    mxTotal = s.total || 0; mxDone = s.done || 0; mxOverall();
    (s.entries || []).forEach((e: any) => {
      const rec = mxEntry(e);
      mxStatus(rec, e.status);
      // Restore the step label (current step while running, or the outcome summary).
      if (e.step != null) rec.step.textContent = e.step;
      // Replay retained logs so a reconnect/reload doesn't lose past entries' output.
      if (Array.isArray(e.logs)) { rec.log = e.logs.slice(); rec.mini.textContent = rec.log.join('\n'); }
    });
    if ((s.entries || []).length) $('#mxEmpty').hidden = true;
    setMatrixActive(!!s.running);
    if (!s.running) { $('#mxGo').disabled = false; }
    return;
  }
  if (m.type === 'matrix-start') {
    $('#mxEmpty').hidden = true; mxTotal = m.total; mxDone = 0; mxOverall();
    (m.entries || []).forEach((e: any) => mxEntry(e));
    setMatrixActive(true);
    return;
  }
  if (m.type === 'entry-start') { mxStatus(mxEntry(m), 'running'); return; }
  if (m.type === 'matrix-done') {
    mxDone = m.total; mxTotal = m.total; mxOverall();
    $('#mxGo').disabled = false; setMatrixActive(false);
    if (mxES) { mxES.close(); mxES = null; }
    return;
  }
  if (m.index != null) {
    const rec = mxEntry({ index: m.index });
    const HB = /still running \(\d+s\)/;
    const appendLog = (line: string) => {
      // Collapse consecutive heartbeats into one updating line (mirrors the server).
      if (HB.test(line) && rec.log.length && HB.test(rec.log[rec.log.length - 1])) {
        rec.log[rec.log.length - 1] = line;
      } else {
        rec.log.push(line);
        if (rec.log.length > 800) rec.log.shift();
      }
      rec.mini.textContent = rec.log.join('\n');
      // Stick to the newest line unless the user has scrolled up to read history.
      const nearBottom = rec.mini.scrollHeight - rec.mini.scrollTop - rec.mini.clientHeight < 40;
      if (nearBottom) rec.mini.scrollTop = rec.mini.scrollHeight;
    };
    if (m.type === 'step') { rec.step.textContent = m.step; appendLog(`— ${m.step} —`); }
    else if (m.type === 'log') appendLog(m.msg);
    else if (m.type === 'error') appendLog('ERROR: ' + m.msg);
    else if (m.type === 'entry-done') {
      mxStatus(rec, m.status);
      mxDone += 1; mxOverall();
      if (m.status === 'success') {
        const shots = `${(m.screenshots || []).filter((s: any) => s.ok).length} shots`;
        rec.step.textContent = m.tests && m.tests.ran ? `${shots} · ${m.tests.passed}/${m.tests.total} tests` : shots;
      } else if (m.status === 'build-error') rec.step.textContent = 'build failed';
      else if (m.status === 'test-failed') rec.step.textContent = m.tests ? `tests failed (${m.tests.failed}/${m.tests.total})` : 'tests failed';
    }
  }
}

// On load, lock the wizard launch if a matrix is already running (the Wizard tab
// may be the one shown). Mirrors the session re-attach in wizard.js.
export async function checkMatrixLock() {
  try {
    const ms = await getJSON('/api/matrix/status');
    if (ms && ms.running) setMatrixActive(true);
  } catch (_) {}
}

$('#mxForm').addEventListener('submit', async (e: any) => {
  e.preventDefault();
  if (!refreshMxCustomMcpErr()) { $('#mxCustomMcp').scrollIntoView({ block: 'center' }); return; }
  const platforms = mxPlatforms(), variants = mxVariants();
  const model = $('#mxModel').value.trim(), prompt = $('#mxPrompt').value.trim();
  if (!platforms.length || !variants.length) { alert('Pick at least one platform and one variant.'); return; }
  if (!model) { alert('Enter a model id.'); return; }
  if (!prompt) { alert('Enter a prompt.'); return; }
  const body = { platforms, variants, model, prompt, apiKey: $('#mxKey').value, customMcp: $('#mxCustomMcp').value.trim() || undefined, skipTests: $('#mxSkipTests').checked };
  $('#mxGo').disabled = true;
  try {
    const j = await postJSON('/api/matrix', body);
    if (!j.ok) { $('#mxGo').disabled = false; alert(j.error || 'failed to start matrix'); return; }
    if (j.dropped) $('#mxOverall').textContent = `capped — ${j.dropped} entr${j.dropped === 1 ? 'y' : 'ies'} dropped`;
    setMatrixActive(true);
    startMatrixStream();
  } catch (err: any) { $('#mxGo').disabled = false; alert(err.message); }
});
