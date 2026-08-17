// Matrix view: platform × variant grid of one-shot headless runs, streamed live.
// Rendered with lit-html from a single state object; ids/classes match app.css.
import { html, render, repeat, classMap } from './lit.ts';
import { $, validateMcpJson, syncTestsCombo } from './util.ts';
import { getJSON, postJSON } from './api.ts';
import { setMatrixLock } from './wizard.ts';
import { getPacks, type ProviderPack } from './providers.ts';
import { createImagePicker, refreshPromptImages } from './prompt-images.ts';

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

const BUILTIN_PLATFORMS: Array<[string, string]> = [
  ['angular', 'Angular'],
  ['blazor', 'Blazor'],
  ['react', 'React'],
  ['webcomponents', 'Web Comps'],
];

interface VariantRow { key: number; mcps: string[]; mode: string }
interface EntryVm {
  index: number; platform: string; variantLabel: string;
  status: string; step: string; logs: string[]; open: boolean;
}
interface ExtraPass { key: number; sameAsPass1: boolean }

let variantKey = 0;
const newRow = (mcps: string[], mode: string): VariantRow => ({ key: ++variantKey, mcps, mode });
let extraPassKey = 0;
const newExtraPass = (): ExtraPass => ({ key: ++extraPassKey, sameAsPass1: true });

// Reference images attached to the shared prompt — a fixed set applied to every entry
// (they describe *what* to build; the axes are how it's built).
const imgPicker = createImagePicker('mx', () => update());

const st = {
  provider: 'igniteui', // currently selected provider name
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
  extraPasses: [] as ExtraPass[],
  currentPass: 1,
  totalPasses: 1,
};

const activePack = (): ProviderPack | undefined =>
  getPacks().find((p) => p.name === st.provider);

// The MCP classes a variant row can toggle for the active provider: the built-in
// wizard classes for Ignite UI, the pack's declared server classes otherwise;
// 'custom' (the shared custom-MCP JSON) is available everywhere.
function mcpDefsForProvider(): Array<[string, string]> {
  const defs: Array<[string, string]> = st.provider === 'igniteui'
    ? [['igniteui', 'Ignite UI CLI MCP'], ['theming', 'Theming MCP']]
    : (activePack()?.configure?.mcpServers || []).map((s): [string, string] => [s.class, s.label]);
  return [...defs, ['custom', 'Custom MCP']];
}

function defaultVariantPreset(): VariantRow {
  if (st.provider === 'igniteui') return newRow(['igniteui', 'theming'], 'default');
  const classes = (activePack()?.configure?.mcpServers || []).map((s) => s.class);
  return newRow(classes, classes.length ? 'default' : 'off');
}

const anyCustomMcp = () => st.variants.some((v) => v.mcps.includes('custom'));

// igc-checkbox exposes `.checked` as a property (not the CSS :checked pseudo).
// Read only from the active provider's platform group so hidden groups are excluded.
const platformGroupSel = () =>
  st.provider === 'igniteui' ? '#mxPlatformsIg' : `#mxPlatforms-${st.provider}`;
const mxPlatforms = () =>
  [...document.querySelectorAll<any>(`${platformGroupSel()} igc-checkbox`)].filter((c) => c.checked).map((c) => c.value);

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
  const p = mxPlatforms().length, v = mxVariants().length, r = st.extraPasses.length + 1;
  const total = p * v * r;
  st.countText = r > 1
    ? `${total} total (${p} platform${p===1?'':'s'} × ${v} variant${v===1?'':'s'} × ${r} pass${r===1?'':'es'})`
    : `${p * v} run${p * v === 1 ? '' : 's'} (${p} platform${p === 1 ? '' : 's'} × ${v} variant${v === 1 ? '' : 's'})`;
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
// is listed under each platform, so it can be toggled per framework; external provider
// platforms aren't in the per-platform map and get the shared set only). All discovered
// specs start selected; each entry runs only its own group's selected specs. Selection is
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

// ---------- provider / variant events ----------

// Provider toggle: swap the visible platform group and re-seed variant rows with the
// new provider's default MCP set (its classes differ per provider).
function applyMxProvider(p: string) {
  st.provider = p;
  st.variants = [defaultVariantPreset()];
  updateMxCount();
}

/** Called by main.ts whenever the provider pack list changes (pack loaded / removed). */
export function applyExternalProvidersMatrix(packs: ProviderPack[]): void {
  // If the currently selected provider was removed, revert to igniteui.
  if (st.provider !== 'igniteui' && !packs.some((p) => p.name === st.provider)) {
    applyMxProvider('igniteui');
    return;
  }
  update();
}

