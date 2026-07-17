'use strict';

import type { Express } from 'express';
import { listPacks, getPack, savePack, deletePack, validatePack } from '../provider-registry.ts';
import type { ProviderPack } from '../types.ts';

export default function registerProviderRoutes(app: Express): void {
  /** List all currently loaded external provider packs. */
  app.get('/api/providers', (_req, res) => {
    res.json({ ok: true, providers: listPacks() });
  });

  /** Upload (load) a new provider pack from a JSON body. */
  app.post('/api/providers', (req, res) => {
    let pack: ProviderPack;
    try {
      pack = validatePack(req.body);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
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
