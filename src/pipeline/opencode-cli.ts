'use strict';

// The one place that knows how the 1.x and 2.x opencode CLIs differ. Evidence for every
// 2.x branch is in scripts/fixtures/opencode-probe/FINDINGS.md.

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';

let version: string | null = null;

/** e.g. `2.0.32`, or `unknown` when opencode isn't on PATH (host-side dev). */
export function opencodeVersion(): string {
  if (version == null) {
    try {
      const out = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15000 });
      version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] || 'unknown';
    } catch {
      version = 'unknown';
    }
  }
  return version;
}

export function opencodeMajor(): number {
  const forced = Number(process.env.OPENCODE_MAJOR);
  if (forced) return forced;
  return Number(opencodeVersion().split('.')[0]) || 1;
}

const isV2 = () => opencodeMajor() >= 2;

// Code Mode (2.x default) hides every MCP tool behind one `execute` tool. Off by default so
// tool usage and token counts stay comparable with 1.x runs; OPENCODE_CODEMODE=1 keeps it.
// Null on 1.x, which has no such mode.
export function codemodeEnabled(): boolean | null {
  return isV2() ? process.env.OPENCODE_CODEMODE === '1' : null;
}

// 2.x serve requires Basic auth (`opencode:<password>`) on /api/*, including the web UI's
// own calls. Fixed per container so the wizard can show it and the stats collector can use it.
export const OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD
  || crypto.randomBytes(18).toString('base64url');

// Without it a 2.x CLI call attaches to (or starts) a shared `serve --service` daemon
// that outlives the call and keeps the env of whichever call started it — so a later
// entry's XDG_DATA_HOME and provider key would be silently ignored.
const standalone = (): string[] => (isV2() ? ['--standalone'] : []);

export function agentRunArgv(prompt: string, files: string[], extra: string[] = []): string[] {
  // `--file` goes AFTER the message: on 1.x it is a yargs array option that would
  // otherwise swallow the prompt as another filename.
  return ['run', ...standalone(), ...extra, prompt, ...files.flatMap((f) => ['--file', f])];
}

export function statsArgv(): string[] {
  return ['stats', ...standalone()];
}

/** The long-lived interactive server: `opencode web` on 1.x, `opencode serve` on 2.x. */
export function serverArgv(port: number): string[] {
  return [isV2() ? 'serve' : 'web', '--hostname', '0.0.0.0', '--port', String(port)];
}

export function serverEnv(): Record<string, string> {
  return isV2() ? { OPENCODE_SERVER_PASSWORD } : {};
}

/** Password the user must enter in the opencode web UI; null when there is none (1.x). */
export function serverPassword(): string | null {
  return isV2() ? OPENCODE_SERVER_PASSWORD : null;
}

/** Authorization header for the testbed's own calls to the opencode server. */
export function serverAuthHeaders(): Record<string, string> {
  return isV2()
    ? { Authorization: 'Basic ' + Buffer.from(`opencode:${OPENCODE_SERVER_PASSWORD}`).toString('base64') }
    : {};
}
