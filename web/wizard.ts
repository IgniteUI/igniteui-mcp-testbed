// Interactive view: scaffold → configure → launch, then live stats + model switch.
// Rendered with lit-html from a single state object; ids/classes match app.css.
import { html, render, nothing, repeat, classMap } from './lit.ts';
import { $, fmt, validateMcpJson, syncTestsCombo } from './util.ts';
import { getJSON, postJSON } from './api.ts';
import { getPacks, type ProviderPack } from './providers.ts';
import { createImagePicker } from './prompt-images.ts';

const STEPS: Array<[string, string]> = [
  ['scaffold', 'Scaffold project'],
  ['configure', 'Configure AI toolchain'],
  ['translate', 'Translate MCP config'],
  ['prune', 'Prune skills'],
  ['overlay-skills', 'Overlay local skills'],
  ['attach-images', 'Attach prompt images'],
  ['launch-app', 'Start app (watch)'],
  ['launch-opencode', 'Start opencode web'],
];
const ORDER = STEPS.map(([k]) => k);

interface WizardState {
  provider: string;       // 'igniteui' or an external pack name
  framework: string;      // active IgniteUI framework (external ones live in extFramework)
  busy: boolean;          // a launch is streaming
  sessionLive: boolean;
  matrixLock: boolean;    // a matrix run owns the ports
  steps: Record<string, string>; // step -> pending | active | done | error
  logs: Array<{ msg: string; cls: string }>;
  customMcpOn: boolean;
  customMcpErr: string | null;
  overrideSkills: boolean;
  localSkillsNote: string | null;
  testsNote: string;
  showResult: boolean;
  ocUrl: string;
  appUrl: string;
  redirect: string;
  stats: any | null;
  statsLive: boolean;
  usageText: string;
}

const st: WizardState = {
  provider: 'igniteui',
  framework: 'angular',
  busy: false,
  sessionLive: false,
  matrixLock: false,
  steps: {},
  logs: [],
  customMcpOn: false,
  customMcpErr: null,
  overrideSkills: false,
  localSkillsNote: null,
  testsNote: '',
  showResult: false,
  ocUrl: '#',
  appUrl: '#',
  redirect: '',
  stats: null,
  statsLive: false,
  usageText: 'No stats yet — run the agent, then Refresh.',
};

// Per-pack selected framework id, so switching back to a pack retains the last choice.
const extFramework = new Map<string, string>();

// Reference images the session starts with. Interactive mode has no prompt box (the
// prompting happens in opencode), so these are staged into the project's
// prompt-images/ folder for the user to @-mention or drag into opencode web.
const imgPicker = createImagePicker('wiz', () => update());

// Read by the matrix view's launch-lock so it knows whether to re-enable the
// wizard's controls when a matrix finishes.
export const isSessionLive = () => st.sessionLive;

// The matrix view locks the wizard while a matrix run owns the fixed ports.
export function setMatrixLock(on: boolean) {
  st.matrixLock = on;
  update();
}

const launchDisabled = () => st.busy || st.sessionLive || st.matrixLock;

// The currently active framework id (depends on the selected provider).
const activeFramework = () =>
  st.provider === 'igniteui' ? st.framework : (extFramework.get(st.provider) || '');

const activePack = (): ProviderPack | undefined =>
  getPacks().find((p) => p.name === st.provider);

function logLine(msg: string, cls = '') {
  st.logs.push({ msg, cls });
}

function setStep(step: string, state: string) {
  st.steps[step] = state;
}

// Live-validate the pasted custom MCP JSON so a typo is caught immediately instead of
// silently being dropped deep in the pipeline (see pipeline.ts's parse warning).
function refreshCustomMcpErr(): boolean {
  st.customMcpErr = st.customMcpOn ? validateMcpJson($('#customMcp').value) : null;
  return !st.customMcpErr;
}

