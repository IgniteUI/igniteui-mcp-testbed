'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_ENV } from '../config.ts';
import type { RunConfig, Emit } from '../types.ts';
import { codemodeEnabled, opencodeMajor } from './opencode-cli.ts';

export function providerEnvFor(model: string, apiKey?: string): Record<string, string> {
  const prefix = String(model).split('/')[0];
  const key = PROVIDER_ENV[prefix];
  return key && apiKey ? { [key]: apiKey } : {};
}

// `mcp` arrives in the 1.x shape; 2.x needs the native shape to honour `codemode`.
export function writeOpencodeConfig(cfg: RunConfig, mcp: Record<string, any>, appDir: string): void {
  const v2 = opencodeMajor() >= 2;
  const doc: Record<string, any> = {
    $schema: 'https://opencode.ai/config.json',
    model: cfg.model,
  };
  // Allow everything: headless opencode blocks on a permission prompt instead of failing.
  if (v2) {
    // websearch always fails here and fails the run; last match wins, so deny after the allow.
    doc.permissions = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'websearch', resource: '*', effect: 'deny' },
    ];
    doc.mcp = { servers: toV2Servers(mcp) };
  } else {
    doc.permission = 'allow';
    doc.mcp = mcp;
  }
  // Custom OpenAI-compatible endpoint; 2.x normalizes the 1.x spelling.
  if (cfg.customBaseUrl) {
    const id = 'custom';
    doc.provider = {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Endpoint',
        options: { baseURL: cfg.customBaseUrl, apiKey: '{env:CUSTOM_API_KEY}' },
        models: { [cfg.model.split('/').slice(1).join('/') || cfg.model]: {} },
      },
    };
  }
  fs.writeFileSync(path.join(appDir, 'opencode.json'), JSON.stringify(doc, null, 2));
}

function toV2Servers(mcp: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(mcp)) {
    const { enabled, ...rest } = def || {};
    out[name] = { ...rest, disabled: enabled === false, codemode: !!codemodeEnabled() };
  }
  return out;
}

// Returned in the 1.x shape whichever version wrote it.
export function readOpencodeMcp(appDir: string): Record<string, any> {
  const p = path.join(appDir, 'opencode.json');
  if (!fs.existsSync(p)) return {};
  const mcp = JSON.parse(fs.readFileSync(p, 'utf8')).mcp || {};
  if (!mcp.servers || typeof mcp.servers !== 'object') return mcp;
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries<any>(mcp.servers)) {
    const { disabled, codemode, ...rest } = def || {};
    out[name] = { ...rest, enabled: disabled !== true };
  }
  return out;
}

// Write a framework `prepare` file, merging instead of clobbering when one already
// exists. For MSBuild props/targets we inject our PropertyGroup before the closing
// </Project> (later definitions win, so our properties override); other existing
// files are left untouched so we never overwrite template-provided content.
export function writePrepareFile(dest: string, body: string, emit: Emit, appDir: string): void {
  const rel = path.relative(appDir, dest);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    emit('log', `wrote ${rel}`);
    return;
  }
  if (!/\.(props|targets)$/i.test(dest)) {
    emit('log', `kept existing ${rel} (not overwritten)`);
    return;
  }
  const existing = fs.readFileSync(dest, 'utf8');
  const inner = (body.match(/<Project[^>]*>([\s\S]*)<\/Project>/i) || ['', body])[1].trim();
  const idx = existing.toLowerCase().lastIndexOf('</project>');
  if (idx === -1) {
    fs.writeFileSync(dest, existing.trimEnd() + '\n' + body);
  } else {
    fs.writeFileSync(dest, existing.slice(0, idx) + '  ' + inner + '\n' + existing.slice(idx));
  }
  emit('log', `merged into existing ${rel}`);
}
