// Interactive view: scaffold → configure → launch, then live stats + model switch.
import { $, esc, fmt, validateMcpJson, syncTestsCombo } from './util.ts';
import { getJSON, postJSON } from './api.ts';
import { getPacks, type ProviderPack } from './providers.ts';

let framework = 'angular';      // active IgniteUI framework
let provider = 'igniteui';      // currently selected provider (name)
// Per-pack selected framework id, so switching back to a pack retains the last choice.
const extFramework = new Map<string, string>();
let sessionLive = false;

// Read by the matrix view's launch-lock so it knows whether to re-enable the
// wizard's controls when a matrix finishes.
export const isSessionLive = () => sessionLive;

// Live-validate the pasted custom MCP JSON so a typo is caught immediately instead of
// silently being dropped deep in the pipeline (see pipeline.ts's parse warning).
function refreshCustomMcpErr(): boolean {
  if (!$('#customMcpEnable').checked) { $('#customMcpErr').hidden = true; return true; }
  const err = validateMcpJson($('#customMcp').value);
  $('#customMcpErr').textContent = err || '';
  $('#customMcpErr').hidden = !err;
  return !err;
}
$('#customMcp').addEventListener('igcInput', refreshCustomMcpErr);

// The JSON field only matters once the checkbox is on — hide it otherwise.
function syncCustomMcpEnabled() {
  const on = $('#customMcpEnable').checked;
  $('#customMcp').hidden = !on;
  refreshCustomMcpErr();
}
$('#customMcpEnable').addEventListener('igcChange', syncCustomMcpEnabled);
syncCustomMcpEnabled();

// Returns the currently active framework key (depends on selected provider).
const activeFramework = () => provider === 'igniteui' ? framework : (extFramework.get(provider) || '');

// Show/hide provider-specific sections and update visible state.
function applyProvider(p: string) {
  provider = p;
  const ig = p === 'igniteui';
  // IgniteUI-specific sections
  $('#fw').hidden = !ig;
  $('#ptype').hidden = !ig;
  $('#theme').hidden = !ig;
  $('#mcpsIg').hidden = !ig;
  $('#skillsLabelIg').hidden = !ig;
  $('#excl').hidden = !ig;
  // External provider sections (one group per pack)
  for (const pack of getPacks()) {
    const fwGroup = document.getElementById(`fw-${pack.name}`);
    const mcpGroup = document.getElementById(`mcps-${pack.name}`);
    const isThis = p === pack.name;
    if (fwGroup) fwGroup.hidden = !isThis;
    if (mcpGroup) mcpGroup.hidden = !isThis;
  }
  // Skills label — update text for external provider
  const extLabel = document.getElementById('skillsLabelExt');
  if (extLabel) {
    extLabel.hidden = ig;
    if (!ig) {
      const pack = getPacks().find((pk) => pk.name === p);
      extLabel.textContent = pack?.configure?.skills?.label || 'Install skills';
    }
  }
  // Angular CLI MCP: only shown for angular + igniteui
  $('#ngMcp').hidden = !(ig && framework === 'angular');
  refreshLocalSkills();
}

