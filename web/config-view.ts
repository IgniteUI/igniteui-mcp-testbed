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

const packCard = (pack: ProviderPack) => html`
  <div class="provider-card">
    <div class="provider-card-head">
      <strong>${pack.displayName}</strong>
      ${pack.version ? html`<span class="note">v${pack.version}</span>` : nothing}
      <button class="icon-btn del-pack" title="Remove pack" @click=${() => removePack(pack)}>✕</button>
    </div>
    ${pack.description ? html`<p class="note" style="margin:.2rem 0 0">${pack.description}</p>` : nothing}
    <p class="note" style="margin:.25rem 0 0">
      Frameworks: ${pack.frameworks.map((f) => f.label).join(', ')} ·
      MCPs: ${(pack.configure.mcpServers || []).map((s) => s.label).join(', ') || '—'}
    </p>
    ${pack.containerDeps?.npmGlobal?.length ? html`
      <p class="note warn" style="margin:.25rem 0 0">
        ⚠ <strong>Container rebuild required.</strong> This pack needs global npm packages that must be baked into the image.<br>
        1. Open <code>Containerfile</code> and find the <em>3rd-party provider dependencies</em> section.<br>
        2. Uncomment the <code>RUN</code> line and replace the placeholder with:<br>
        &nbsp;&nbsp;&nbsp;<code>npm install -g ${pack.containerDeps.npmGlobal.join(' ')}</code><br>
        3. Rebuild: <code>.\\run.ps1 build</code> (Windows) · <code>./run.sh build</code> (Linux/macOS)
      </p>` : nothing}
  </div>`;

function tpl() {
  return html`
  <section class="panel">
    <p class="eyebrow">Provider configurations</p>
    <p class="note">Ignite UI is built-in and always available. Load a provider pack to enable an additional
    library (frameworks + MCP server + skills) in the Interactive and Matrix tabs.</p>
    <div id="providerList">
      <div class="provider-card builtin">
        <div class="provider-card-head">
          <strong>Ignite UI</strong>
          <span class="pill success">built-in</span>
        </div>
        <p class="note" style="margin:.2rem 0 0">Frameworks: Angular · Blazor · React · Web Components<br>
        MCPs: Ignite UI CLI · Theming</p>
      </div>
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
