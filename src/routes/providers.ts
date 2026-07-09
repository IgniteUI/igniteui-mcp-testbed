'use strict';

import type { Express } from 'express';
import { listPacks, getPack, savePack, deletePack } from '../provider-registry.ts';
import type { ProviderPack } from '../types.ts';

/** Basic structural validation — ensures required fields are present. */
function validate(body: any): ProviderPack | null {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return null;
  if (!body.displayName || typeof body.displayName !== 'string') return null;
  if (!Array.isArray(body.frameworks) || body.frameworks.length === 0) return null;
  if (!body.configure || !Array.isArray(body.configure.mcpServers)) return null;
  return body as ProviderPack;
}

export default function registerProviderRoutes(app: Express): void {
  /** List all currently loaded external provider packs. */
  app.get('/api/providers', (_req, res) => {
    res.json({ ok: true, providers: listPacks() });
  });

  /** Upload (load) a new provider pack from a JSON body. */
  app.post('/api/providers', (req, res) => {
    const pack = validate(req.body);
    if (!pack) {
      res.status(400).json({ ok: false, error: 'invalid provider pack — name, displayName, frameworks and configure.mcpServers are required' });
      return;
    }
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
