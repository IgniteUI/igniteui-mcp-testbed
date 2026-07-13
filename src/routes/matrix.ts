'use strict';

import type { Express } from 'express';
import { FRAMEWORKS } from '../frameworks.ts';
import { MATRIX_MAX_ENTRIES } from '../config.ts';
import * as matrix from '../matrix/matrix.ts';
import { parseVariants, variantLabel } from '../matrix/variants.ts';
import type { Combo } from '../types.ts';

export default function registerMatrixRoutes(app: Express): void {
  // Kick off a matrix: body = { prompt, platforms[], variants[], model, apiKey, ... }.
  // Axes are platforms × variants (each variant = a set of MCPs + skills on/off); the
  // model + API key are one fixed config applied to every entry.
  app.post('/api/matrix', (req, res) => {
    if (matrix.isRunning()) return res.status(409).json({ ok: false, error: 'a matrix run is already in progress' });
    const body = req.body || {};
    const platforms: string[] = (body.platforms || []).filter((p: string) => FRAMEWORKS[p]);
    const variants = parseVariants(body.variants);
    const model = String(body.model || '').trim();
    const prompt = String(body.prompt || '').trim();
    if (!platforms.length || !variants.length) {
      return res.status(400).json({ ok: false, error: 'select at least one platform and one variant' });
    }
    if (!model) return res.status(400).json({ ok: false, error: 'a model is required for matrix runs' });
    if (!prompt) return res.status(400).json({ ok: false, error: 'a prompt is required for matrix runs' });

    let combos: Combo[] = [];
    for (const platform of platforms) for (const variant of variants) {
      combos.push({ platform, variant, variantLabel: variantLabel(variant) });
    }
    let dropped = 0;
    if (combos.length > MATRIX_MAX_ENTRIES) {
      dropped = combos.length - MATRIX_MAX_ENTRIES;
      combos = combos.slice(0, MATRIX_MAX_ENTRIES);
    }

    const { matrixId, total } = matrix.begin(combos, { prompt, fixed: { model, apiKey: body.apiKey, customBaseUrl: body.customBaseUrl, customMcp: body.customMcp, skipTests: !!body.skipTests } });
    res.json({ ok: true, matrixId, total, dropped });
  });

  app.get('/api/matrix/status', (_req, res) => {
    res.json({ ok: true, ...matrix.getState() });
  });

  app.post('/api/matrix/cancel', (_req, res) => {
    const r = matrix.cancel();
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  });

  // Cancel a single entry (by history runId) without aborting the rest of the matrix.
  app.post('/api/matrix/cancel/:runId', (req, res) => {
    const r = matrix.cancelEntry(req.params.runId);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  });

  app.get('/api/matrix/stream', (req, res) => {
    matrix.sse.attach(req, res, { type: 'state', state: matrix.getState() });
  });
}
