// Shared provider-pack state for the frontend.  Fetches the list of loaded
// external packs from /api/providers and broadcasts changes to registered callbacks.
// Imported by wizard.ts, matrix.ts, and config-view.ts.
import { getJSON } from './api.ts';

export interface ProviderPack {
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  frameworks: { id: string; label: string; [k: string]: any }[];
  configure: {
    mcpServers: { name: string; command: string; args?: string[]; class: string; label: string; description?: string }[];
    skills?: { github?: string; installCommand?: string[]; label: string };
  };
  containerDeps?: { npmGlobal?: string[] };
}

let cachedPacks: ProviderPack[] = [];
const callbacks: Array<(packs: ProviderPack[]) => void> = [];

/** Register a callback that fires whenever the pack list changes. */
export function onProvidersChange(cb: (packs: ProviderPack[]) => void): void {
  callbacks.push(cb);
}

/** Current cached packs (updated by the last refreshProviders call). */
export function getPacks(): ProviderPack[] { return cachedPacks; }

/** Fetch /api/providers, update the cache, and fire all registered callbacks. */
export async function refreshProviders(): Promise<ProviderPack[]> {
  try {
    const j = await getJSON('/api/providers');
    cachedPacks = j.providers || [];
  } catch {
    cachedPacks = [];
  }
  for (const cb of callbacks) cb(cachedPacks);
  return cachedPacks;
}
