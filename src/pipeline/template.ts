'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Emit } from '../types.ts';

// Only the run's own vars are replaced. Templates are app source, which is full of
// `{{title}}`-style bindings (Angular, Handlebars, Razor), so unknown names are left
// exactly as written rather than blanked the way subst() does for argv.
export function fillVars(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

// A NUL in the first 8 KB is the usual binary heuristic; binaries are copied as-is.
const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

/** Copy a pack's template folder into `dest`, filling {{vars}} in text files and in
 * file/folder names. Symlinks are skipped: they could point anywhere on the host mount. */
export function copyTemplate(src: string, dest: string, vars: Record<string, string | number>, emit: Emit): number {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`template folder not found: ${src}`);
  let files = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const name = fillVars(e.name, vars);
      // A var value must not turn a name into a path.
      if (name.includes('/') || name.includes('\\') || name === '..') throw new Error(`template name "${e.name}" expands to "${name}"`);
      const s = path.join(from, e.name);
      const d = path.join(to, name);
      if (e.isSymbolicLink()) { emit('log', `warning: template symlink skipped: ${path.relative(src, s)}`); continue; }
      if (e.isDirectory()) { walk(s, d); continue; }
      if (!e.isFile()) continue;
      const buf = fs.readFileSync(s);
      fs.writeFileSync(d, isBinary(buf) ? buf : fillVars(buf.toString('utf8'), vars));
      files++;
    }
  };
  walk(src, dest);
  return files;
}
