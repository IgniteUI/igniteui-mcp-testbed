'use strict';

import { WIZARD_PORT } from '../config.ts';
import { tap } from './matrix.ts';
import type { MatrixEntry } from '../types.ts';

// Mirror matrix progress events to stdout for terminal-driven runs (--matrix-config /
// MATRIX_CONSOLE=1). The events are the same ones the UI consumes over SSE; without
// this a foreground `podman run` prints nothing between "auto-run started" and exit.

const HR = '─'.repeat(64);

// Returns the registered handler (also fed every event) so it can be driven directly.
export function attachConsoleMirror({ exitOnDone = false }: { exitOnDone?: boolean } = {}): (ev: any) => void {
  let total = 0;
  let startedAt = 0;
  const labels = new Map<number, string>();
  const statuses: string[] = [];

  const prefix = (index: number | undefined): string =>
    index == null ? '' : `[${index + 1}/${total}${labels.has(index) ? ` ${labels.get(index)}` : ''}] `;

  const fmtMin = (ms: number): string => {
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`;
  };

  const handler = (ev: any): void => {
    switch (ev.type) {
      case 'matrix-start': {
        total = ev.total;
        startedAt = Date.now();
        statuses.length = 0;
        console.log(`${HR}\nmatrix ${ev.matrixId}${ev.name ? ` "${ev.name}"` : ''}: ${total} entries`);
        for (const e of (ev.entries || []) as MatrixEntry[]) {
          labels.set(e.index, `${e.platform} · ${e.variantLabel}`);
          console.log(`  ${e.index + 1}. ${e.platform} · ${e.variantLabel}`);
        }
        console.log(HR);
        break;
      }
      case 'entry-start':
        labels.set(ev.index, `${ev.platform} · ${ev.variantLabel}`);
        console.log(`${prefix(ev.index)}▶ starting`);
        break;
      case 'step':
        console.log(`${prefix(ev.index)}— ${ev.step} —`);
        break;
      case 'log':
        console.log(`${prefix(ev.index)}${ev.msg}`);
        break;
      case 'error':
        console.error(`${prefix(ev.index)}ERROR: ${ev.msg}`);
        break;
      case 'entry-done': {
        statuses.push(ev.status);
        const mark = ev.status === 'success' ? '✔' : '✖';
        const extra = [
          ev.tests?.ran ? `${ev.tests.passed}/${ev.tests.total} tests` : '',
          ev.screenshots?.length ? `${ev.screenshots.filter((s: any) => s.ok).length} screenshot(s)` : '',
          ev.error || '',
        ].filter(Boolean).join(' · ');
        console.log(`${prefix(ev.index)}${mark} ${ev.status}${extra ? ` — ${extra}` : ''}`);
        break;
      }
      case 'matrix-done': {
        const counts: Record<string, number> = {};
        for (const s of statuses) counts[s] = (counts[s] || 0) + 1;
        const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no entries ran';
        console.log(`${HR}\nmatrix ${ev.matrixId} finished in ${fmtMin(Date.now() - startedAt)} — ${summary}${ev.cancelled ? ' (cancelled)' : ''}`);
        if (ev.report) {
          console.log('report:');
          console.log(`  host file : ./sessions/history/reports/${ev.matrixId}/report.html`);
          console.log(`  browser   : http://localhost:${WIZARD_PORT}${ev.report}  (while the container runs)`);
        }
        if (ev.summary) {
          console.log(`summary (machine-readable): ./sessions/history/reports/${ev.matrixId}/summary.json`);
        }
        console.log(`history/screenshots: http://localhost:${WIZARD_PORT} → History tab (persist in ./sessions/history/)`);
        if (exitOnDone) {
          console.log('exitOnDone is set — the container will now stop by itself.');
        } else {
          console.log('All done — you can stop the container now (Ctrl-C, ./stop.sh, or .\\stop.ps1).');
        }
        console.log(HR);
        break;
      }
    }
  };
  tap(handler);
  return handler;
}
