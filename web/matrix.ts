// Matrix view: platform × variant grid of one-shot headless runs, streamed live.
// Rendered with lit-html from a single state object; ids/classes match app.css.
import { html, render, repeat, classMap } from './lit.ts';
import { $, validateMcpJson, syncTestsCombo } from './util.ts';
import { getJSON, postJSON } from './api.ts';
import { setMatrixLock } from './wizard.ts';

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

const MCP_ROW: Array<[string, string]> = [
  ['igniteui', 'Ignite UI CLI MCP'],
  ['theming', 'Theming MCP'],
  ['custom', 'Custom MCP'],
];

interface VariantRow { key: number; mcps: string[]; mode: string }
interface EntryVm {
  index: number; platform: string; variantLabel: string;
  status: string; step: string; logs: string[]; open: boolean;
}

let variantKey = 0;
const newRow = (mcps: string[], mode: string): VariantRow => ({ key: ++variantKey, mcps, mode });

const st = {
  variants: [newRow(['igniteui', 'theming'], 'default')] as VariantRow[],
  countText: '',
  customMcpErr: null as string | null,
  localSkillsNote: null as string | null,
  testsNote: `Grouped by framework — each platform's group lists the specs that run for it
    (its own overlay plus the shared set). Only the selected files run per entry; clear the selection to skip.
    A failing suite marks that entry test-failed in History.`,
  keyPlaceholder: 'sk-…',
  entries: [] as EntryVm[],
  overall: '',
  active: false,
  goDisabled: false,
  total: 0,
  done: 0,
};

const anyCustomMcp = () => st.variants.some((v) => v.mcps.includes('custom'));

// igc-checkbox exposes `.checked` as a property (not the CSS :checked pseudo).
const mxPlatforms = () => [...document.querySelectorAll<any>('#mxPlatforms igc-checkbox')].filter((c) => c.checked).map((c) => c.value);

// Live-validate the shared custom MCP JSON (mirrors the wizard's own field).
function refreshMxCustomMcpErr(): boolean {
  st.customMcpErr = anyCustomMcp() ? validateMcpJson($('#mxCustomMcp').value) : null;
  return !st.customMcpErr;
}

// Read + dedupe the variant rows into [{mcps:[], skills:bool, localSkills:bool}].
function mxVariants() {
  const seen = new Set<string>(), out: { mcps: string[]; skills: boolean; localSkills: boolean }[] = [];
  for (const row of st.variants) {
    const { skills, localSkills } = flagsFromMode(row.mode);
    const key = row.mcps.join(',') + '|' + skills + '|' + localSkills;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ mcps: row.mcps.slice(), skills, localSkills });
  }
  return out;
}

export function updateMxCount() {
  const p = mxPlatforms().length, v = mxVariants().length;
  st.countText = `${p * v} run${p * v === 1 ? '' : 's'} (${p} platform${p === 1 ? '' : 's'} × ${v} variant${v === 1 ? '' : 's'})`;
  refreshMxLocalSkills();
  refreshMxTestFiles();
  refreshMxCustomMcpErr();
  update();
}

// Show which local skills are available per selected platform — but only when a variant
// actually uses local skills (local/merge mode), since each entry overlays only its own
// platform's ./local-skills/<fw> folder.
async function refreshMxLocalSkills() {
  const platforms = mxPlatforms();
  if (!platforms.length || !mxVariants().some((v) => v.localSkills)) {
    st.localSkillsNote = null; update(); return;
  }
  try {
    const j = await getJSON('/api/local-skills');
    const map = j.byPlatform || {};
    const lines = platforms.map((p) => {
      const valid = (map[p] || []).filter((s: any) => s.valid).map((s: any) => s.name);
      return `${p}: ${valid.length ? valid.join(', ') : 'none'}`;
    });
    st.localSkillsNote = `Local skills — ${lines.join(' · ')}`;
  } catch {
    st.localSkillsNote = 'Could not list local skills.';
  }
  update();
}

const testsNoteFor = (sel: number, total: number) =>
  `${sel}/${total} test file(s) selected across the selected platforms. Each entry runs only its own group's specs; clear to skip.`;

