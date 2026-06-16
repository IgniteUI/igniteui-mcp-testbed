'use strict';

// Known MCP classes a matrix variant may toggle (angular-cli is intentionally not
// here — it's never enabled). Used to sanitize incoming variant definitions.
const MATRIX_MCP_CLASSES = ['igniteui', 'theming'];

// Short, human label for a variant: which MCPs + skills on/off.
function variantLabel(v) {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `${mcps} · ${v.skills ? 'skills' : 'no-skills'}`;
}

// Filesystem-safe, self-describing dir name for a matrix entry so the per-entry
// app/data dirs are findable at a glance (e.g. entry-0-angular-igniteui+theming-skills).
function entryDirName(i, platform, v) {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `entry-${i}-${platform}-${mcps}-${v.skills ? 'skills' : 'noskills'}`;
}

// Normalize + dedupe the variant rows from the request.
function parseVariants(raw) {
  const seen = new Set();
  const out = [];
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

function newMatrixId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `mx-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

module.exports = { MATRIX_MCP_CLASSES, variantLabel, entryDirName, parseVariants, newMatrixId };
