'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { PROVIDER_ENV } from '../config.ts';
import type { RunConfig, Emit } from '../types.ts';

export function providerEnvFor(model: string, apiKey?: string): Record<string, string> {
  const prefix = String(model).split('/')[0];
  const key = PROVIDER_ENV[prefix];
  return key && apiKey ? { [key]: apiKey } : {};
}

// Build the opencode.json the agent will read.
export function writeOpencodeConfig(cfg: RunConfig, mcp: Record<string, any>, appDir: string): void {
  const doc: Record<string, any> = {
    $schema: 'https://opencode.ai/config.json',
    model: cfg.model,
    // Auto-approve every permission. Headless `opencode run` (matrix) has stdin =
    // /dev/null, and opencode BLOCKS on a permission prompt rather than failing on
    // EOF — e.g. an agent writing scratch files to /tmp triggers `external_directory`
    // (default: ask) and hangs until AGENT_TIMEOUT_MS. This appliance is an ephemeral
    // sandbox, so allowing everything (incl. external dirs) is the right default and
    // also spares the interactive opencode-web user from approval prompts.
    permission: 'allow',
    mcp,
  };
  // Custom OpenAI-compatible endpoint -> declare a provider.
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
