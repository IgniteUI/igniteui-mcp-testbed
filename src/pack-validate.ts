'use strict';

// `./run.sh --validate-pack <dir|file>` / `.\run.ps1 -ValidatePack <dir|file>`: load a
// pack exactly as the server would and report everything that would stop it working,
// without scaffolding, installing or running anything. The only network call is a
// read-only `npm view` per container dependency.
//
// Exit codes: 0 = no problems, 1 = at least one ✗, 2 = misuse.

import * as fs from 'fs';
import * as path from 'path';
import { capture } from './proc/exec.ts';
import { readPackFrom, registerPack, getPack, resolvePackPath } from './provider-registry.ts';
import { secretStatus } from './secrets.ts';
import type { ProviderPack } from './types.ts';

type Line = { mark: '✓' | '⚠' | '✗'; text: string };

// PATH lookup without a shell (PATHEXT covers a Windows host-dev run).
function onPath(cmd: string): boolean {
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .some((d) => exts.some((x) => { try { return fs.statSync(path.join(d, cmd + x)).isFile(); } catch { return false; } }));
}

async function checkPack(pack: ProviderPack, lines: Line[]): Promise<void> {
  const ok = (text: string) => lines.push({ mark: '✓', text });
  const warn = (text: string) => lines.push({ mark: '⚠', text });
  const bad = (text: string) => lines.push({ mark: '✗', text });

  ok(`schema: "${pack.name}"${pack.version ? ` v${pack.version}` : ''} (${pack.origin}, #${pack.hash}) — ` +
    `${pack.frameworks.length} framework(s): ${pack.frameworks.map((f) => f.id).join(', ')}`);

  const prior = getPack(pack.name);
  try {
    registerPack(pack);
    if (prior) warn(`a pack named "${pack.name}" is already loaded (${prior.origin}); this one would replace it`);
    else ok('no name or framework-id collision with the loaded packs');
  } catch (e: any) {
    bad(`collision: ${e.message}`);
  }

  ok(`MCP: ${pack.mcp.classes.map((c) => c.id).join(', ') || 'no classes'}` +
    (pack.mcp.source ? ` · read from ${pack.mcp.source.files.join(' / ')}` : ` · ${pack.mcp.servers.length} declared server(s)`));
  for (const c of pack.mcp.classes) {
    const served = pack.mcp.source
      ? pack.mcp.source.rules.some((r) => r.class === c.id)
      : pack.mcp.servers.some((s) => s.class === c.id);
    if (!served) warn(`MCP class ${c.id} has no ${pack.mcp.source ? 'rule' : 'server'} — selecting it enables nothing`);
  }

  // Paths inside the pack folder that the run will read.
  const packPaths: string[] = [];
  for (const fw of pack.frameworks) if (fw.scaffold.kind === 'template') packPaths.push(fw.scaffold.from);
  for (const s of pack.skills?.sources || []) if (s.dir) packPaths.push(s.dir);
  for (const rel of packPaths) {
    try {
      const abs = resolvePackPath(pack, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) ok(`folder ${rel} present`);
      else bad(`folder ${rel} not found in the pack`);
    } catch (e: any) { bad(e.message); }
  }
  if (pack.dir) {
    const tests = pack.frameworks.filter((f) => fs.existsSync(path.join(pack.dir!, 'tests', f.id)));
    if (tests.length) ok(`tests for ${tests.map((f) => f.id).join(', ')}`);
  }

  for (const s of secretStatus(pack)) {
    if (s.set) ok(`secret ${s.name} set (${s.source})`);
    else if (s.required) bad(`secret ${s.name} missing — put it in ${s.source}`);
    else warn(`optional secret ${s.name} not set (${s.source})`);
  }

  const deps = pack.containerDeps?.npmGlobal || [];
  for (const spec of deps) {
    try {
      const v = (await capture('npm', ['view', spec, 'version', '--json'], process.cwd(), null, 60_000)).trim();
      const parsed = v ? JSON.parse(v) : null;
      const shown = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
      if (shown) ok(`container dep ${spec} resolves (${shown}); installed when the pack loads`);
      else bad(`container dep ${spec}: no matching version on the registry`);
    } catch (e: any) {
      bad(`container dep ${spec}: ${String(e.message).split('\n')[0]}`);
    }
  }

  // Commands the pack's steps launch. One a container dep provides only appears after
  // the install, so a miss is a warning when the pack has deps.
  const cmds = new Set<string>();
  for (const fw of pack.frameworks) {
    if (fw.scaffold.kind !== 'template') cmds.add(fw.scaffold.cmd);
    cmds.add(fw.dev.cmd);
  }
  for (const c of pack.configure || []) cmds.add(c.cmd);
  for (const s of pack.mcp.servers) cmds.add(s.command);
  for (const cmd of cmds) {
    if (onPath(cmd)) ok(`command ${cmd} found`);
    else if (deps.length) warn(`command ${cmd} not on PATH yet — fine if a container dep provides it`);
    else bad(`command ${cmd} not found in the image (add it to containerDeps or the Containerfile)`);
  }
}

export async function validatePackCli(target: string): Promise<number> {
  if (!target || !fs.existsSync(target)) {
    console.error(`pack not found: ${target}`);
    return 2;
  }
  const lines: Line[] = [];
  let pack: ProviderPack;
  try {
    pack = readPackFrom(target);
  } catch (e: any) {
    console.error(`✗ ${path.basename(target)}: ${e.message}`);
    return 1;
  }
  await checkPack(pack, lines);
  for (const l of lines) console.log(`${l.mark} ${l.text}`);
  const failed = lines.filter((l) => l.mark === '✗').length;
  const warned = lines.filter((l) => l.mark === '⚠').length;
  console.log(failed ? `\n${failed} problem(s), ${warned} warning(s)` : `\npack OK${warned ? ` (${warned} warning(s))` : ''}`);
  return failed ? 1 : 0;
}