// Populate the tests combo, grouped by framework: one group per selected platform, whose
// items are the specs that run for it — its own overlay plus the shared set (a shared spec
// is listed under each platform, so it can be toggled per framework). All discovered specs
// start selected; each entry runs only its own group's selected specs. Selection is
// preserved as platforms are toggled.
const mxTestsKnownIds = new Set<string>();
// Generation counter: updateMxCount fires this un-awaited on every platform/variant
// change, so during a burst (e.g. config prefill rebuilding rows) only the newest
// call may apply its result — a stale response must not clobber the combo.
let mxTestsRefreshSeq = 0;
async function refreshMxTestFiles() {
  const seq = ++mxTestsRefreshSeq;
  const combo = $('#mxTestsCombo');
  const platforms = mxPlatforms();
  try {
    const j = await getJSON('/api/tests');
    if (seq !== mxTestsRefreshSeq) return;
    const shared = j.shared || [];
    const map = j.byPlatform || {};
    const data = platforms.flatMap((p) => [
      ...shared.map((f: string) => ({ id: `${p}::shared/${f}`, file: f, category: p })),
      ...(map[p] || []).map((f: string) => ({ id: `${p}::${p}/${f}`, file: f, category: p })),
    ]);
    const sel = syncTestsCombo(combo, data, mxTestsKnownIds);
    combo.disabled = !data.length;
    st.testsNote = data.length
      ? testsNoteFor(sel.length, data.length)
      : `No test files found under ${j.dir} — add Playwright specs to ./tests/shared/ or ./tests/<platform>/.`;
  } catch {
    if (seq !== mxTestsRefreshSeq) return;
    st.testsNote = 'Could not list test files.';
  }
  update();
}

function onTestsComboChange() {
  const combo = $('#mxTestsCombo');
  const total = (combo.data || []).length;
  if (total) st.testsNote = testsNoteFor((combo.value || []).length, total);
  update();
}

// ---------- variant row events ----------

function toggleVariantMcp(row: VariantRow, mcp: string, on: boolean) {
  row.mcps = on ? [...new Set([...row.mcps, mcp])] : row.mcps.filter((m) => m !== mcp);
  updateMxCount();
}

function removeVariant(row: VariantRow) {
  st.variants = st.variants.filter((v) => v !== row);
  updateMxCount();
}

function addVariant(mcps: string[] = [], mode = 'off') {
  st.variants = [...st.variants, newRow(mcps, mode)];
  updateMxCount();
}

// ---------- run lock / progress ----------

// A matrix run drives the same app/opencode processes and fixed ports as an
// interactive session, so the Wizard "Launch session" button is locked while one runs.
export function setMatrixActive(active: boolean) {
  st.active = active;
  // The wizard derives its own launch-lock from this flag plus its live/busy state.
  setMatrixLock(active);
  update();
}

async function onCancel(e: Event) {
  (e.target as any).disabled = true;
  try { await fetch('/api/matrix/cancel', { method: 'POST' }); } catch (_) {}
  (e.target as any).disabled = false;
}

let mxES: EventSource | null = null;

function ensureEntry(e: any): EntryVm {
  let entry = st.entries.find((x) => x.index === e.index);
  if (!entry) {
    entry = {
      index: e.index, platform: e.platform || '', variantLabel: e.variantLabel || '',
      status: e.status || 'pending', step: '', logs: [], open: false,
    };
    st.entries = [...st.entries, entry].sort((a, b) => a.index - b.index);
  }
  return entry;
}

const HB = /still running \(\d+s\)/;
function appendLog(entry: EntryVm, line: string) {
  // Collapse consecutive heartbeats into one updating line (mirrors the server).
  if (HB.test(line) && entry.logs.length && HB.test(entry.logs[entry.logs.length - 1])) {
    entry.logs[entry.logs.length - 1] = line;
  } else {
    entry.logs.push(line);
    if (entry.logs.length > 800) entry.logs.shift();
  }
}

function startMatrixStream() {
  if (mxES) mxES.close();
  st.entries = [];
  update();
  mxES = new EventSource('/api/matrix/stream');
  mxES.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleMx(m); };
}

// Open the matrix stream once when the view is first shown (idempotent).
export function ensureMatrixStream() {
  if (!mxES) startMatrixStream();
}

const overallText = () => (st.total ? `${st.done}/${st.total}` : '');