function collect() {
  // Collect MCPs only from the active provider's container (igc-checkbox exposes
  // `.checked` as a property, not the CSS :checked pseudo). Custom MCP is
  // provider-agnostic and collected independently.
  const ig = st.provider === 'igniteui';
  const mcpContainer = document.getElementById(ig ? 'mcpsIg' : `mcps-${st.provider}`);
  const mcps = mcpContainer
    ? [...mcpContainer.querySelectorAll<any>('[data-mcp]')].filter((c) => c.checked).map((c) => c.dataset.mcp)
    : [];
  if ($('#customMcpEnable').checked) mcps.push('custom');
  const excl = ig
    ? $('#excl').value.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  return {
    framework: activeFramework(),
    projectType: ig ? $('#ptype').value.trim() : '',
    theme: ig ? $('#theme').value.trim() : '',
    enabledMcps: mcps,
    customMcp: $('#customMcp').value.trim() || undefined,
    skills: $('#skills').checked,
    excludedSkills: excl,
    overrideSkills: $('#overrideSkills').checked,
    localSkillsOnly: $('#overrideSkills').checked && $('#localSkillsOnly').checked,
    selectedTests: ($('#testsCombo').value || []) as string[],
    promptImages: imgPicker.selected(),
    model: $('#model').value.trim(),
    apiKey: $('#key').value,
    customBaseUrl: $('#base').value.trim() || undefined,
  };
}

// "Replace generated skills" only makes sense when local skills are in use. Disable it
// (and show what's available for the selected platform under ./local-skills/<fw>) when
// the override toggle is off.
async function refreshLocalSkills() {
  if (!st.overrideSkills) { st.localSkillsNote = null; update(); return; }
  const fw = activeFramework();
  try {
    const j = await getJSON(`/api/local-skills?platform=${encodeURIComponent(fw)}`);
    const valid = (j.skills || []).filter((s: any) => s.valid).map((s: any) => s.name);
    st.localSkillsNote = valid.length
      ? `Local ${fw} skills: ${valid.join(', ')}`
      : `No skills found under ${j.dir} — add folders (each with a SKILL.md) before launching.`;
  } catch {
    st.localSkillsNote = 'Could not list local skills.';
  }
  update();
}

// Populate the tests combo, grouped by framework: the group is the active framework
// and its items are the specs that run for it — its own overlay plus the shared set.
// External provider frameworks aren't in /api/tests' per-platform map, so they get the
// shared set only (same as the matrix view). All discovered specs start selected;
// clearing the selection skips verification. Selection is preserved across framework
// switches for specs that still exist.
const testsKnownIds = new Set<string>();
let testsRefreshSeq = 0;
async function refreshTestFiles() {
  const seq = ++testsRefreshSeq;
  const combo = $('#testsCombo');
  const fw = activeFramework();
  try {
    const ig = st.provider === 'igniteui';
    const j = ig
      ? await getJSON(`/api/tests?platform=${encodeURIComponent(fw)}`)
      : await getJSON('/api/tests');
    if (seq !== testsRefreshSeq) return;
    const shared = j.shared || [];
    const overlay = ig ? (j.framework || []) : [];
    const data = [
      ...shared.map((f: string) => ({ id: `${fw}::shared/${f}`, file: f, category: fw })),
      ...overlay.map((f: string) => ({ id: `${fw}::${fw}/${f}`, file: f, category: fw })),
    ];
    const sel = syncTestsCombo(combo, data, testsKnownIds);
    combo.disabled = !data.length;
    st.testsNote = data.length
      ? `${sel.length}/${data.length} test file(s) selected — only these run during matrix verification.`
      : `No test files found under ${j.dir} — add Playwright specs to ./tests/shared/ or ./tests/${fw}/.`;
  } catch {
    if (seq !== testsRefreshSeq) return;
    st.testsNote = 'Could not list test files.';
  }
  update();
}

/** Called by main.ts whenever the provider pack list changes (pack loaded / removed). */
export function applyExternalProviders(packs: ProviderPack[]): void {
  // Seed each pack's default framework selection once.
  for (const pack of packs) {
    if (!extFramework.has(pack.name) && pack.frameworks.length > 0) {
      extFramework.set(pack.name, pack.frameworks[0].id);
    }
  }
  // If the currently selected provider was removed, revert to igniteui.
  if (st.provider !== 'igniteui' && !packs.some((p) => p.name === st.provider)) {
    st.provider = 'igniteui';
    refreshLocalSkills();
    refreshTestFiles();
  }
  update();
}

// ---------- event handlers ----------

function onProviderSelect(e: any) {
  st.provider = e.detail || st.provider;
  refreshLocalSkills();
  refreshTestFiles();
  update();
}

