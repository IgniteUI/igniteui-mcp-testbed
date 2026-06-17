'use strict';

import type { Variant } from '../types.ts';

// Known MCP classes a matrix variant may toggle (angular-cli is intentionally not
// here — it's never enabled). Used to sanitize incoming variant definitions.
export const MATRIX_MCP_CLASSES = ['igniteui', 'theming'];

// Short, human label for a variant: which MCPs + skills on/off.
export function variantLabel(v: Variant): string {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `${mcps} · ${v.skills ? 'skills' : 'no-skills'}`;
}

// Filesystem-safe, self-describing dir name for a matrix entry so the per-entry
// app/data dirs are findable at a glance (e.g. entry-0-angular-igniteui+theming-skills).
export function entryDirName(i: number, platform: string, v: Variant): string {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `entry-${i}-${platform}-${mcps}-${v.skills ? 'skills' : 'noskills'}`;
}

// Normalize + dedupe the variant rows from the request.
export function parseVariants(raw: any): Variant[] {
  const seen = new Set<string>();
  const out: Variant[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const mcps = MATRIX_MCP_CLASSES.filter((c) => Array.isArray(v && v.mcps) && v.mcps.includes(c));
    const skills = !!(v && v.skills);
    const key = mcps.join(',') + '|' + skills;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mcps, skills });
  }
  return out;
}

export function newMatrixId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `mx-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}
