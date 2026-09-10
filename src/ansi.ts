'use strict';

// Terminal escape sequences, stripped in one place. Three call sites need this
// (build-error tails in proc/ports.ts, Playwright failure text in verify/tests.ts,
// and the diagnostics line framer), and they used to carry two divergent copies.
//
// The pattern covers full CSI — not just SGR colour. opencode and Vite both emit
// erase-in-line (`ESC[2K`) mid-stream, and an SGR-only strip leaves that prefix on
// the line, which is enough to defeat an anchored `^\s*Error:` match and make a
// classifier go quiet rather than loud. OSC (title-setting, hyperlinks) is stripped
// too; it is terminated by BEL or ST (ESC backslash).
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(CSI, '');
}
