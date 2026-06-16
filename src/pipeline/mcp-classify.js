'use strict';

// The user toggles MCPs by class (igniteui / theming / angular). Classify each
// discovered server by name+command with explicit precedence so the generic
// "ignite" match can't swallow the theming server. Only classes the caller
// explicitly selected are enabled — everything else (incl. angular-cli and any
// unclassified "other" server) stays off, so a variant with no MCPs is a true
// clean baseline.
function classify(name, s) {
  const hay = (name + ' ' + [s.command, ...(s.args || [])].join(' ')).toLowerCase();
  if (hay.includes('theming')) return 'theming';
  if (hay.includes('angular')) return 'angular';
  if (hay.includes('ignite')) return 'igniteui';
  return 'other';
}

module.exports = { classify };