/** Called by main.ts whenever the provider pack list changes (pack loaded / removed). */
export function applyExternalProviders(packs: ProviderPack[]): void {
  // Update provider toggle buttons: remove old external buttons, add new ones.
  const providerGroup = document.getElementById('provider') as any;
  [...providerGroup.querySelectorAll('[data-external-pack]')].forEach((el: any) => el.remove());
  for (const pack of packs) {
    const btn = document.createElement('igc-toggle-button') as any;
    btn.setAttribute('value', pack.name);
    btn.setAttribute('data-external-pack', pack.name);
    btn.textContent = pack.displayName;
    providerGroup.appendChild(btn);
  }
  // Re-select the active provider button if it is still present after the rebuild.
  if (provider !== 'igniteui') {
    const activeBtn = (providerGroup as Element).querySelector<any>(`[value="${CSS.escape(provider)}"]`);
    if (activeBtn) activeBtn.selected = true;
  }

  // Render external framework button groups into #externalFwGroups.
  const fwContainer = document.getElementById('externalFwGroups')!;
  fwContainer.innerHTML = '';
  for (const pack of packs) {
    const group = document.createElement('igc-button-group') as any;
    group.id = `fw-${pack.name}`;
    group.setAttribute('selection', 'single-required');
    group.setAttribute('data-external-pack', pack.name);
    group.hidden = true;
    group.innerHTML = pack.frameworks.map((fw, i) =>
      `<igc-toggle-button value="${esc(fw.id)}"${i === 0 ? ' selected' : ''}>${esc(fw.label)}</igc-toggle-button>`,
    ).join('');
    // Seed default selection for this pack if not already set.
    if (!extFramework.has(pack.name) && pack.frameworks.length > 0) {
      extFramework.set(pack.name, pack.frameworks[0].id);
    }
    group.addEventListener('igcSelect', (e: any) => {
      extFramework.set(pack.name, e.detail || extFramework.get(pack.name) || '');
      refreshLocalSkills();
    });
    fwContainer.appendChild(group);
  }

  // Render external MCP sections into #externalMcpGroups.
  const mcpContainer = document.getElementById('externalMcpGroups')!;
  mcpContainer.innerHTML = '';
  for (const pack of packs) {
    const div = document.createElement('div');
    div.id = `mcps-${pack.name}`;
    div.setAttribute('data-external-pack', pack.name);
    div.hidden = true;
    div.innerHTML = (pack.configure?.mcpServers || []).map((s) =>
      `<igc-checkbox data-mcp="${esc(s.class)}" checked>${esc(s.label)}` +
      (s.description ? `<small>${esc(s.description)}</small>` : '') +
      `</igc-checkbox>`,
    ).join('');
    mcpContainer.appendChild(div);
  }

  // If the currently selected provider was removed, revert to igniteui.
  if (provider !== 'igniteui' && !packs.some((p) => p.name === provider)) {
    provider = 'igniteui';
    const igBtn = (providerGroup as Element).querySelector<any>('[value="igniteui"]');
    if (igBtn) igBtn.selected = true;
  }
  applyProvider(provider);
}

// Provider toggle
$('#provider').addEventListener('igcSelect', (e: any) => applyProvider(e.detail || provider));

$('#fw').addEventListener('igcSelect', (e: any) => {
  framework = e.detail || framework;
  $('#ngMcp').hidden = provider !== 'igniteui' || framework !== 'angular';
  refreshLocalSkills();
  refreshTestFiles();
});
// reflect the default selection (angular) into the Angular-MCP toggle's visibility.
$('#ngMcp').hidden = framework !== 'angular';

