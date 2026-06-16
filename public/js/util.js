// Shared DOM + formatting helpers used across the three views.

export const $ = (s) => document.querySelector(s);

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const fmt = (n) => (n || 0).toLocaleString();

// Format an ISO timestamp as DD/Mon/YYYY HH:MM:SS in the user's local timezone
// (24h clock, day-first).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
