'use strict';

// The MCP half of the configure stage, the same for every pack:
//   1. collect servers — from the file the configure steps generated (`mcp.source`,
//      e.g. Ignite UI's `.mcp.json`) or from the pack's own `mcp.servers` list;
//   2. add the user's pasted custom servers (class `custom`);
//   3. classify each one and enable only the classes the run selected, so a run with
//      no MCPs selected is a true clean baseline;
//   4. translate to opencode's shape and apply launch-command overrides
//      (MCP_CMD_* env, then the pack's `mcp.commands`).

import * as fs from 'fs';
import * as path from 'path';
import { translate } from '../mcp-translate.ts';
import { bareMcpClass } from '../mcp-class.ts';
import { resolveMcpCommand } from '../provider-registry.ts';
import type { Emit, PackMcpSource, ProviderPack, RunConfig } from '../types.ts';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** First rule whose `match` occurs in the server's name + command line wins; the order
 * is the pack's (Ignite UI lists `theming` and `angular` before the generic `ignite`). */
export function classifyByRules(name: string, s: any, rules: PackMcpSource['rules']): string {
  const hay = (name + ' ' + [s?.command, ...(s?.args || [])].join(' ')).toLowerCase();
  return rules.find((r) => hay.includes(r.match.toLowerCase()))?.class ?? 'other';
}

function readSource(src: PackMcpSource, appDir: string, emit: Emit): any {
  for (const [i, rel] of src.files.entries()) {
    const abs = path.join(appDir, rel);
    if (!fs.existsSync(abs)) continue;
    if (i > 0) emit('log', `no ${src.files[0]} found; using legacy ${rel}`);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  emit('log', `no ${src.files[0]} found; continuing with empty MCP set`);
  return {};
}

// The pasted JSON may be one server def, a named map, or a whole .mcp.json /
// .vscode/mcp.json. Names get a fixed `custom-` prefix before they are used as keys, so
// pasted input can never produce `__proto__` and friends (CodeQL js/remote-property-injection).
function addCustomServers(cfg: RunConfig, servers: Record<string, any>, emit: Emit): Set<string> {
  const names = new Set<string>();
  if (!cfg.customMcp || !cfg.customMcp.trim()) return names;
  try {
    const parsed = JSON.parse(cfg.customMcp);
    const isServerDef = (o: any) => o && typeof o === 'object' && (o.command || o.url);
    const custom: Record<string, any> =
      (parsed && parsed.servers && typeof parsed.servers === 'object') ? parsed.servers :
      (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers :
      isServerDef(parsed) ? { custom: parsed } :
      parsed;
    for (const [rawName, def] of Object.entries(custom || {})) {
      let key = 'custom-' + rawName, n = 1;
      while (Object.prototype.hasOwnProperty.call(servers, key)) key = `custom-${rawName}-${n++}`;
      servers[key] = def;
      names.add(key);
    }
  } catch (e: any) {
    emit('log', `warning: could not parse custom MCP JSON (${e.message}); skipped`);
  }
  return names;
}

export interface McpConfigResult {
  /** opencode's 1.x-shaped `mcp` block; disabled servers stay in it with enabled:false. */
  mcp: Record<string, any>;
  enabledCount: number;
}

export function buildMcpConfig(pack: ProviderPack, cfg: RunConfig, appDir: string, emit: Emit): McpConfigResult {
  const classByName: Record<string, string> = Object.create(null);
  let servers: Record<string, any>;

  if (pack.mcp.source) {
    const doc = readSource(pack.mcp.source, appDir, emit);
    // .mcp.json wraps servers in `mcpServers`, the legacy VS Code file in `servers`.
    servers = { ...(doc.servers || doc.mcpServers || {}) };
    for (const [name, s] of Object.entries(servers)) classByName[name] = classifyByRules(name, s, pack.mcp.source.rules);
  } else {
    servers = Object.create(null);
    for (const s of pack.mcp.servers) {
      if (FORBIDDEN.has(s.name)) continue;
      servers[s.name] = { command: s.command, args: s.args || [] };
      classByName[s.name] = s.class;
    }
    // Kept as a record of what the pack declared; opencode reads opencode.json.
    fs.writeFileSync(path.join(appDir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    emit('log', `wrote .mcp.json (${Object.keys(servers).length} server(s) from pack "${pack.name}")`);
  }
  for (const name of addCustomServers(cfg, servers, emit)) classByName[name] = 'custom';

  // A bare class (`igniteui`, from a config or record written before classes were
  // qualified) still selects this pack's own class.
  const selected = new Set((cfg.enabledMcps || []).map((t) => t.toLowerCase()));
  // A matrix applies one variant to every platform, so a class limited to some
  // frameworks must stay off for the others.
  const applies = (cls: string) => {
    const decl = pack.mcp.classes.find((k) => k.id === cls);
    return !decl?.frameworks?.length || decl.frameworks.includes(cfg.framework);
  };
  const enabled = new Set<string>();
  for (const name of Object.keys(servers)) {
    const cls = classByName[name];
    const on = cls !== 'other' && applies(cls) && (selected.has(cls.toLowerCase()) || selected.has(bareMcpClass(cls).toLowerCase()));
    if (on) enabled.add(name);
    emit('log', `mcp "${name.replace(/[\r\n]/g, ' ')}" → ${cls} → ${on ? 'enabled' : 'disabled'}`);
  }

  const { mcp, warnings } = translate({ servers }, { enabled, workspaceFolder: appDir });
  warnings.forEach((w) => emit('log', `warning: ${w}`));
  for (const [name, def] of Object.entries(mcp)) {
    const fix = resolveMcpCommand(classByName[name]);
    if (fix && def.type === 'local') {
      def.command = fix.slice();
      emit('log', `mcp "${name}" command → ${fix.join(' ')}`);
    }
  }
  return { mcp, enabledCount: enabled.size };
}
