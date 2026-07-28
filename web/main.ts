// Bootstrap: render the lit views into their mount sections, wire view switching,
// and on load re-attach to any active session, lock the launch if a matrix is
// mid-run, and prefill the matrix form from a server-side config file.
import { $ } from './util.ts';
import { mountWizard, checkActiveSession, applyExternalProviders } from './wizard.ts';
import { mountMatrix, updateMxCount, ensureMatrixStream, checkMatrixLock, applyExternalProvidersMatrix, applyServerMatrixConfig } from './matrix.ts';
import { mountHistory, loadHistory, startHistoryPolling, stopHistoryPolling } from './history.ts';
import { mountConfigView, renderProviderList } from './config-view.ts';
import { refreshProviders, onProvidersChange } from './providers.ts';
import { refreshPromptImages } from './prompt-images.ts';

mountConfigView($('#configView'));
mountWizard($('#wizardMain'));
mountMatrix($('#matrix'));
mountHistory($('#history'));

const VIEWS: Record<string, string> = { config: '#configView', wizard: '#wizardMain', matrix: '#matrix', history: '#history' };

function showView(view: string) {
  for (const [v, sel] of Object.entries(VIEWS)) $(sel).hidden = v !== view;
  document.querySelectorAll<any>('.tab[data-view]').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (view === 'history') {
    loadHistory();
    startHistoryPolling();
  } else {
    stopHistoryPolling();
  }
  if (view === 'matrix') { updateMxCount(); ensureMatrixStream(); }
}
document.querySelectorAll<any>('.tab[data-view]').forEach((b) =>
  b.addEventListener('click', () => showView(b.dataset.view)));

// Defer to `load` so the Ignite UI components have upgraded first.
window.addEventListener('load', async () => {
  // Any provider-pack change (load / remove) re-renders the three views that
  // depend on the pack list.
  onProvidersChange((packs) => {
    renderProviderList(packs);
    applyExternalProviders(packs);
    applyExternalProvidersMatrix(packs);
  });
  // Fetch packs once before the session/prefill checks — the matrix prefill may
  // reference an external provider's platforms.
  await refreshProviders();
  // One shared prompt-image listing feeds both setup forms' pickers.
  refreshPromptImages();

  checkActiveSession();
  checkMatrixLock();
  applyServerMatrixConfig();
});