function setStep(step: string, state: string) {
  const li = $(`.rail li[data-step="${step}"]`);
  if (li) li.dataset.state = state;
}
function logLine(msg: string, cls?: string) {
  const el = $('#log');
  const span = document.createElement('div');
  if (cls) span.className = cls;
  span.textContent = msg;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

const ORDER = ['scaffold', 'configure', 'translate', 'prune', 'overlay-skills', 'launch-app', 'launch-opencode'];

function collect() {
  // Collect MCPs only from the currently-visible provider's container.
  const mcpContainer = provider === 'igniteui'
    ? document.getElementById('mcpsIg')
    : document.getElementById(`mcps-${provider}`);
  const mcps = mcpContainer
    ? [...mcpContainer.querySelectorAll<any>('[data-mcp]')].filter((c) => c.checked).map((c) => c.dataset.mcp)
    : [];
  // Custom MCP is provider-agnostic — collect it independently of the provider container.
  if ($('#customMcpEnable').checked) mcps.push('custom');
  const excl = provider === 'igniteui'
    ? $('#excl').value.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  return {
    framework: activeFramework(),
    projectType: provider === 'igniteui' ? $('#ptype').value.trim() : '',
    theme: provider === 'igniteui' ? $('#theme').value.trim() : '',
    enabledMcps: mcps,
    customMcp: $('#customMcp').value.trim() || undefined,
    skills: $('#skills').checked,
    excludedSkills: excl,
    overrideSkills: $('#overrideSkills').checked,
    localSkillsOnly: $('#overrideSkills').checked && $('#localSkillsOnly').checked,
    selectedTests: ($('#testsCombo').value || []) as string[],
    model: $('#model').value.trim(),
    apiKey: $('#key').value,
    customBaseUrl: $('#base').value.trim() || undefined,
  };
}

// "Replace generated skills" only makes sense when local skills are in use. Disable it
// (and show what's available for the selected platform under ./local-skills/<fw>) when
// the override toggle is off.
async function refreshLocalSkills() {
  const on = $('#overrideSkills').checked;
  $('#localSkillsOnly').disabled = !on;
  const note = $('#localSkillsList');
  if (!on) { note.hidden = true; return; }
  const fw = activeFramework();
  try {
    const j = await getJSON(`/api/local-skills?platform=${encodeURIComponent(fw)}`);
    const valid = (j.skills || []).filter((s: any) => s.valid).map((s: any) => s.name);
    note.textContent = valid.length
      ? `Local ${fw} skills: ${valid.join(', ')}`
      : `No skills found under ${j.dir} — add folders (each with a SKILL.md) before launching.`;
  } catch {
    note.textContent = 'Could not list local skills.';
  }
  note.hidden = false;
}
$('#overrideSkills').addEventListener('igcChange', refreshLocalSkills);
refreshLocalSkills();

// Populate the tests combo, grouped by framework: the group is the selected framework
// and its items are the specs that run for it — its own overlay plus the shared set
// (a shared spec appears under each framework it runs for). All discovered specs start
// selected; clearing the selection skips verification. Selection is preserved across
// framework switches for specs that still exist.
const testsKnownIds = new Set<string>();
async function refreshTestFiles() {
  const combo = $('#testsCombo');
  const note = $('#testsNote');
  try {
    const j = await getJSON(`/api/tests?platform=${encodeURIComponent(framework)}`);
    const data = [
      ...(j.shared || []).map((f: string) => ({ id: `${framework}::shared/${f}`, file: f, category: framework })),
      ...(j.framework || []).map((f: string) => ({ id: `${framework}::${framework}/${f}`, file: f, category: framework })),
    ];
    const sel = syncTestsCombo(combo, data, testsKnownIds);
    combo.disabled = !data.length;
    note.textContent = data.length
      ? `${sel.length}/${data.length} test file(s) selected — only these run during matrix verification.`
      : `No test files found under ${j.dir} — add Playwright specs to ./tests/shared/ or ./tests/${framework}/.`;
  } catch {
    note.textContent = 'Could not list test files.';
  }
}
$('#testsCombo').addEventListener('igcChange', () => {
  const combo = $('#testsCombo');
  const total = (combo.data || []).length;
  const sel = (combo.value || []).length;
  $('#testsNote').textContent = total
    ? `${sel}/${total} test file(s) selected — only these run during matrix verification.`
    : '';
});
refreshTestFiles();

$('#form').addEventListener('submit', async (e: any) => {
  e.preventDefault();
  if (!refreshCustomMcpErr()) { $('#customMcp').scrollIntoView({ block: 'center' }); return; }
  $('#go').disabled = true;
  $('#fw').disabled = true;
  sessionLive = false;
  $('#log').textContent = '';
  $('#result').classList.remove('show');
  ORDER.forEach((s) => setStep(s, 'pending'));
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
    }
  }
  if (!sessionLive) {
    $('#go').disabled = false;
    $('#fw').disabled = false;
  }
});

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
  sessionLive = true;
  $('#statusDot').classList.add('live');
  const host = location.hostname;
  const ocUrl = `http://${host}:${opencodePort}`;
  const appUrl = `http://${host}:${appPort}`;
  $('#openOc').href = ocUrl;
  $('#openApp').href = appUrl;
  if (model) { $('#model').value = model; $('#m2').value = model; }
  $('#result').classList.add('show');
  $('#go').disabled = true;
  $('#fw').disabled = true;
  loadUsage();
  startStatsStream();
  return ocUrl;
}

function onDone(ev: any) {
  const ocUrl = enterLiveState({ opencodePort: ev.opencodePort, appPort: ev.appPort, model: $('#model').value });
  const tab = window.open(ocUrl, '_blank', 'noopener');
  $('#redirect').textContent = tab
    ? 'opencode opened in a new tab — this wizard stays open for live stats.'
    : 'Pop-up blocked — use the “Open opencode →” button above (opens in a new tab).';
}

