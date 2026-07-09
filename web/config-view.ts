// Configuration tab: load / remove provider packs (3rd-party library configs).
import { $, esc } from './util.ts';
import { postJSON, del } from './api.ts';
import { refreshProviders, type ProviderPack } from './providers.ts';

/** Initialize the Configuration tab event listeners (call once after DOM is ready). */
export function initConfigView(): void {
  const loadBtn = document.getElementById('loadPackBtn');
  const fileInput = document.getElementById('packFile') as HTMLInputElement | null;
  if (!loadBtn || !fileInput) return;

  loadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const status = document.getElementById('packLoadStatus');
    if (status) { status.hidden = false; status.textContent = 'Loading…'; }
    try {
      const text = await file.text();
      const pack = JSON.parse(text);
      const j = await postJSON('/api/providers', pack);
      if (!j.ok) throw new Error(j.error || 'failed to load pack');
      if (status) status.textContent = `✓ "${j.provider.displayName}" loaded — provider is now available in the wizard and matrix.`;
      (e.target as HTMLInputElement).value = '';
      await refreshProviders(); // triggers all callbacks incl. re-render of this tab
    } catch (err: any) {
      if (status) status.textContent = `✗ ${err.message}`;
    }
  });
}

/** Render the provider list in #providerList. Called by the onProvidersChange callback. */
export function renderProviderList(packs: ProviderPack[]): void {
  const list = document.getElementById('providerList');
  if (!list) return;
  list.innerHTML = '';

  // Built-in IgniteUI entry (always present, not removable).
  const igEl = document.createElement('div');
  igEl.className = 'provider-card builtin';
  igEl.innerHTML = `
    <div class="provider-card-head">
      <strong>Ignite UI</strong>
      <span class="pill success">built-in</span>
    </div>
    <p class="note" style="margin:.2rem 0 0">Frameworks: Angular · Blazor · React · Web Components<br>
    MCPs: Ignite UI CLI · Theming</p>`;
  list.appendChild(igEl);

  for (const pack of packs) {
    const fwLabels = pack.frameworks.map((f) => f.label).join(', ');
    const mcpLabels = (pack.configure.mcpServers || []).map((s) => s.label).join(', ');
    const el = document.createElement('div');
    el.className = 'provider-card';
    el.innerHTML = `
      <div class="provider-card-head">
        <strong>${esc(pack.displayName)}</strong>
        ${pack.version ? `<span class="note">v${esc(pack.version)}</span>` : ''}
        <button class="icon-btn del-pack" data-pack="${esc(pack.name)}" title="Remove pack">✕</button>
      </div>
      ${pack.description ? `<p class="note" style="margin:.2rem 0 0">${esc(pack.description)}</p>` : ''}
      <p class="note" style="margin:.25rem 0 0">Frameworks: ${esc(fwLabels)} · MCPs: ${esc(mcpLabels || '—')}</p>
      ${pack.containerDeps?.npmGlobal?.length
        ? `<p class="note warn" style="margin:.25rem 0 0">⚠ Container deps: <code>${esc(pack.containerDeps.npmGlobal.join(', '))}</code> — must be installed globally in the image.</p>`
        : ''}`;
    el.querySelector('.del-pack')!.addEventListener('click', () => removePack(pack.name, pack.displayName));
    list.appendChild(el);
  }
}

async function removePack(name: string, displayName: string): Promise<void> {
  if (!confirm(`Remove the "${displayName}" provider pack?\n\nThis will disable its frameworks until the pack is loaded again.`)) return;
  try {
    const j = await del(`/api/providers/${encodeURIComponent(name)}`);
    if (!j.ok) { alert(j.error || 'remove failed'); return; }
    await refreshProviders();
  } catch (e: any) { alert(e.message); }
}
