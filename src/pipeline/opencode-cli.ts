'use strict';

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';

let version: string | null = null;

export function opencodeVersion(): string {
  if (version == null) {
    version = 'unknown';
    for (let attempt = 0; attempt < 3 && version === 'unknown'; attempt++) {
      try {
        const out = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 15000 });
        version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] || 'unknown';
      } catch (e: any) {
        if (e?.code === 'ENOENT') break;
      }
    }
  }
  return version;
}

// Unknown means 2.x, the image default.
export function opencodeMajor(): number {
  const forced = Number(process.env.OPENCODE_MAJOR);
  if (forced) return forced;
  return Number(opencodeVersion().split('.')[0]) || 2;
}

export const isV2 = () => opencodeMajor() >= 2;

// Off by default so tool usage and tokens stay comparable with 1.x; null on 1.x.
export function codemodeEnabled(): boolean | null {
  return isV2() ? process.env.OPENCODE_CODEMODE === '1' : null;
}

export const OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD
  || crypto.randomBytes(18).toString('base64url');

// Without it 2.x shares one daemon across calls, keeping the first call's data dir and key.
const standalone = (): string[] => (isV2() ? ['--standalone'] : []);

export function agentRunArgv(prompt: string, files: string[], extra: string[] = [], server: string | null = null): string[] {
  // `--file` after the message, or the array option swallows the prompt.
  const target = server ? ['--server', server] : standalone();
  return ['run', ...target, ...extra, prompt, ...files.flatMap((f) => ['--file', f])];
}

export function statsArgv(): string[] {
  return ['stats', ...standalone()];
}

export function serverArgv(port: number, hostname = '0.0.0.0'): string[] {
  return [isV2() ? 'serve' : 'web', '--hostname', hostname, '--port', String(port)];
}

export function serverEnv(): Record<string, string> {
  return isV2() ? { OPENCODE_SERVER_PASSWORD } : {};
}

export function serverPassword(): string | null {
  return isV2() ? OPENCODE_SERVER_PASSWORD : null;
}

export function serverAuthHeaders(): Record<string, string> {
  return isV2()
    ? { Authorization: 'Basic ' + Buffer.from(`opencode:${OPENCODE_SERVER_PASSWORD}`).toString('base64') }
    : {};
}
