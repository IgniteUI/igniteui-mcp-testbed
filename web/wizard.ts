// Interactive view: scaffold → configure → launch, then live stats + model switch.
import { $, fmt, validateMcpJson } from './util.ts';
import { getJSON, postJSON } from './api.ts';

let framework = 'angular';
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

// framework button group: igcSelect.detail is the selected toggle's value.
$('#fw').addEventListener('igcSelect', (e: any) => {
  framework = e.detail || framework;
  $('#ngMcp').hidden = framework !== 'angular';
  refreshLocalSkills();
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
  // igc-checkbox exposes `.checked` as a property (not the CSS :checked pseudo).
  // Scope to the interactive view so the matrix variant checkboxes aren't included.
  const mcps = [...document.querySelectorAll<any>('#wizardMain [data-mcp]')].filter((c) => c.checked).map((c) => c.dataset.mcp);
  const excl = $('#excl').value.split(',').map((s: string) => s.trim()).filter(Boolean);
  return {
    framework,
    projectType: $('#ptype').value.trim(),
    theme: $('#theme').value.trim(),
    enabledMcps: mcps,
    customMcp: $('#customMcp').value.trim() || undefined,
    skills: $('#skills').checked,
    excludedSkills: excl,
    overrideSkills: $('#overrideSkills').checked,
    localSkillsOnly: $('#overrideSkills').checked && $('#localSkillsOnly').checked,
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
  try {
    const j = await getJSON(`/api/local-skills?platform=${encodeURIComponent(framework)}`);
    const valid = (j.skills || []).filter((s: any) => s.valid).map((s: any) => s.name);
    note.textContent = valid.length
      ? `Local ${framework} skills: ${valid.join(', ')}`
      : `No skills found under ${j.dir} — add folders (each with a SKILL.md) before launching.`;
  } catch {
    note.textContent = 'Could not list local skills.';
  }
  note.hidden = false;
}
$('#overrideSkills').addEventListener('igcChange', refreshLocalSkills);
refreshLocalSkills();

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
  if (!sessionLive) { $('#go').disabled = false; $('#fw').disabled = false; }
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
