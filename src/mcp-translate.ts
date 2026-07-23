'use strict';

/**
 * Convert an `.mcp.json` document (the standard project-root file `ig ai-config`
 * now writes) into opencode's `mcp` block. The legacy VS Code `.vscode/mcp.json`
 * shape is accepted too — the two differ only in the wrapper key.
 *
 * .mcp.json schema:  { "mcpServers": { "<name>": { command, args, env } | { url, headers } } }
 * VS Code schema:    { "servers": { ...same entries... }, "inputs": [...] }
 * opencode schema:   { "<name>": { type:"local", command:[...], environment:{} }
 *                                 | { type:"remote", url, headers }, enabled:bool }
 *
 * Differences handled:
 *   - the source keeps `command` (string) + `args` (array) separate;
 *     opencode wants a single `command` array.
 *   - the source uses `env`; opencode uses `environment`.
 *   - `${workspaceFolder}` -> the real project dir.
 *   - `${env:VAR}` -> opencode's `{env:VAR}` substitution syntax.
 *   - `enabled` is set per the user's MCP toggles (the set of names to enable).
 *
 * NOTE: VS Code `${input:...}` prompts can't be answered headlessly. For OSS
 * Ignite UI the servers don't use them; if one appears we leave it as-is and
 * flag it so you notice rather than silently shipping a broken value.
 */

export interface TranslateOpts {
  enabled: Set<string>;
  workspaceFolder: string;
}

export interface TranslateResult {
  mcp: Record<string, any>;
  warnings: string[];
}

function resolvePlaceholders(value: any, workspaceFolder: string): any {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
    .replace(/\$\{env:([^}]+)\}/g, (_, v) => `{env:${v}}`);
}

function resolveDeep(obj: any, workspaceFolder: string): any {
  if (Array.isArray(obj)) return obj.map((x) => resolveDeep(x, workspaceFolder));
  if (obj && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveDeep(v, workspaceFolder);
    return out;
  }
  return resolvePlaceholders(obj, workspaceFolder);
}

export function translate(mcpDoc: any, { enabled, workspaceFolder }: TranslateOpts): TranslateResult {
  const mcp: Record<string, any> = {};
  const warnings: string[] = [];
  const servers = (mcpDoc && (mcpDoc.servers || mcpDoc.mcpServers)) || {};

  for (const [name, raw] of Object.entries(servers)) {
    const s = resolveDeep(raw, workspaceFolder);
    const isEnabled = enabled.has(name);

    if (s.url) {
      mcp[name] = {
        type: 'remote',
        url: s.url,
        ...(s.headers ? { headers: s.headers } : {}),
        enabled: isEnabled,
      };
    } else if (s.command) {
      mcp[name] = {
        type: 'local',
        command: [s.command, ...(Array.isArray(s.args) ? s.args : [])],
        ...(s.env ? { environment: s.env } : {}),
        enabled: isEnabled,
      };
    } else {
      warnings.push(`Server "${name}" has neither command nor url; skipped.`);
      continue;
    }

    if (JSON.stringify(s).includes('${input:')) {
      warnings.push(`Server "${name}" uses a VS Code \${input:...} prompt that can't be resolved headlessly — check it.`);
    }
  }

  return { mcp, warnings };
}
