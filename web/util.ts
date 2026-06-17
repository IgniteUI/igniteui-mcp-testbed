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