function handleMx(m: any) {
  if (m.type === 'state') {
    const s = m.state || {};
    st.total = s.total || 0; st.done = s.done || 0; st.overall = overallText();
    (s.entries || []).forEach((e: any) => {
      const entry = ensureEntry(e);
      entry.status = e.status;
      // Restore the step label (current step while running, or the outcome summary).
      if (e.step != null) entry.step = e.step;
      // Replay retained logs so a reconnect/reload doesn't lose past entries' output.
      if (Array.isArray(e.logs)) entry.logs = e.logs.slice();
    });
    setMatrixActive(!!s.running);
    if (!s.running) st.goDisabled = false;
    update();
    return;
  }
  if (m.type === 'matrix-start') {
    st.total = m.total; st.done = 0; st.overall = overallText();
    (m.entries || []).forEach((e: any) => ensureEntry(e));
    setMatrixActive(true);
    update();
    return;
  }
  if (m.type === 'entry-start') { ensureEntry(m).status = 'running'; update(); return; }
  if (m.type === 'matrix-done') {
    st.done = m.total; st.total = m.total; st.overall = overallText();
    st.goDisabled = false;
    setMatrixActive(false);
    if (mxES) { mxES.close(); mxES = null; }
    update();
    return;
  }
  if (m.index != null) {
    const entry = ensureEntry({ index: m.index });
    if (m.type === 'step') { entry.step = m.step; appendLog(entry, `— ${m.step} —`); }
    else if (m.type === 'log') appendLog(entry, m.msg);
    else if (m.type === 'error') appendLog(entry, 'ERROR: ' + m.msg);
    else if (m.type === 'entry-done') {
      entry.status = m.status;
      st.done += 1; st.overall = overallText();
      if (m.status === 'success') {
        const shots = `${(m.screenshots || []).filter((s: any) => s.ok).length} shots`;
        entry.step = m.tests && m.tests.ran ? `${shots} · ${m.tests.passed}/${m.tests.total} tests` : shots;
      } else if (m.status === 'build-error') entry.step = 'build failed';
      else if (m.status === 'test-failed') entry.step = m.tests ? `tests failed (${m.tests.failed}/${m.tests.total})` : 'tests failed';
    }
    update();
  }
}

// On load, lock the wizard launch if a matrix is already running (the Wizard tab
// may be the one shown). Mirrors the session re-attach in wizard.ts.
export async function checkMatrixLock() {
  try {
    const ms = await getJSON('/api/matrix/status');
    if (ms && ms.running) setMatrixActive(true);
  } catch (_) {}
}

// Prefill the matrix form from the server-side MATRIX_CONFIG file (if any), so a
// terminal-provided config is reflected in the UI. The API key never reaches the
// browser — hasApiKey only flips the field's placeholder; the server falls back to
// the config's key when the field is submitted empty.
export async function applyServerMatrixConfig() {
  let cfg: any;
  try { cfg = (await getJSON('/api/matrix/config')).config; } catch { return; }
  if (!cfg) return;
  // Setting .checked programmatically doesn't fire igcChange — updateMxCount below
  // does the recount that the change handlers would have.
  document.querySelectorAll<any>('#mxPlatforms igc-checkbox')
    .forEach((c) => { c.checked = cfg.platforms.includes(c.value); });
  st.variants = (cfg.variants || []).map((v: any) => newRow(v.mcps || [], skillModeOf(v)));
  $('#mxModel').value = cfg.model || '';
  $('#mxPrompt').value = cfg.prompt || '';
  if (cfg.customMcp) $('#mxCustomMcp').value = cfg.customMcp;
  if (cfg.hasApiKey) st.keyPlaceholder = 'using key from server config';
  updateMxCount();
  // The combo must be populated before the config's selection can be applied; the
  // seq guard makes this awaited refresh the one that owns the combo.
  await refreshMxTestFiles();
  if (cfg.selectedTests !== null && cfg.selectedTests !== undefined) {
    const combo = $('#mxTestsCombo');
    const avail = new Set((combo.data || []).map((d: any) => d.id));
    combo.value = (cfg.selectedTests as string[]).filter((id) => avail.has(id));
    const total = (combo.data || []).length;
    if (total) st.testsNote = testsNoteFor((combo.value || []).length, total);
  }
  if (cfg.dropped) st.overall = `config capped — ${cfg.dropped} entr${cfg.dropped === 1 ? 'y' : 'ies'} dropped`;
  update();
}

