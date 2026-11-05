'use strict';

import type { Variant } from '../types.ts';
import { bareMcpClass } from '../mcp-class.ts';

// The four skill modes a variant can express, from {skills, localSkills}:
//   skills  local  → mode
//     ✗      ✗     → no-skills
//     ✓      ✗     → skills           (generated only)
//     ✗      ✓     → local-skills     (local only — generated wiped)
//     ✓      ✓     → skills+local     (generated + local overlaid)
function skillMode(v: Variant): string {
  if (v.localSkills) return v.skills ? 'skills+local' : 'local-skills';
  return v.skills ? 'skills' : 'no-skills';
}
// Compact, filesystem-safe form of the same (for entry dir names).
function skillSlug(v: Variant): string {
  if (v.localSkills) return v.skills ? 'skills+local' : 'localonly';
  return v.skills ? 'skills' : 'noskills';
}

// Short, human label for a variant: which MCPs + skill mode.
export function variantLabel(v: Variant): string {
  // A matrix entry is one provider, so the pack prefix of `<pack>/<class>` adds nothing.
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.map(bareMcpClass).join('+') : 'none';
  return `${mcps} · ${skillMode(v)}`;
}

// Filesystem-safe, self-describing dir name for a matrix entry so the per-entry
// app/data dirs are findable at a glance (e.g. entry-0-angular-igniteui+theming-skills).
export function entryDirName(i: number, platform: string, v: Variant): string {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.map(bareMcpClass).join('+') : 'none';
  return `entry-${i}-${platform}-${mcps}-${skillSlug(v)}`;
}

// Normalize + dedupe the variant rows from the request.
// Accepts any non-empty string as an MCP class so external provider classes
// flow through without a whitelist check.
export function parseVariants(raw: any): Variant[] {
  const seen = new Set<string>();
  const out: Variant[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    // A safe id, optionally pack-qualified (`<pack>/<class>`), lowercased so
    // mixed-case variants deduplicate correctly.
    const mcps = Array.isArray(v?.mcps)
      ? v.mcps
          .filter((c: any) => typeof c === 'string' && /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)?$/.test(c))
          .map((c: string) => c.toLowerCase())
      : [];
    const skills = !!(v && v.skills);
    const localSkills = !!(v && v.localSkills);
    const key = mcps.join(',') + '|' + skills + '|' + localSkills;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mcps, skills, localSkills });
  }
  return out;
}

export function newMatrixId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `mx-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}
