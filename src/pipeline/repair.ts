'use strict';

import { stripAnsi } from '../ansi.ts';
import type { Diagnostic, TestFailure, TestResult } from '../types.ts';

// The follow-up a developer would type after looking at a broken checkpoint. Pure, so
// the fixtures can pin its wording and caps.

export interface CheckpointOutcome {
  appReady: boolean;
  appError?: string;
  buildTail?: string;
  /** The dev server serves, but its output shows a compile error (Vite keeps the port
   * and serves an error overlay instead of failing). Set it from `overlayError`. */
  buildFailed?: boolean;
  tests: TestResult | null;
}

const MAX_TAIL_LINES = 60;
const MAX_TAIL_CHARS = 6000;
const MAX_FAILURES = 10;

const OVERLAY_ERROR_RE = /\[vite\] (Internal server error|Pre-transform error)|\[plugin:vite[:\w-]*\]|Failed to resolve import/;

export function overlayError(devServerTail: string): boolean {
  return OVERLAY_ERROR_RE.test(stripAnsi(devServerTail));
}

/** Identity of a test across checkpoints, for the `regressions` list. */
export function failureKey(f: TestFailure): string {
  return `${f.file}::${f.describe ? `${f.describe} › ` : ''}${f.title}`;
}

const brokenBuild = (cp: CheckpointOutcome) => !cp.appReady || !!cp.buildFailed;

// Only failures of the APP are worth a repair prompt. A harness error (the runner
// couldn't start or parse) or a provider failure is not something the agent can fix.
// build-error outranks the provider statuses, so the diagnostics are checked directly.
export function repairTrigger(
  status: string, cp: CheckpointOutcome, diagnostics: Diagnostic[] = [],
): 'build-error' | 'test-failed' | null {
  if (diagnostics.some((d) => d.severity === 'fatal' && !d.resolvedAt && !d.supersededAt)) return null;
  if (status === 'build-error' && !cp.appReady) return 'build-error';
  if ((status === 'test-failed' || status === 'success') && cp.appReady && cp.buildFailed) return 'build-error';
  if (status === 'test-failed' && cp.tests?.ran && cp.tests.failed > 0) return 'test-failed';
  return null;
}

export function repairPrompt(cp: CheckpointOutcome, regressions: string[]): string {
  if (brokenBuild(cp)) {
    let tail = stripAnsi(cp.buildTail || '').split('\n').slice(-MAX_TAIL_LINES).join('\n').trim();
    if (tail.length > MAX_TAIL_CHARS) tail = '…' + tail.slice(-MAX_TAIL_CHARS);
    const what = cp.appReady ? 'The app no longer compiles: the dev server shows an error overlay'
      : `The app no longer builds (${cp.appError || 'build failed'})`;
    return [
      `${what}. Fix it without removing the features that are already there.`,
      tail ? `Dev server output:\n\`\`\`\n${tail}\n\`\`\`` : '',
    ].filter(Boolean).join('\n\n');
  }
  const regressed = new Set(regressions);
  const failures = [...(cp.tests?.failures || [])]
    .sort((a, b) => Number(regressed.has(failureKey(b))) - Number(regressed.has(failureKey(a))));
  const lines = failures.slice(0, MAX_FAILURES).map((f) => {
    const name = f.describe ? `${f.describe} › ${f.title}` : f.title;
    const was = regressed.has(failureKey(f)) ? ' — this worked before your last change' : '';
    const detail = stripAnsi(f.error || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    return [`- ${name}${was}`, ...(detail.length ? detail : ['failed']).map((l) => `    ${l}`)].join('\n');
  });
  if (failures.length > MAX_FAILURES) lines.push(`- …and ${failures.length - MAX_FAILURES} more`);
  return [
    'The app builds, but these checks against the running app fail:',
    lines.join('\n'),
    'Fix the app so they pass. The checks run outside this project — change the app, not tests.',
  ].join('\n\n');
}