function onFrameworkSelect(e: any) {
  st.framework = e.detail || st.framework;
  refreshLocalSkills();
  refreshTestFiles();
  update();
}

function onExtFrameworkSelect(pack: ProviderPack, e: any) {
  extFramework.set(pack.name, e.detail || extFramework.get(pack.name) || '');
  refreshLocalSkills();
  refreshTestFiles();
  update();
}

function onCustomMcpToggle(e: any) {
  st.customMcpOn = !!e.target.checked;
  refreshCustomMcpErr();
  update();
}

function onCustomMcpInput() {
  refreshCustomMcpErr();
  update();
}

function onOverrideSkillsToggle(e: any) {
  st.overrideSkills = !!e.target.checked;
  refreshLocalSkills();
}

function onTestsComboChange() {
  const combo = $('#testsCombo');
  const total = (combo.data || []).length;
  const sel = (combo.value || []).length;
  st.testsNote = total
    ? `${sel}/${total} test file(s) selected — only these run during matrix verification.`
    : '';
  update();
}

async function onSubmit(e: Event) {
  e.preventDefault();
  if (!refreshCustomMcpErr()) { update(); $('#customMcp').scrollIntoView({ block: 'center' }); return; }
  st.busy = true;
  st.sessionLive = false;
  st.logs = [];
  st.showResult = false;
  st.steps = {};
  ORDER.forEach((s) => setStep(s, 'pending'));
  update();
  let activeIdx = -1;

  const res = await fetch('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()),
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handle(ev, () => activeIdx, (i) => { activeIdx = i; });
      update();
    }
  }
  st.busy = false;
  update();
}

function handle(ev: any, getIdx: () => number, setIdx: (i: number) => void) {
  if (ev.type === 'step') {
    // close previous active as done
    const prev = getIdx();
    if (prev >= 0) setStep(ORDER[prev], 'done');
    const i = ORDER.indexOf(ev.step);
    setIdx(i); setStep(ev.step, 'active');
  } else if (ev.type === 'log') {
    logLine(ev.msg, /^warning:/i.test(ev.msg) ? 'w' : '');
  } else if (ev.type === 'error') {
    const i = getIdx(); if (i >= 0) setStep(ORDER[i], 'error');
    logLine('ERROR: ' + ev.msg, 'e');
  } else if (ev.type === 'done') {
    const i = getIdx(); if (i >= 0) setStep(ORDER[i], 'done');
    onDone(ev);
  }
}

// Lock the launch controls and wire up live stats. Shared by a fresh launch and
// by re-attaching to an already-running session on page load.
function enterLiveState({ opencodePort, appPort, model }: { opencodePort: number; appPort: number; model?: string }) {
  st.sessionLive = true;
  $('#statusDot').classList.add('live');
  const host = location.hostname;
  st.ocUrl = `http://${host}:${opencodePort}`;
  st.appUrl = `http://${host}:${appPort}`;
  if (model) { $('#model').value = model; $('#m2').value = model; }
  st.showResult = true;
  loadUsage();
  startStatsStream();
  update();
  return st.ocUrl;
}

function onDone(ev: any) {
  const ocUrl = enterLiveState({ opencodePort: ev.opencodePort, appPort: ev.appPort, model: $('#model').value });
  const tab = window.open(ocUrl, '_blank', 'noopener');
  st.redirect = tab
    ? 'opencode opened in a new tab — this wizard stays open for live stats.'
    : 'Pop-up blocked — use the “Open opencode →” button above (opens in a new tab).';
}

// Repaint the pipeline rail + console from a server-side run snapshot.
// Returns the active step index (or -1).
function applyRunState(state: any): number {
  st.logs = [];
  (state.logs || []).forEach((m: string) => logLine(m, /^warning:/i.test(m) ? 'w' : ''));
  st.steps = {};
  ORDER.forEach((s) => setStep(s, 'pending'));
  (state.completed || []).forEach((s: string) => setStep(s, 'done'));
  let idx = -1;
  if (state.step) { idx = ORDER.indexOf(state.step); setStep(state.step, state.phase === 'error' ? 'error' : 'active'); }
  if (state.phase === 'error' && state.error) logLine('ERROR: ' + state.error, 'e');
  return idx;
}

