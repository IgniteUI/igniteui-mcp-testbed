'use strict';

const fs = require('fs');
const path = require('path');

// Directories that never hold app route source (and are huge), skipped while walking.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'bin', 'obj', '.git', '.angular', '.vite', 'wwwroot',
]);

function walk(dir, test, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), test, out);
    } else if (test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// Decide whether a raw route string is screenshot-able, and normalize it.
// Returns { keep } or { skip: reason }.
function classify(raw) {
  let p = String(raw).trim();
  if (p === '') return { skip: 'empty/redirect' };
  if (p === '**' || p === '*' || p === '(.*)' || p.includes('*')) return { skip: 'wildcard' };
  // parameterized routes can't be visited without concrete values
  if (p.includes('{') || /\/:/.test(p) || p.includes('(')) return { skip: 'parameterized' };
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return { keep: p };
}

function collect(rawPaths) {
  const routes = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of rawPaths) {
    const c = classify(raw);
    if (c.skip) { skipped.push({ path: raw, reason: c.skip }); continue; }
    if (seen.has(c.keep)) continue;
    seen.add(c.keep);
    routes.push(c.keep);
  }
  routes.sort();
  return { routes, skipped };
}

// Blazor: every `@page "..."` directive across .razor files is a route.
function fromRazor(appDir) {
  const files = walk(appDir, (n) => n.endsWith('.razor'), []);
  const raw = [];
  const re = /@page\s+"([^"]+)"/g;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let m;
    while ((m = re.exec(text))) raw.push(m[1]);
  }
  const res = collect(raw);
  res.sources = files;
  return res;
}

// Angular / React / WebComponents declare routes in config files (a `Routes` array,
// a `routes` const, or a Vaadin `Route[]`). They all use `path: '<literal>'`. We match
// only string literals — dynamic values (`path: AUTH_BASE_PATH`) can't be resolved
// statically, so we count them as skipped rather than silently lose them.
function fromRouteConfigs(appDir) {
  const src = fs.existsSync(path.join(appDir, 'src')) ? path.join(appDir, 'src') : appDir;
  const files = walk(src, (n) => /rout/i.test(n) && /\.(t|j)sx?$/.test(n), []);
  const raw = [];
  let pathDecls = 0, literalDecls = 0;
  const literal = /path\s*:\s*(['"`])([^'"`]*)\1/g;
  const anyPath = /path\s*:/g;
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    pathDecls += (text.match(anyPath) || []).length;
    let m;
    while ((m = literal.exec(text))) { raw.push(m[2]); literalDecls += 1; }
  }
  const res = collect(raw);
  const dynamic = pathDecls - literalDecls;
  if (dynamic > 0) res.skipped.push({ path: `${dynamic} dynamic path expression(s)`, reason: 'dynamic' });
  res.sources = files;
  return res;
}

// discoverRoutes(appDir, framework) -> { routes: string[], skipped: [{path,reason}], sources: string[] }
function discoverRoutes(appDir, framework) {
  return framework === 'blazor' ? fromRazor(appDir) : fromRouteConfigs(appDir);
}

module.exports = { discoverRoutes, classify };
