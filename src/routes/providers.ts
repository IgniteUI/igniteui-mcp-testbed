'use strict';

import type { Express } from 'express';
import { listPacks, getPack, savePack, deletePack } from '../provider-registry.ts';
import type { ProviderPack } from '../types.ts';

// Only letters/digits/hyphens/underscores, must start with a letter or digit —
// mirrors SAFE_ID in provider-registry.ts (path-traversal + prototype-pollution guard).
const SAFE_PACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Basic structural validation — ensures required fields are present and safe. */
function validate(body: any): { pack: ProviderPack } | { error: string } {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return { error: 'name is required and must be a non-empty string' };
  }
  if (!SAFE_PACK_NAME.test(body.name.trim())) {
    return { error: 'name contains disallowed characters — only letters, digits, hyphens and underscores are allowed' };
  }
  if (!body.displayName || typeof body.displayName !== 'string') {
    return { error: 'displayName is required and must be a non-empty string' };
  }
  if (!Array.isArray(body.frameworks) || body.frameworks.length === 0) {
    return { error: 'frameworks must be a non-empty array' };
  }
  for (let i = 0; i < body.frameworks.length; i++) {
    const fw = body.frameworks[i];
    if (!fw || typeof fw.id !== 'string' || !SAFE_PACK_NAME.test(fw.id)) {
      return { error: `frameworks[${i}].id is missing or contains disallowed characters` };
    }
    if (typeof fw.label !== 'string' || !fw.label.trim()) {
      return { error: `frameworks[${i}].label is required` };
    }
    if (!fw.scaffold || typeof fw.scaffold.cmd !== 'string') {
      return { error: `frameworks[${i}].scaffold.cmd is required` };
    }
    if (!Array.isArray(fw.scaffold.argv) || !fw.scaffold.argv.every((a: any) => typeof a === 'string')) {
      return { error: `frameworks[${i}].scaffold.argv must be an array of strings` };
    }
    if (!fw.dev || typeof fw.dev.cmd !== 'string') {
      return { error: `frameworks[${i}].dev.cmd is required` };
    }
    if (!Array.isArray(fw.dev.argv) || !fw.dev.argv.every((a: any) => typeof a === 'string')) {
      return { error: `frameworks[${i}].dev.argv must be an array of strings` };
    }
  }
  if (!body.configure || !Array.isArray(body.configure.mcpServers)) {
    return { error: 'configure.mcpServers must be an array' };
  }
  for (let i = 0; i < body.configure.mcpServers.length; i++) {
    const s = body.configure.mcpServers[i];
    if (!s || typeof s.name !== 'string' || !SAFE_PACK_NAME.test(s.name)) {
      return { error: `configure.mcpServers[${i}].name is missing or contains disallowed characters` };
    }
    if (typeof s.command !== 'string' || !s.command.trim()) {
      return { error: `configure.mcpServers[${i}].command is required` };
    }
    if (typeof s.class !== 'string' || !SAFE_PACK_NAME.test(s.class)) {
      return { error: `configure.mcpServers[${i}].class is missing or contains disallowed characters` };
    }
    if (typeof s.label !== 'string' || !s.label.trim()) {
      return { error: `configure.mcpServers[${i}].label is required` };
    }
    if (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every((a: any) => typeof a === 'string'))) {
      return { error: `configure.mcpServers[${i}].args must be an array of strings when provided` };
    }
  }
  return { pack: body as ProviderPack };
}

export default function registerProviderRoutes(app: Express): void {
  /** List all currently loaded external provider packs. */
  app.get('/api/providers', (_req, res) => {
    res.json({ ok: true, providers: listPacks() });
  });

  /** Upload (load) a new provider pack from a JSON body. */
  app.post('/api/providers', (req, res) => {
    const result = validate(req.body);
    if ('error' in result) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    const pack = result.pack;
    if (pack.name === 'igniteui') {
      res.status(400).json({ ok: false, error: '"igniteui" is reserved for the built-in provider' });
      return;
    }
    try {
      savePack(pack);
      res.json({ ok: true, provider: pack });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Remove an external provider pack by name. */
  app.delete('/api/providers/:name', (req, res) => {
    const { name } = req.params;
    if (name === 'igniteui') {
      res.status(400).json({ ok: false, error: 'cannot remove the built-in provider' });
      return;
    }
    if (!getPack(name)) {
      res.status(404).json({ ok: false, error: 'provider not found' });
      return;
    }
    try {
      deletePack(name);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