// Repaint the pipeline rail + console from a server-side run snapshot.
// Returns the active step index (or -1).
function applyRunState(st: any): number {
  $('#log').textContent = '';
  (st.logs || []).forEach((m: string) => logLine(m, /^warning:/i.test(m) ? 'w' : ''));
  ORDER.forEach((s) => setStep(s, 'pending'));
  (st.completed || []).forEach((s: string) => setStep(s, 'done'));
  let idx = -1;
  if (st.step) { idx = ORDER.indexOf(st.step); setStep(st.step, st.phase === 'error' ? 'error' : 'active'); }
  if (st.phase === 'error' && st.error) logLine('ERROR: ' + st.error, 'e');
  return idx;
}

// Follow a pipeline run that's already underway to completion.
function reattachRun(model: string) {
  $('#go').disabled = true;
  $('#fw').disabled = true;
  sessionLive = false;
  let activeIdx = -1;
  const goLive = (r: any) => enterLiveState({ opencodePort: r.opencodePort, appPort: r.appPort, model });
  const es = new EventSource('/api/run/stream');
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'state') {
      activeIdx = applyRunState(ev.state);
      if (ev.state.phase === 'done' && ev.state.result) { es.close(); goLive(ev.state.result); }
      else if (ev.state.phase === 'error') { es.close(); $('#go').disabled = false; $('#fw').disabled = false; }
      return;
    }
    if (ev.type === 'done') { if (activeIdx >= 0) setStep(ORDER[activeIdx], 'done'); es.close(); goLive(ev); $('#redirect').textContent = 'Session ready — opencode is running.'; return; }
    handle(ev, () => activeIdx, (i) => { activeIdx = i; });
    if (ev.type === 'error') { es.close(); $('#go').disabled = false; $('#fw').disabled = false; }
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
      $('#redirect').textContent = 'Reattached to the active session.';
    }
  } catch (_) {}
}

async function loadUsage() {
  const pre = $('#usage');
  pre.textContent = 'loading…';
  try {
    const j = await getJSON('/api/usage');
    pre.textContent = j.ok ? (j.text.trim() || 'No usage data yet.') : `error: ${j.error}`;
  } catch (e: any) {
    pre.textContent = `error: ${e.message}`;
  }
}
$('#refreshUsage').addEventListener('click', (e: any) => { e.preventDefault(); loadUsage(); });

let statsES: EventSource | null = null;
function startStatsStream() {
  if (statsES) statsES.close();
  statsES = new EventSource('/api/stats/stream');
  statsES.onmessage = (e) => { try { renderStats(JSON.parse(e.data)); } catch {} };
  statsES.onerror = () => { $('#statsDot2').classList.remove('on'); };
}
function renderStats(s: any) {
  if (!s) return;
  $('#statsDot2').classList.add('on');
  const m = s.messages || {}, t = s.tokens || {}, c = s.cost || {};
  $('#s-messages').textContent = `${fmt(m.total)} (${fmt(m.user)} user / ${fmt(m.assistant)} assistant)`;
  $('#s-input').textContent = fmt(t.input);
  $('#s-output').textContent = fmt(t.output);
  $('#s-reasoning').textContent = fmt(t.reasoning);
  $('#s-cache').textContent = fmt(t.cache);
  $('#s-total').textContent = fmt(t.total);
  $('#s-cost').textContent = c.available ? `$${(c.amount || 0).toFixed(4)} ${c.currency || ''}`.trim() : 'n/a';
  if (s.updatedAt) $('#s-updated').textContent = `Updated ${new Date(s.updatedAt).toLocaleTimeString()} · model ${s.model || '—'}`;
}

$('#swap').addEventListener('click', async () => {
  const j = await postJSON('/api/model', { model: $('#m2').value.trim(), apiKey: $('#k2').value });
  logLine(j.ok ? `model switched to ${j.model}` : `switch failed: ${j.error}`, j.ok ? '' : 'e');
});
