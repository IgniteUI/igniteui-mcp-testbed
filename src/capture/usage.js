'use strict';

// Parse the human-readable `opencode stats` report into the structured shape the
// history record stores. The exact output format is opencode-version-dependent, so
// this is deliberately defensive line-matching: it pulls labeled numbers wherever it
// can and reports `parsed:false` (caller logs a warning) if nothing recognizable was
// found, rather than throwing. Adjust the label regexes if the report layout changes.

// First number on a line: handles "1,234", "$0.0123", "1.2k", "3M".
function firstNumber(line) {
  const m = line.match(/\$?\s*([\d][\d,]*\.?\d*)\s*([kKmM])?/);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return null;
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k') n *= 1e3;
  else if (suffix === 'm') n *= 1e6;
  return n;
}

function parseOpencodeStats(text) {
  const out = {
    tokens: { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 },
    cost: { amount: 0, currency: 'USD', available: false },
    messages: { total: 0 },
    parsed: false,
  };
  let matched = false;

  for (const line of String(text || '').split(/\r?\n/)) {
    const low = line.toLowerCase();
    const n = firstNumber(line);
    if (n == null) continue;

    if (/cost|\$/.test(low) && !/token/.test(low)) {
      out.cost.amount = n; out.cost.available = true; matched = true;
    } else if (/\binput\b/.test(low)) {
      out.tokens.input = n; matched = true;
    } else if (/\boutput\b/.test(low)) {
      out.tokens.output = n; matched = true;
    } else if (/reason/.test(low)) {
      out.tokens.reasoning = n; matched = true;
    } else if (/cache/.test(low)) {
      out.tokens.cache = n; matched = true;
    } else if (/total/.test(low) && /token/.test(low)) {
      out.tokens.total = n; matched = true;
    } else if (/message/.test(low)) {
      out.messages.total = n; matched = true;
    }
  }

  const t = out.tokens;
  if (!t.total) t.total = t.input + t.output + t.reasoning + t.cache;
  out.parsed = matched;
  return out;
}

module.exports = { parseOpencodeStats, firstNumber };
