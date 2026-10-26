'use strict';

import { serverAuthHeaders } from './opencode-cli.ts';
import { sleep } from '../proc/fsutil.ts';
import type { Emit } from '../types.ts';

// 2.x `opencode run` sends the prompt before its MCP servers have connected (`ig mcp` takes
// ~8s), and an agent that looks for its tools in that window concludes they don't exist.
// Poll the server's `GET /api/mcp` (pending → connected | failed | needs_auth) until every
// enabled server has settled. A timeout only warns: the run goes ahead either way.
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
  while (pending.size) {
    if (isCancelled && isCancelled()) return;
    try {
      const res = await fetch(url, { headers: serverAuthHeaders(), signal: AbortSignal.timeout(5000) });
      // The first answers can be an empty list, before the location's config has loaded.
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
