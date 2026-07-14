// Bootstrap: wire view switching and, on load, re-attach to any active session
// and lock the launch if a matrix is mid-run. Importing the view modules runs
// their top-level listener registrations.
import { $ } from './util.ts';
import { checkActiveSession } from './wizard.ts';
import { updateMxCount, ensureMatrixStream, checkMatrixLock, applyServerMatrixConfig } from './matrix.ts';
import { loadHistory, startHistoryPolling, stopHistoryPolling } from './history.ts';

const VIEWS: Record<string, string> = { wizard: '#wizardMain', matrix: '#matrix', history: '#history' };

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
window.addEventListener('load', () => {
  checkActiveSession();
  checkMatrixLock();
  applyServerMatrixConfig();
});