async function onSubmit(e: Event) {
  e.preventDefault();
  if (!refreshMxCustomMcpErr()) { update(); $('#mxCustomMcp').scrollIntoView({ block: 'center' }); return; }
  const platforms = mxPlatforms(), variants = mxVariants();
  const model = $('#mxModel').value.trim(), prompt = $('#mxPrompt').value.trim();
  if (!platforms.length || !variants.length) { alert('Pick at least one platform and one variant.'); return; }
  if (!model) { alert('Enter a model id.'); return; }
  if (!prompt) { alert('Enter a prompt.'); return; }
  const body = {
    platforms, variants, model, prompt,
    apiKey: $('#mxKey').value,
    customMcp: $('#mxCustomMcp').value.trim() || undefined,
    selectedTests: ($('#mxTestsCombo').value || []) as string[],
  };
  st.goDisabled = true;
  update();
  try {
    const j = await postJSON('/api/matrix', body);
    if (!j.ok) { st.goDisabled = false; update(); alert(j.error || 'failed to start matrix'); return; }
    if (j.dropped) st.overall = `capped — ${j.dropped} entr${j.dropped === 1 ? 'y' : 'ies'} dropped`;
    setMatrixActive(true);
    startMatrixStream();
  } catch (err: any) { st.goDisabled = false; update(); alert(err.message); }
}

// ---------- templates ----------

const variantRow = (row: VariantRow) => html`
  <div class="mx-variant">
    ${MCP_ROW.map(([mcp, label]) => html`
      <igc-checkbox data-mcp=${mcp} .checked=${row.mcps.includes(mcp)}
        @igcChange=${(e: any) => toggleVariantMcp(row, mcp, !!e.target.checked)}>${label}</igc-checkbox>`)}
    <select data-skills title="Skills" class="mx-skills" .value=${row.mode}
      @change=${(e: any) => { row.mode = e.target.value; updateMxCount(); }}>
      <option value="off">No skills</option>
      <option value="default">Default skills</option>
      <option value="local">Local skills</option>
      <option value="merge">Default + local</option>
    </select>
    <button type="button" class="rm" title="Remove variant" @click=${() => removeVariant(row)}>✕</button>
  </div>`;

const entryItem = (e: EntryVm) => html`
  <li class="mx-entry ${classMap({ open: e.open })}">
    <div class="top" @click=${() => { e.open = !e.open; update(); }}>
      <span class="caret">▸</span><span class="pill ${e.status || 'pending'}">${e.status || 'pending'}</span>
      <span class="who">${e.platform} · ${e.variantLabel}</span><span class="step">${e.step}</span>
    </div>
    <div class="mini">${e.logs.join('\n')}</div>
  </li>`;