function toggleVariantMcp(row: VariantRow, mcp: string, on: boolean) {
  row.mcps = on ? [...new Set([...row.mcps, mcp])] : row.mcps.filter((m) => m !== mcp);
  updateMxCount();
}

function removeVariant(row: VariantRow) {
  st.variants = st.variants.filter((v) => v !== row);
  updateMxCount();
}

function addVariant(row?: VariantRow) {
  st.variants = [...st.variants, row ?? newRow([], 'off')];
  updateMxCount();
}

// ---------- extra runs ----------

function addExtraPass() {
  st.extraPasses = [...st.extraPasses, newExtraPass()];
  updateMxCount();
}

function removeExtraPass(key: number) {
  st.extraPasses = st.extraPasses.filter((r) => r.key !== key);
  updateMxCount();
}

function toggleExtraPassSameAs(pass: ExtraPass, checked: boolean) {
  pass.sameAsPass1 = checked;
  if (checked) {
    // Clear the uncontrolled textarea so a stale value doesn't linger.
    const ta = document.getElementById(`mxExtraPrompt-${pass.key}`) as any;
    if (ta) ta.value = '';
  }
  update();
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

const overallText = () => {
  const base = st.total ? `${st.done}/${st.total}` : '';
  return st.totalPasses > 1 ? `pass ${st.currentPass}/${st.totalPasses} · ${base}` : base;
};

function handleMx(m: any) {
  if (m.type === 'state') {
    const s = m.state || {};
    st.total = s.total || 0; st.done = s.done || 0;
    if (s.currentPass) st.currentPass = s.currentPass;
    if (s.totalPasses) st.totalPasses = s.totalPasses;
    st.overall = overallText();
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
    if (m.currentPass) st.currentPass = m.currentPass;
    if (m.totalPasses) st.totalPasses = m.totalPasses;
    st.total = m.total; st.done = 0; st.entries = []; st.overall = overallText();
    (m.entries || []).forEach((e: any) => ensureEntry(e));
    setMatrixActive(true);
    update();
    return;
  }
  if (m.type === 'entry-start') { ensureEntry(m).status = 'running'; update(); return; }
  if (m.type === 'matrix-done') {
    st.done = m.total; st.total = m.total;
    if (m.currentPass) st.currentPass = m.currentPass;
    if (m.totalPasses) st.totalPasses = m.totalPasses;
    if (m.last === false) {
      // Intermediate pass complete — more passes queued; keep stream open + button locked.
      st.overall = `pass ${st.currentPass}/${st.totalPasses} done — next starting…`;
      update();
      return;
    }
    // Final (or single-pass) completion.
    st.currentPass = 1; st.totalPasses = 1;
    st.overall = overallText();
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
  const platforms: string[] = cfg.platforms || [];

  // The form shows one provider at a time, so pick the provider that owns the
  // config's platforms: the pack owning the first external platform, else the
  // built-in Ignite UI. (main.ts awaits refreshProviders() before calling this,
  // so the pack list — and the platform groups rendered from it — are current.)
  const ownerPack = platforms
    .map((fw) => getPacks().find((p) => p.frameworks.some((f) => f.id === fw)))
    .find(Boolean);
  st.provider = ownerPack ? ownerPack.name : 'igniteui';

  // Config variants replace the provider's default seed row.
  st.variants = (cfg.variants || []).map((v: any) => newRow(v.mcps || [], skillModeOf(v)));
  if (cfg.hasApiKey) st.keyPlaceholder = 'using key from server config';
  update();

  // The platform checkboxes are uncontrolled — set .checked after the render above
  // has the right group visible. Setting .checked programmatically doesn't fire
  // igcChange; updateMxCount below does the recount the handlers would have.
  const group = [...document.querySelectorAll<any>(`${platformGroupSel()} igc-checkbox`)];
  group.forEach((c) => { c.checked = platforms.includes(c.value); });
  // A config may mix providers' platforms (the API runs them all); the form can only
  // display one provider's group — note the ones it can't show.
  const shown = new Set(group.map((c) => c.value));
  const unshown = platforms.filter((p) => !shown.has(p));

  $('#mxModel').value = cfg.model || '';
  $('#mxPrompt').value = cfg.passes?.[0]?.prompt || cfg.prompt || '';
  if (cfg.customMcp) $('#mxCustomMcp').value = cfg.customMcp;
  // Prefill extra passes from the server config.
  if (Array.isArray(cfg.passes) && cfg.passes.length > 1) {
    const pass1Prompt = cfg.passes[0]?.prompt || cfg.prompt || '';
    st.extraPasses = cfg.passes.slice(1).map((r: any) => ({
      key: ++extraPassKey, sameAsPass1: (r.prompt || '') === pass1Prompt,
    }));
    update();
    for (let i = 0; i < st.extraPasses.length; i++) {
      if (!st.extraPasses[i].sameAsPass1) {
        const ta = document.getElementById(`mxExtraPrompt-${st.extraPasses[i].key}`) as any;
        if (ta) ta.value = cfg.passes[i + 1].prompt || '';
      }
    }
  }
  updateMxCount();
  // Prompt images: the picker must know what exists before a selection can be applied
  // (selected() intersects with the loaded listing), so await the shared refresh first.
  await refreshPromptImages();
  if (Array.isArray(cfg.promptImages)) imgPicker.setSelected(cfg.promptImages);
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
  const notes: string[] = [];
  if (cfg.dropped) notes.push(`config capped — ${cfg.dropped} entr${cfg.dropped === 1 ? 'y' : 'ies'} dropped`);
  if (unshown.length) notes.push(`config also runs: ${unshown.join(', ')} (other provider — not shown in this form)`);
  if (notes.length) st.overall = notes.join(' · ');
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
  // Build the passes array: pass 1 = the main prompt; extra passes use their own or pass 1's.
  const extraPassPrompts: Array<{ prompt: string }> | null = (() => {
    const out: Array<{ prompt: string }> = [];
    for (let i = 0; i < st.extraPasses.length; i++) {
      const r = st.extraPasses[i];
      if (r.sameAsPass1) { out.push({ prompt }); continue; }
      const ta = document.getElementById(`mxExtraPrompt-${r.key}`) as any;
      const p = ta?.value?.trim() || '';
      if (!p) { alert(`Pass ${i + 2}: enter a prompt or check "Same as pass 1 prompt".`); return null; }
      out.push({ prompt: p });
    }
    return out;
  })();
  if (extraPassPrompts === null) return;
  const passes = [{ prompt }, ...extraPassPrompts];
  const body = {
    platforms, variants, model, passes,
    apiKey: $('#mxKey').value,
    customMcp: $('#mxCustomMcp').value.trim() || undefined,
    selectedTests: ($('#mxTestsCombo').value || []) as string[],
    promptImages: imgPicker.selected(),
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

const extraPassSection = () => html`
  ${st.extraPasses.length ? html`<div class="mx-passes-stack">
    ${repeat(st.extraPasses, (p) => p.key, (pass, i) => {
      const num = i + 2;
      return html`
        <div class="mx-extra-pass">
          <div class="mx-pass-head">
            <span class="mx-pass-num">Pass ${num}</span>
            <button type="button" class="rm" title="Remove pass ${num}"
              @click=${() => removeExtraPass(pass.key)}>✕</button>
          </div>
          <igc-checkbox .checked=${pass.sameAsPass1}
            @igcChange=${(e: any) => toggleExtraPassSameAs(pass, !!e.target.checked)}>
            Same as pass 1 prompt
          </igc-checkbox>
          <igc-textarea outlined id="mxExtraPrompt-${pass.key}" class="ta" rows="3"
            ?hidden=${pass.sameAsPass1}
            placeholder=${`Prompt for pass ${num}…`}></igc-textarea>
        </div>`;
    })}
  </div>` : ''}
  <button type="button" class="viewbtn" style="margin-top:.4rem"
    title="Repeat the full platform × variant matrix with a different prompt. Passes execute sequentially; each gets its own History group."
    @click=${addExtraPass}>+ Add pass</button>
  ${st.extraPasses.length ? html`<p class="note" style="margin-top:.4rem">
    Each additional pass repeats all platform × variant combos sequentially.
    All passes' entries appear in History immediately with status <em>pending</em>.
  </p>` : html`<p class="note" style="margin-top:.4rem">
    Add extra passes to repeat the matrix with different prompts. Results land in separate History groups.
  </p>`}`;

const variantRow = (row: VariantRow) => html`
  <div class="mx-variant">
    ${mcpDefsForProvider().map(([mcp, label]) => html`
      <igc-checkbox data-mcp=${mcp} .checked=${row.mcps.includes(mcp)}
        @igcChange=${(e: any) => toggleVariantMcp(row, mcp, !!e.target.checked)}>${label}</igc-checkbox>`)}
    <igc-select outlined title="Skills" class="mx-skills" .value=${row.mode}
      @igcChange=${(e: any) => { row.mode = e.detail.value; updateMxCount(); }}>
      <igc-select-item value="off">No skills</igc-select-item>
      <igc-select-item value="default">Default skills</igc-select-item>
      <igc-select-item value="local">Local skills</igc-select-item>
      <igc-select-item value="merge">Default + local</igc-select-item>
    </igc-select>
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
  const ig = st.provider === 'igniteui';
  return html`
  <!-- left: matrix setup -->
  <section class="panel">
    <p class="eyebrow">Matrix setup</p>
    <form id="mxForm" @submit=${onSubmit}>
      <fieldset>
        <legend>Provider <small style="color:var(--steel);font-weight:400">(one per matrix)</small></legend>
        <igc-button-group id="mxProvider" selection="single-required"
          @igcSelect=${(e: any) => applyMxProvider(e.detail || st.provider)}>
          <igc-toggle-button value="igniteui" .selected=${ig}>Ignite UI</igc-toggle-button>
          ${repeat(getPacks(), (p) => p.name, (p) => html`
            <igc-toggle-button value=${p.name} .selected=${st.provider === p.name}>${p.displayName}</igc-toggle-button>`)}
        </igc-button-group>
      </fieldset>

      <fieldset>
        <legend>Platforms <small style="color:var(--steel);font-weight:400">(axis)</small></legend>
        <div id="mxPlatformsIg" ?hidden=${!ig} @igcChange=${() => updateMxCount()}>
          ${BUILTIN_PLATFORMS.map(([value, label]) => html`
            <igc-checkbox value=${value} ?checked=${value === 'angular'}>${label}</igc-checkbox>`)}
        </div>
        <div id="mxExternalPlatforms">
          ${repeat(getPacks(), (p) => p.name, (pack) => html`
            <div id="mxPlatforms-${pack.name}" ?hidden=${st.provider !== pack.name} @igcChange=${() => updateMxCount()}>
              ${pack.frameworks.map((fw, i) => html`
                <igc-checkbox value=${fw.id} ?checked=${i === 0}>${fw.label}</igc-checkbox>`)}
            </div>`)}
        </div>
      </fieldset>

      <fieldset>
        <legend>Model <small style="color:var(--steel);font-weight:400">(fixed · one for all)</small></legend>
        <igc-input outlined id="mxModel" label="Model id" placeholder="anthropic/claude-sonnet-4-5"></igc-input>
      </fieldset>

      <fieldset>
        <legend>Prompt <small style="color:var(--steel);font-weight:400">(one-shot, shared)</small></legend>
        <igc-textarea outlined id="mxPrompt" class="ta" rows="4" placeholder="e.g. Build a dashboard page with a data grid and a chart."></igc-textarea>
        <p class="note" style="margin-top:.7rem">Reference images (optional) — attached to the prompt of every entry
        via <code>opencode run --file</code>, so the mockup itself is the spec. Files live in
        <code>./prompt-images/</code> on the host; uploads land there too. Needs a vision-capable
        <strong>paid</strong> model (free/keyless ones can't read images).</p>
        ${imgPicker.tpl()}
      </fieldset>

      <fieldset>
        <legend>Variants <small style="color:var(--steel);font-weight:400">(axis · MCPs + skill mode per row)</small></legend>
        <div id="mxVariants">${repeat(st.variants, (v) => v.key, variantRow)}</div>
        <button type="button" class="viewbtn" id="mxAddVariant" style="margin-top:.5rem" @click=${() => addVariant()}>+ add variant</button>
        <igc-textarea outlined id="mxCustomMcp" class="mcp-ta" rows="3" ?hidden=${!anyCustomMcp()}
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
              <li><strong>Default skills</strong> — the generated skills only.</li>
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
        <igc-input outlined id="mxKey" label="API key" type="password" placeholder=${st.keyPlaceholder} autocomplete="off"></igc-input>
        <p class="note">One key applied to every entry. Mixing providers in one matrix needs them to share a key.
        Keyless models (e.g. <code>opencode/big-pickle</code>) need no key at all.</p>
      </fieldset>

      <fieldset>
        <legend>Verification tests</legend>
        <igc-combo outlined id="mxTestsCombo" label="Tests to run" placeholder="Select test files…"
          value-key="id" display-key="file" group-key="category" @igcChange=${onTestsComboChange}></igc-combo>
        <p class="note" id="mxTestsNote">${st.testsNote}</p>
      </fieldset>

      ${extraPassSection()}
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
