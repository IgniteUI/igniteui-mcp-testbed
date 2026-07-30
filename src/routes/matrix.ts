'use strict';

import type { Express } from 'express';
import * as matrix from '../matrix/matrix.ts';
import { normalizeMatrixRequest } from '../matrix/request.ts';
import { getLoadedMatrixConfig } from '../matrix/matrix-config.ts';

export default function registerMatrixRoutes(app: Express): void {
  // Kick off a matrix: body = { prompt, platforms[], variants[], model, apiKey, ... }.
  // Axes are platforms × variants (each variant = a set of MCPs + skills on/off); the
  // model + API key are one fixed config applied to every entry. Platform ids may be
  // built-in frameworks or any registered provider pack's framework ids —
  // normalizeMatrixRequest validates them provider-aware via getFramework().
  app.post('/api/matrix', (req, res) => {
    if (matrix.isRunning()) return res.status(409).json({ ok: false, error: 'a matrix run is already in progress' });
    const body = { ...(req.body || {}) };
    // A server-side config file (MATRIX_CONFIG) can carry the API key and base URL so
    // the browser never has to hold them: an empty key field falls back to the config's
    // (a user-typed key always wins), and customBaseUrl — which the matrix form has no
    // field for — comes along the same way.
    const loaded = getLoadedMatrixConfig();
    if (loaded) {
      if (!body.apiKey && loaded.req.fixed.apiKey) body.apiKey = loaded.req.fixed.apiKey;
      if (body.customBaseUrl === undefined && loaded.req.fixed.customBaseUrl) body.customBaseUrl = loaded.req.fixed.customBaseUrl;
      // Prompt images come along the same way, but only when the request omits the field
      // entirely — an empty array is the UI's way of saying "attach none".
      if (body.promptImages === undefined && body.images === undefined && loaded.req.fixed.promptImages) {
        body.promptImages = loaded.req.fixed.promptImages;
      }
    }
    const r = normalizeMatrixRequest(body);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    const { matrixId, total } = matrix.begin(r.req.combos, { prompt: r.req.prompt, fixed: r.req.fixed, name: r.req.name });
    res.json({ ok: true, matrixId, total, dropped: r.req.dropped });
  });

  // The server-side matrix config (MATRIX_CONFIG file), if any — for UI prefill.
  // The API key itself is never echoed; hasApiKey lets the UI show one is on file.
  app.get('/api/matrix/config', (_req, res) => {
    const c = getLoadedMatrixConfig();
    if (!c) return res.json({ ok: true, config: null });
    const { fixed } = c.req;
    res.json({
      ok: true,
      config: {
        platforms: c.req.platforms,
        variants: c.req.variants,
        model: fixed.model,
        prompt: c.req.prompt,
        name: c.req.name,
        customMcp: fixed.customMcp || '',
        customBaseUrl: fixed.customBaseUrl || null,
        selectedTests: fixed.selectedTests ?? null, // null = field omitted = "all"
        promptImages: fixed.promptImages ?? null,   // null = field omitted = attach none
        hasApiKey: !!fixed.apiKey,
        autoRun: c.autoRun,
        dropped: c.req.dropped,
        warnings: c.warnings,
      },
    });
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