function tpl() {
  return html`
  <!-- left: matrix setup -->
  <section class="panel">
    <p class="eyebrow">Matrix setup</p>
    <form id="mxForm" @submit=${onSubmit}>
      <fieldset>
        <legend>Platforms <small style="color:var(--steel);font-weight:400">(axis)</small></legend>
        <div id="mxPlatforms" @igcChange=${() => updateMxCount()}>
          <igc-checkbox value="angular" checked>Angular</igc-checkbox>
          <igc-checkbox value="blazor">Blazor</igc-checkbox>
          <igc-checkbox value="react">React</igc-checkbox>
          <igc-checkbox value="webcomponents">Web Comps</igc-checkbox>
        </div>
      </fieldset>

      <fieldset>
        <legend>Model <small style="color:var(--steel);font-weight:400">(fixed · one for all)</small></legend>
        <igc-input id="mxModel" label="Model id" placeholder="anthropic/claude-sonnet-4-5"></igc-input>
      </fieldset>

      <fieldset>
        <legend>Prompt <small style="color:var(--steel);font-weight:400">(one-shot, shared)</small></legend>
        <textarea id="mxPrompt" class="ta" rows="4" placeholder="e.g. Build a dashboard page with a data grid and a chart."></textarea>
      </fieldset>

      <fieldset>
        <legend>Variants <small style="color:var(--steel);font-weight:400">(axis · MCPs + skill mode per row)</small></legend>
        <div id="mxVariants">${repeat(st.variants, (v) => v.key, variantRow)}</div>
        <button type="button" class="viewbtn" id="mxAddVariant" style="margin-top:.5rem" @click=${() => addVariant()}>+ add variant</button>
        <igc-textarea id="mxCustomMcp" class="mcp-ta" rows="3" ?hidden=${!anyCustomMcp()}
          @igcInput=${() => { refreshMxCustomMcpErr(); update(); }}
          placeholder='{"command": "npx", "args": ["-y", "my-mcp-server"]}'></igc-textarea>
        <p class="note err" id="mxCustomMcpErr" ?hidden=${!st.customMcpErr}>${st.customMcpErr || ''}</p>
        <p class="note">Custom MCP server def (shared by every entry, same shape as the interactive wizard's) —
        only applied to variant rows with the <strong>Custom MCP</strong> checkbox ticked.</p>
        <p class="note" id="mxLocalSkills" ?hidden=${!st.localSkillsNote}>${st.localSkillsNote || ''}</p>
        <details class="help">
          <summary>Skill modes &amp; local skills</summary>
          <div class="help-body">
            <p>Each variant row picks a skill mode, run against every selected platform:</p>
            <ul>
              <li><strong>No skills</strong> — agent runs with no skills.</li>
              <li><strong>Default skills</strong> — the generated Ignite UI skills only.</li>
              <li><strong>Local skills</strong> — only <em>your</em> skills (the generated
              set is wiped).</li>
              <li><strong>Default + local</strong> — generated skills with your local ones
              overlaid (same-named local folders replace generated ones; new names add).</li>
            </ul>
            <p>Local skills are <em>any</em> folder with a <code>SKILL.md</code> you drop on
            the host under that platform — <code>local-skills/&lt;framework&gt;/&lt;your-skill&gt;/</code>.
            Each entry only uses its own platform’s folder. Add the same skill under several
            framework folders to compare them across platforms. The line above lists what’s
            found for the selected platforms when a row uses local skills.</p>
          </div>
        </details>
      </fieldset>

      <fieldset>
        <legend>API key</legend>
        <igc-input id="mxKey" label="API key" type="password" placeholder=${st.keyPlaceholder} autocomplete="off"></igc-input>
        <p class="note">One key applied to every entry. Mixing providers in one matrix needs them to share a key.</p>
      </fieldset>

      <fieldset>
        <legend>Verification tests</legend>
        <igc-combo id="mxTestsCombo" label="Tests to run" placeholder="Select test files…"
          value-key="id" display-key="file" group-key="category" @igcChange=${onTestsComboChange}></igc-combo>
        <p class="note" id="mxTestsNote">${st.testsNote}</p>
      </fieldset>

      <p class="mx-count" id="mxCount">${st.countText}</p>
      <igc-button type="submit" id="mxGo" variant="contained" .disabled=${st.goDisabled}>Run matrix</igc-button>
    </form>
  </section>

  <!-- right: matrix progress -->
  <section class="panel">
    <p class="eyebrow">Matrix progress <span class="note" id="mxOverall" style="margin:0">${st.overall}</span>
      <button class="viewbtn" id="mxCancel" ?hidden=${!st.active} style="margin-left:.6rem" @click=${onCancel}>Cancel</button></p>
    <p class="note" id="mxEmpty" ?hidden=${st.entries.length > 0}>Configure platforms × models and a prompt, then Run matrix. Each entry is a one-shot agent run; screenshots land in History.</p>
    <ul class="mx-entries" id="mxEntries">${repeat(st.entries, (e) => e.index, entryItem)}</ul>
  </section>`;
}

let mountEl: HTMLElement | null = null;

function update() {
  if (!mountEl) return;
  // Per-entry log panes stick to the newest line unless the user scrolled up to read.
  const stick = new Set<number>();
  mountEl.querySelectorAll<HTMLElement>('.mx-entry').forEach((li, i) => {
    const mini = li.querySelector<HTMLElement>('.mini');
    if (mini && mini.scrollHeight - mini.scrollTop - mini.clientHeight < 40) stick.add(i);
  });
  render(tpl(), mountEl);
  mountEl.querySelectorAll<HTMLElement>('.mx-entry').forEach((li, i) => {
    const mini = li.querySelector<HTMLElement>('.mini');
    if (mini && stick.has(i)) mini.scrollTop = mini.scrollHeight;
  });
}

export function mountMatrix(el: HTMLElement) {
  mountEl = el;
  update();
  updateMxCount();
}