// Follow a pipeline run that's already underway to completion.
function reattachRun(model: string) {
  st.busy = true;
  st.sessionLive = false;
  update();
  let activeIdx = -1;
  const goLive = (r: any) => enterLiveState({ opencodePort: r.opencodePort, appPort: r.appPort, model });
  const es = new EventSource('/api/run/stream');
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'state') {
      activeIdx = applyRunState(ev.state);
      if (ev.state.phase === 'done' && ev.state.result) { es.close(); st.busy = false; goLive(ev.state.result); }
      else if (ev.state.phase === 'error') { es.close(); st.busy = false; }
      update();
      return;
    }
    if (ev.type === 'done') {
      if (activeIdx >= 0) setStep(ORDER[activeIdx], 'done');
      es.close(); st.busy = false; goLive(ev);
      st.redirect = 'Session ready — opencode is running.';
      update();
      return;
    }
    handle(ev, () => activeIdx, (i) => { activeIdx = i; });
    if (ev.type === 'error') { es.close(); st.busy = false; }
    update();
  };
}

// On (re)load, re-attach to a run that's initializing or to a live session.
export async function checkActiveSession() {
  try {
    const s = await getJSON('/api/status');
    if (!s) return;
    if (s.phase === 'running') { reattachRun(s.model); return; }
    if (s.opencode) {
      enterLiveState({ opencodePort: s.opencodePort, appPort: s.appPort, model: s.model });
      st.redirect = 'Reattached to the active session.';
      update();
    }
  } catch (_) {}
}

async function loadUsage() {
  st.usageText = 'loading…';
  update();
  try {
    const j = await getJSON('/api/usage');
    st.usageText = j.ok ? (j.text.trim() || 'No usage data yet.') : `error: ${j.error}`;
  } catch (e: any) {
    st.usageText = `error: ${e.message}`;
  }
  update();
}

let statsES: EventSource | null = null;
function startStatsStream() {
  if (statsES) statsES.close();
  statsES = new EventSource('/api/stats/stream');
  statsES.onmessage = (e) => {
    try { st.stats = JSON.parse(e.data); st.statsLive = true; update(); } catch {}
  };
  statsES.onerror = () => { st.statsLive = false; update(); };
}

async function onSwapModel() {
  const j = await postJSON('/api/model', { model: $('#m2').value.trim(), apiKey: $('#k2').value });
  logLine(j.ok ? `model switched to ${j.model}` : `switch failed: ${j.error}`, j.ok ? '' : 'e');
  update();
}

// ---------- templates ----------

function statsRows() {
  const s = st.stats || {};
  const m = s.messages || {}, t = s.tokens || {}, c = s.cost || {};
  const dash = (v: any) => (st.stats ? v : '—');
  return html`
    <tr><th>Messages</th><td>${dash(`${fmt(m.total)} (${fmt(m.user)} user / ${fmt(m.assistant)} assistant)`)}</td></tr>
    <tr><th>Input tokens</th><td>${dash(fmt(t.input))}</td></tr>
    <tr><th>Output tokens</th><td>${dash(fmt(t.output))}</td></tr>
    <tr><th>Reasoning</th><td>${dash(fmt(t.reasoning))}</td></tr>
    <tr><th>Cache</th><td>${dash(fmt(t.cache))}</td></tr>
    <tr><th>Total tokens</th><td>${dash(fmt(t.total))}</td></tr>
    <tr><th>Cost</th><td>${dash(c.available ? `$${(c.amount || 0).toFixed(4)} ${c.currency || ''}`.trim() : 'n/a')}</td></tr>`;
}

const statsUpdated = () => st.stats?.updatedAt
  ? `Updated ${new Date(st.stats.updatedAt).toLocaleTimeString()} · model ${st.stats.model || '—'}`
  : 'Waiting for activity — run the agent in opencode.';

const skillsLabel = () => {
  if (st.provider === 'igniteui') return 'Install Ignite UI skills';
  return activePack()?.configure?.skills?.label || 'Install skills';
};

