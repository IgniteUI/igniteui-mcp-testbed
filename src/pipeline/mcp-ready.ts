'use strict';

import { serverAuthHeaders } from './opencode-cli.ts';
import { sleep } from '../proc/fsutil.ts';
import type { Emit } from '../types.ts';

// 2.x prompts before MCP servers connect, and the agent then assumes it has no tools.
// Timeout warns and proceeds; cancel rejects.
export async function waitForMcp(
  port: number,
  directory: string,
  servers: string[],
  timeoutMs: number,
  emit: Emit,
  isCancelled?: (() => boolean) | null,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/mcp?location[directory]=${encodeURIComponent(directory)}`;
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  const pending = new Set(servers);
  let loggedStatus = false;
  while (pending.size) {
    if (isCancelled && isCancelled()) throw new Error('cancelled while waiting for MCP servers');
    try {
      const res = await fetch(url, { headers: serverAuthHeaders(), signal: AbortSignal.timeout(5000) });
      // Password mismatch won't recover; don't blame the servers.
      if (res.status === 401 || res.status === 403) {
        emit('log', `warning: GET /api/mcp returned HTTP ${res.status} (server password mismatch?); prompting without waiting for MCP`);
        return;
      }
      if (!res.ok && !loggedStatus) {
        loggedStatus = true;
        emit('log', `warning: GET /api/mcp returned HTTP ${res.status}; MCP readiness can't be checked yet`);
      }
      const body: any = res.ok ? await res.json() : null;
      for (const s of body?.data || []) {
        if (!pending.has(s?.name)) continue;
        const status = s.status?.status;
        if (status === 'connected') {
          pending.delete(s.name);
          emit('log', `mcp "${s.name}" connected after ${secs()}s`);
        } else if (status && status !== 'pending') {
          pending.delete(s.name);
          emit('log', `warning: mcp "${s.name}" is ${status}${s.status.error ? ` (${s.status.error})` : ''}; its tools won't be available to the agent`);
        }
      }
    } catch (_) {}
    if (!pending.size) return;
    if (Date.now() - started > timeoutMs) {
      emit('log', `warning: mcp ${[...pending].map((n) => `"${n}"`).join(', ')} not connected after ${secs()}s; prompting anyway`);
      return;
    }
    await sleep(500);
  }
}
