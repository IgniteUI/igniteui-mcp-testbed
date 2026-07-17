// Bootstrap: wire view switching and, on load, re-attach to any active session
// and lock the launch if a matrix is mid-run. Importing the view modules runs
// their top-level listener registrations.
import { $ } from './util.ts';
import { checkActiveSession, applyExternalProviders } from './wizard.ts';
import { updateMxCount, ensureMatrixStream, checkMatrixLock, applyExternalProvidersMatrix, applyServerMatrixConfig } from './matrix.ts';
import { loadHistory, startHistoryPolling, stopHistoryPolling } from './history.ts';
import { initConfigView, renderProviderList } from './config-view.ts';
import { refreshProviders, onProvidersChange } from './providers.ts';

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
  // Wire Configuration tab (file upload button etc.)
  initConfigView();

  // Register callbacks so any provider change immediately re-renders all three
  // views that depend on the provider list.
  onProvidersChange((packs) => {
    renderProviderList(packs);
    applyExternalProviders(packs);
    applyExternalProvidersMatrix(packs);
  });

  // Fetch providers once on startup.
  await refreshProviders();

  checkActiveSession();
  checkMatrixLock();
  applyServerMatrixConfig();
});