function tpl() {
  const ig = st.provider === 'igniteui';
  return html`
  <!-- left: flight plan -->
  <section class="panel">
    <p class="eyebrow">Session setup</p>
    <form id="form" @submit=${onSubmit}>
      <fieldset>
        <legend>Provider</legend>
        <igc-button-group id="provider" selection="single-required" .disabled=${launchDisabled()} @igcSelect=${onProviderSelect}>
          <igc-toggle-button value="igniteui" .selected=${ig}>Ignite UI</igc-toggle-button>
          ${repeat(getPacks(), (p) => p.name, (p) => html`
            <igc-toggle-button value=${p.name} .selected=${st.provider === p.name}>${p.displayName}</igc-toggle-button>`)}
        </igc-button-group>
      </fieldset>

      <fieldset>
        <legend>Framework</legend>
        <igc-button-group id="fw" selection="single-required" ?hidden=${!ig} .disabled=${launchDisabled()} @igcSelect=${onFrameworkSelect}>
          <igc-toggle-button value="angular" .selected=${st.framework === 'angular'}>Angular</igc-toggle-button>
          <igc-toggle-button value="blazor" .selected=${st.framework === 'blazor'}>Blazor</igc-toggle-button>
          <igc-toggle-button value="react" .selected=${st.framework === 'react'}>React</igc-toggle-button>
          <igc-toggle-button value="webcomponents" .selected=${st.framework === 'webcomponents'}>Web Comps</igc-toggle-button>
        </igc-button-group>
        ${repeat(getPacks(), (p) => p.name, (pack) => html`
          <igc-button-group id="fw-${pack.name}" selection="single-required" ?hidden=${st.provider !== pack.name}
            .disabled=${launchDisabled()} @igcSelect=${(e: any) => onExtFrameworkSelect(pack, e)}>
            ${pack.frameworks.map((fw) => html`
              <igc-toggle-button value=${fw.id} .selected=${(extFramework.get(pack.name) || pack.frameworks[0]?.id) === fw.id}>${fw.label}</igc-toggle-button>`)}
          </igc-button-group>`)}
        <!-- Project type + theme: only meaningful for ig new (IgniteUI) -->
        <igc-input outlined id="ptype" label="Project type (optional)" placeholder="e.g. igx-ts / sidenav" ?hidden=${!ig}></igc-input>
        <igc-input outlined id="theme" label="Theme (optional)" placeholder="e.g. default" ?hidden=${!ig}></igc-input>
      </fieldset>

      <fieldset>
        <legend>MCP servers</legend>
        <div id="mcpsIg" ?hidden=${!ig}>
          <igc-checkbox data-mcp="igniteui" checked>Ignite UI CLI MCP<small>Live component docs &amp; API lookup</small></igc-checkbox>
          <igc-checkbox data-mcp="theming" checked>Theming MCP<small>Palette / theming queries</small></igc-checkbox>
          <igc-checkbox data-mcp="angular" id="ngMcp" ?hidden=${!(ig && st.framework === 'angular')}>Angular CLI MCP<small>Registered alongside on Angular projects</small></igc-checkbox>
        </div>
        ${repeat(getPacks(), (p) => p.name, (pack) => html`
          <div id="mcps-${pack.name}" ?hidden=${st.provider !== pack.name}>
            ${pack.configure?.mcpServers?.map((s) => html`
              <igc-checkbox data-mcp=${s.class} checked>${s.label}${s.description ? html`<small>${s.description}</small>` : nothing}</igc-checkbox>`)}
          </div>`)}
        <!-- Custom MCP: provider-agnostic, available alongside any provider's servers -->
        <igc-checkbox data-mcp="custom" id="customMcpEnable" @igcChange=${onCustomMcpToggle}>Custom MCP server<small>Paste a server definition below — use alone or alongside the servers above</small></igc-checkbox>
        <igc-textarea outlined id="customMcp" class="mcp-ta" rows="4" ?hidden=${!st.customMcpOn} @igcInput=${onCustomMcpInput}
          placeholder='{"command": "npx", "args": ["-y", "my-mcp-server"]}'></igc-textarea>
        <p class="note err" id="customMcpErr" ?hidden=${!st.customMcpErr}>${st.customMcpErr || ''}</p>
        <p class="note">Paste one server def (<code>{"command","args","env"}</code> or <code>{"url","headers"}</code>), a
        named map (<code>{"my-server": {...}}</code>), or the whole contents of <code>.mcp.json</code> or a
        VS Code <code>.vscode/mcp.json</code> — pasted as-is, wrapper keys included. Only applied when checked above.</p>
      </fieldset>

      <fieldset>
        <legend>Agent skills</legend>
        <igc-checkbox id="skills" checked>${skillsLabel()}<small>Written to <code>.agents/skills/</code>, auto-loaded by opencode</small></igc-checkbox>
        <!-- Exclude: only relevant for IgniteUI (individual skill folders) -->
        <igc-input outlined id="excl" label="Exclude skills (comma-separated folder names)" placeholder="e.g. charting, theming" ?hidden=${!ig}></igc-input>
        <igc-checkbox id="overrideSkills" @igcChange=${onOverrideSkillsToggle}>Use local skills<small>Overlay your own skills from <code>./local-skills/&lt;framework&gt;/</code> onto <code>.agents/skills/</code></small></igc-checkbox>
        <igc-checkbox id="localSkillsOnly" .disabled=${!st.overrideSkills}>Replace generated skills<small>Wipe the generated set first — use only your local skills</small></igc-checkbox>
        <p class="note" id="localSkillsList" ?hidden=${!st.localSkillsNote}>${st.localSkillsNote || ''}</p>
        <details class="help">
          <summary>How local skills work</summary>
          <div class="help-body">
            <p>A “skill” is just a folder with a <code>SKILL.md</code> inside (plus any
            files it references). opencode auto-loads every folder under the project’s
            <code>.agents/skills/</code>. <strong>You can drop in <em>any</em> skill you
            want</strong> — not only Ignite UI ones: a coding-style guide, a domain
            cheat-sheet, a “always write tests” rule, anything. The agent picks them up
            automatically.</p>
            <p>Put each skill on the host under the matching framework folder
            (the selected platform is used for this run):</p>
            <ul>
              <li><code>local-skills/angular/&lt;your-skill&gt;/SKILL.md</code></li>
              <li><code>local-skills/react/…</code>, <code>local-skills/webcomponents/…</code>,
              <code>local-skills/blazor/…</code></li>
            </ul>
            <p>When you enable <strong>Use local skills</strong>:</p>
            <ul>
              <li><strong>Merge</strong> (default): your local skills are copied on top of
              the generated ones. A local folder with the <em>same name</em> as a generated
              skill <strong>replaces</strong> it; new names are simply added.</li>
              <li><strong>Replace generated skills</strong>: the generated set is wiped
              first, so the agent sees <em>only</em> your local skills.</li>
            </ul>
            <p>Folders without a <code>SKILL.md</code> are skipped. The line above lists
            what’s currently found for the selected framework.</p>
          </div>
        </details>
      </fieldset>

      <fieldset>
        <legend>Prompt images <small style="color:var(--steel);font-weight:400">(optional reference mockups)</small></legend>
        ${imgPicker.tpl()}
        <details class="help">
          <summary>How prompt images work</summary>
          <div class="help-body">
            <p>Drop design mockups, hand sketches or screenshots on the host under
            <code>./prompt-images/</code> (subfolders allowed) — or upload them right here,
            which writes them to that same folder so they persist and can be reused by a
            terminal-driven matrix config.</p>
            <p>The attached images are copied into the generated project’s
            <code>prompt-images/</code> folder by the pipeline’s <strong>attach-images</strong>
            stage. In this interactive mode there is no prompt box — you prompt inside
            opencode — so reference them there with
            <code>@prompt-images/&lt;file&gt;</code> (the run log prints the exact mentions),
            or drag the files into the opencode composer.</p>
            <p>In the <strong>Matrix</strong> tab the same images are attached to the
            one-shot prompt automatically (<code>opencode run --file …</code>), which is how
            you test “build this screen from the mockup” across platforms and variants.</p>
          </div>
        </details>
      </fieldset>

      <fieldset>
        <legend>Verification tests</legend>
        <igc-combo outlined id="testsCombo" label="Tests to run" placeholder="Select test files…"
          value-key="id" display-key="file" group-key="category" @igcChange=${onTestsComboChange}></igc-combo>
        <p class="note" id="testsNote">${st.testsNote}</p>
        <details class="help">
          <summary>How verification tests work</summary>
          <div class="help-body">
            <p>Drop <strong>Playwright</strong> specs on the host under <code>./tests/</code> —
            a <code>shared/</code> set that runs for every platform plus optional per-framework
            overlays (<code>tests/&lt;framework&gt;/</code>). They’re bind-mounted read-only at
            <code>/tests</code> and run against the built app in the pipeline’s
            <strong>verify</strong> stage.</p>
            <p>The combo groups specs by <strong>framework</strong>; the group lists every spec
            that runs for the selected framework (its own overlay plus the shared set).
            <strong>Only the selected files execute</strong> — clear the selection to skip
            verification entirely. Verification executes during <strong>matrix runs</strong>
            (each entry, once its app builds and serves); a suite with any failing test marks
            that run <code>test-failed</code> in History.</p>
          </div>
        </details>
      </fieldset>

      <fieldset class="model-fields">
        <legend>Model</legend>
        <igc-input outlined id="model" label="Model id" value="anthropic/claude-haiku-4-5"></igc-input>
        <igc-input outlined id="key" label="API key" type="password" placeholder="sk-…" autocomplete="off"></igc-input>
        <igc-input outlined id="base" label="Custom base URL (OpenAI-compatible, optional)"
                   placeholder="http://host.containers.internal:11434/v1"></igc-input>
        <p class="note">Local model? Prefix the id <code>custom/&lt;model&gt;</code> (e.g. <code>custom/llama3.1</code>),
        use <code>host.containers.internal</code> — not <code>localhost</code> — to reach the host, and put any
        non-empty API key. The server must bind <code>0.0.0.0</code>.</p>
      </fieldset>

      <igc-button type="submit" id="go" variant="contained" .disabled=${launchDisabled()}>Launch session</igc-button>
      <p class="note" id="wizBlocked" ?hidden=${!st.matrixLock}>A matrix run is in progress — launch is disabled until it finishes.</p>
    </form>
  </section>

  <!-- right: pipeline + console -->
  <section class="panel">
    <p class="eyebrow">Pipeline</p>
    <ul class="rail" id="rail">
      ${STEPS.map(([step, label], i) => html`
        <li data-step=${step} data-state=${st.steps[step] || nothing}><span class="n">${i + 1}</span> ${label}</li>`)}
    </ul>

    <p class="eyebrow">Console</p>
    <div class="console" id="log" aria-live="polite">
      ${st.logs.map((l) => html`<div class=${l.cls || ''}>${l.msg}</div>`)}
    </div>

    <div class="result ${classMap({ show: st.showResult })}" id="result">
      <igc-button id="openOc" href=${st.ocUrl} target="_blank" rel="noopener" variant="contained">Open opencode →</igc-button>
      <igc-button id="openApp" href=${st.appUrl} target="_blank" rel="noopener" variant="outlined">Open app</igc-button>
      <p class="note" id="redirect">${st.redirect}</p>

      <details class="switcher" id="usageBox" open>
        <summary>Live stats <span class="live-dot ${classMap({ on: st.statsLive })}" id="statsDot2"></span></summary>
        <table class="stats" id="statsTable"><tbody>${statsRows()}</tbody></table>
        <p class="note" id="s-updated">${statsUpdated()}</p>

        <details class="switcher">
          <summary>Raw <code>opencode stats</code> <igc-button type="button" id="refreshUsage" variant="outlined"
            @click=${(e: Event) => { e.preventDefault(); loadUsage(); }}>Refresh</igc-button></summary>
          <pre class="usage" id="usage">${st.usageText}</pre>
        </details>
      </details>

      <details class="switcher">
        <summary>Switch model</summary>
        <div class="row">
          <igc-input outlined id="m2" label="Model id"></igc-input>
          <igc-input outlined id="k2" label="API key" type="password"></igc-input>
          <igc-button type="button" id="swap" variant="contained" @click=${onSwapModel}>Apply</igc-button>
        </div>
      </details>
    </div>
  </section>`;
}

let mountEl: HTMLElement | null = null;

function update() {
  if (!mountEl) return;
  // Stick the console to the newest line unless the user has scrolled up to read.
  const log = mountEl.querySelector('.console');
  const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  render(tpl(), mountEl);
  if (nearBottom) {
    const after = mountEl.querySelector('.console');
    if (after) after.scrollTop = after.scrollHeight;
  }
}

export function mountWizard(el: HTMLElement) {
  mountEl = el;
  update();
  refreshLocalSkills();
  refreshTestFiles();
}
