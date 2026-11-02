// Shared provider state for the frontend. Fetches every provider from /api/providers
// (the built-in Ignite UI first, then the loaded packs) and broadcasts changes to
// registered callbacks.
// Imported by wizard.ts, matrix.ts, and config-view.ts.
import { getJSON } from './api.ts';

export interface ProviderPack {
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  schemaVersion: 2;
  frameworks: { id: string; label: string; [k: string]: any }[];
  // Class ids arrive qualified as `<pack>/<class>`.
  options?: { id: string; label: string; description?: string; placeholder?: string; choices?: string[]; default?: string }[];
  mcp: {
    classes: { id: string; label: string; description?: string; default?: boolean; frameworks?: string[] }[];
    servers: { name: string; class: string; command: string; args?: string[] }[];
  };
  skills?: { label: string; sources: { github?: string; command?: string[] }[] };
  containerDeps?: { npmGlobal?: string[] };
  // 'builtin' = Ignite UI, always first in the list and never removable.
  origin: 'file' | 'folder' | 'inline' | 'builtin';
  // Status only; values never leave the server.
  secrets: { name: string; kind: 'env' | 'file'; required: boolean; description?: string; set: boolean; source: string }[];
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

/** The provider that owns a framework id. */
export function packForFramework(fw: string): ProviderPack | undefined {
  return cachedPacks.find((p) => p.frameworks.some((f) => f.id === fw));
}

/** A provider's MCP classes that apply to one of its frameworks. */
export function classesFor(pack: ProviderPack | undefined, fw?: string) {
  return (pack?.mcp.classes || []).filter((c) => !c.frameworks || !fw || c.frameworks.includes(fw));
}
