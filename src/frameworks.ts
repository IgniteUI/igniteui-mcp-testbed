'use strict';

// Framework definitions live in provider packs: Ignite UI's in packs/igniteui/pack.json
// (the built-in pack), others under /providers. This module keeps the two pieces every
// pack's commands share: the fixed dev-server port and {{var}} substitution.
//
// Vars every pack gets: {{name}} (project folder name), {{dir}} (absolute project dir),
// {{port}} (APP_PORT) and {{agents}} (`generic` or `none`, the skills toggle), plus the
// provider's options and the framework's own `vars`.

export const APP_PORT = Number(process.env.APP_PORT || 5000);

// A missing var renders as the empty string, so every placeholder an argv uses must be
// set — `--agents=` with nothing after it is a hard CLI error, not a default.
export function subst(argv: string[], vars: Record<string, string | number | undefined>): string[] {
  return argv.map((a) =>
    a.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')));
}

// {{env:NAME|default}} in a framework var: the container's env value, else the default.
// SECRET_* names never resolve here (src/secrets.ts has already removed them).
export function expandEnvRefs(v: string): string {
  return v.replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\}\}/g,
    (_, name, def) => process.env[name] || def || '');
}
