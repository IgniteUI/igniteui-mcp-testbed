// Shared DOM + formatting helpers used across the three views.

// querySelector wrapper. Returns `any`: most call sites touch Ignite UI custom
// elements (igc-*) whose properties (.checked/.value/...) aren't in the DOM lib.
export const $ = (s: string): any => document.querySelector(s);

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s: any): string =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ENTITIES[c]);

export const fmt = (n: number): string => (n || 0).toLocaleString();

// Format an ISO timestamp as DD/Mon/YYYY HH:MM:SS in the user's local timezone
// (24h clock, day-first).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(ms: number | null): string {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// Validate a pasted custom-MCP JSON blob. Returns an error message, or null when the
// text is empty (nothing to validate) or valid JSON. Mirrors the shapes the backend
// accepts (pipeline.ts) — this only checks it *parses*, not the server-def shape,
// so it can't false-positive on a shape the backend still knows how to unwrap.
export function validateMcpJson(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    JSON.parse(t);
    return null;
  } catch (e: any) {
    return `Invalid JSON: ${e.message}`;
  }
}

export interface TestComboItem { id: string; file: string; category: string }

// Populate a grouped multi-select igc-combo with test files, preserving the user's
// selection across refreshes: an id seen for the first time defaults to selected, and
// an id the user explicitly deselected stays off. `known` tracks previously-seen ids
// (mutated in place) so a newly-added platform's specs come in pre-selected without
// resurrecting ones the user cleared. Returns the applied selection.
export function syncTestsCombo(combo: any, data: TestComboItem[], known: Set<string>): string[] {
  const prevSel = new Set<string>((combo.value || []) as string[]);
  const value = data.filter((d) => !known.has(d.id) || prevSel.has(d.id)).map((d) => d.id);
  combo.valueKey = 'id';
  combo.displayKey = 'file';
  combo.groupKey = 'category';
  combo.data = data;
  combo.value = value;
  for (const d of data) known.add(d.id);
  return value;
}


