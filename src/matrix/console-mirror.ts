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
  // The aggregate banner rides on entry-done and lives only in matrixState — it is not
  // written to the report and not persisted to history, so if it isn't printed here it
  // is invisible to a terminal-driven run. That is the mode where its advice ("cancel
  // and retry later") is most actionable and least likely to be watched in a browser.
  // Tracked so a standing banner prints once rather than after every entry.
  let lastBanner: string | null = null;

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
        lastBanner = null; // per-pass, exactly like the server-side counters
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
        const banner: string | null = ev.banner?.message ?? null;
        if (banner !== lastBanner) {
          // A warning that silently stops rendering is indistinguishable from one still
          // standing, so the clear is announced too — same reasoning as `resolvedAt` on
          // a stall.
          if (banner) console.log(`${HR}
⚠ ${banner}
${HR}`);
          else console.log('⚠ aggregate warning cleared — the last entry broke the streak');
          lastBanner = banner;
        }
        break;
      }
      case 'matrix-done': {
        const counts: Record<string, number> = {};
        for (const s of statuses) counts[s] = (counts[s] || 0) + 1;
        const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no entries ran';
        // `last === false` means more passes are queued: the run is NOT over, so the
        // epilogue below ("you can stop the container now") must not print — a user who
        // follows it kills the remaining passes. Undefined = single-pass caller.
        const more = ev.last === false && !ev.cancelled;
        const passOf = ev.totalPasses > 1 ? ` (pass ${ev.currentPass}/${ev.totalPasses})` : '';
        console.log(`${HR}\nmatrix ${ev.matrixId}${passOf} finished in ${fmtMin(Date.now() - startedAt)} — ${summary}${ev.cancelled ? ' (cancelled)' : ''}`);
        if (ev.report) {
          console.log('report:');
          console.log(`  host file : ./sessions/history/reports/${ev.matrixId}/report.html`);
          console.log(`  browser   : http://localhost:${WIZARD_PORT}${ev.report}  (while the container runs)`);
        }
        if (ev.summary) {
          console.log(`summary (machine-readable): ./sessions/history/reports/${ev.matrixId}/summary.json`);
        }
        console.log(`history/screenshots: http://localhost:${WIZARD_PORT} → History tab (persist in ./sessions/history/)`);
        if (more) {
          console.log(`pass ${ev.currentPass}/${ev.totalPasses} done — starting pass ${ev.currentPass + 1}…`);
          console.log(HR);
          break;
        }
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
