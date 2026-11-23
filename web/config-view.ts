// Configuration view: load / remove provider packs (3rd-party library configs).
// Rendered with lit-html from a state object; ids/classes match app.css.
import { html, render, nothing, repeat } from './lit.ts';
import { postJSON, del } from './api.ts';
import { refreshProviders, type ProviderPack } from './providers.ts';

const st = {
  packs: [] as ProviderPack[],
  status: null as string | null,
};

/** Called by main.ts's onProvidersChange callback whenever the pack list changes. */
export function renderProviderList(packs: ProviderPack[]): void {
  st.packs = packs;
  update();
}

async function onPackFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  st.status = 'Loading…';
  update();
  try {
    const text = await file.text();
    const pack = JSON.parse(text);
    const j = await postJSON('/api/providers', pack);
    if (!j.ok) throw new Error(j.error || 'failed to load pack');
    st.status = `✓ "${j.provider.displayName}" loaded — provider is now available in the wizard and matrix.`;
    input.value = '';
    await refreshProviders(); // fires all callbacks incl. renderProviderList
  } catch (err: any) {
    st.status = `✗ ${err.message}`;
  }
  update();
}

async function removePack(pack: ProviderPack) {
  if (!confirm(`Remove the "${pack.displayName}" provider pack?\n\nThis will disable its frameworks until the pack is loaded again.`)) return;
  try {
    const j = await del(`/api/providers/${encodeURIComponent(pack.name)}`);
    if (!j.ok) { alert(j.error || 'remove failed'); return; }
    await refreshProviders();
  } catch (e: any) { alert(e.message); }
}

// containerDeps are installed when the pack loads (src/pack-deps.ts); show how that went.
const depsNote = (pack: ProviderPack) => {
  const d = pack.deps || { state: 'pending' };
  const list = (pack.containerDeps?.npmGlobal || []).join(', ');
  if (d.state === 'ok') {
    const v = Object.entries(d.versions || {}).map(([k, x]) => `${k}@${x}`).join(', ');
    return html`<p class="note" style="margin:.25rem 0 0">Container deps: ✓ ${v || list}</p>`;
  }
  if (d.state === 'failed') {
    return html`<p class="note warn" style="margin:.25rem 0 0">Container deps: ✗ install failed — ${d.error || list}.
      The next run on this pack retries the install, and fails if it fails again.</p>`;
  }
  return html`<p class="note" style="margin:.25rem 0 0">Container deps: installing ${list}…</p>`;
};

const packCard = (pack: ProviderPack) => html`
  <div class="provider-card ${pack.origin === 'builtin' ? 'builtin' : ''}">
    <div class="provider-card-head">
      <strong>${pack.displayName}</strong>
      ${pack.version ? html`<span class="note">v${pack.version}</span>` : nothing}
      ${pack.origin === 'builtin'
        ? html`<span class="pill success">built-in</span>`
        : pack.origin === 'folder'
          ? html`<span class="note" title="Folder packs are managed on the host">folder</span>`
          : html`<button class="icon-btn del-pack" title="Remove pack" @click=${() => removePack(pack)}>✕</button>`}
    </div>
    ${pack.description ? html`<p class="note" style="margin:.2rem 0 0">${pack.description}</p>` : nothing}
    <p class="note" style="margin:.25rem 0 0">
      Frameworks: ${pack.frameworks.map((f) => f.label).join(', ')} ·
      MCPs: ${pack.mcp.classes.map((c) => c.label).join(', ') || '—'}
    </p>
    ${(pack.secrets || []).length ? html`
      <p class="note" style="margin:.25rem 0 0">Secrets:
        ${pack.secrets.map((s, i) => html`${i ? ', ' : ''}<span class=${s.set ? '' : s.required ? 'warn' : ''}
          title=${`${s.description ? s.description + ' — ' : ''}${s.source}`}>${s.name}
          ${s.set ? '✓ set' : s.required ? '✗ missing' : '— not set (optional)'}</span>`)}
      </p>` : nothing}
    ${pack.containerDeps?.npmGlobal?.length ? depsNote(pack) : nothing}
  </div>`;

function tpl() {
  return html`
  <section class="panel">
    <p class="eyebrow">Provider configurations</p>
    <p class="note">Ignite UI is built-in and always available. Load a provider pack to enable an additional
    library (frameworks + MCP server + skills) in the Interactive and Matrix tabs.</p>
    <div id="providerList">
      ${repeat(st.packs, (p) => p.name, packCard)}
    </div>
    <div style="margin-top:1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
      <igc-button id="loadPackBtn" variant="outlined"
        @click=${() => (document.getElementById('packFile') as HTMLInputElement)?.click()}>Load pack (.json)…</igc-button>
      <input type="file" id="packFile" accept=".json" hidden @change=${onPackFile}>
      <span class="note" id="packLoadStatus" ?hidden=${!st.status}>${st.status || ''}</span>
    </div>
    <details class="help" style="margin-top:1.25rem">
      <summary>About provider packs</summary>
      <div class="help-body">
        <p>A provider pack is a JSON file that teaches the testbed how to scaffold a project for a specific
        library, which MCP server to wire up, and where to fetch the agent skills. Load one here, or drop pack
        files straight into the <code>providers-data/</code> folder on the host.
        <code>provider.example.angular-material.json</code> in the repository root is a complete, loadable
        example (Angular Material); <code>matrix.example.angular-material.json</code> carries the same pack
        inline in a matrix config's <code>providers</code> field for terminal-driven runs.</p>
        <p>Once a pack is loaded it is persisted to the <code>providers-data/</code> folder on the host
        (bind-mounted at <code>/providers</code>) and survives container restarts. Use the <strong>✕</strong>
        button to remove a pack.</p>
        <p><strong>Container note:</strong> if a pack lists container dependencies (npm global packages), those
        must already be installed in the running image or the scaffold will fail at the configure step.</p>
      </div>
    </details>
  </section>`;
}

let mountEl: HTMLElement | null = null;

function update() {
  if (!mountEl) return;
  render(tpl(), mountEl);
}

export function mountConfigView(el: HTMLElement) {
  mountEl = el;
  update();
}
