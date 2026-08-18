'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Express } from 'express';
import * as matrix from '../matrix/matrix.ts';
import { run } from '../proc/exec.ts';
import { normalizeMatrixRequest } from '../matrix/request.ts';
import { getLoadedMatrixConfig } from '../matrix/matrix-config.ts';
import { SIS_MODEL, SIS_API_KEY, SIS_MAX_STAGES, SIS_PROMPT_TEMPLATE, PROVIDER_ENV } from '../config.ts';

async function splitPrompt(userPrompt: string): Promise<string[]> {
  const tmpDir = fs.mkdtempSync('/tmp/split-prompt-');
  const dataDir = path.join(tmpDir, '.data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'opencode.json'),
    JSON.stringify({ model: SIS_MODEL, permission: 'allow' }, null, 2),
  );
  // Resolve API key: explicit SIS_API_KEY env > PROVIDER_ENV lookup by model prefix.
  const providerPrefix = SIS_MODEL.split('/')[0];
  const keyEnvVar = PROVIDER_ENV[providerPrefix];
  const resolvedKey = SIS_API_KEY || (keyEnvVar ? (process.env[keyEnvVar] || '') : '');
  try {
    const fullPrompt = SIS_PROMPT_TEMPLATE
      .replace('{MAX}', String(SIS_MAX_STAGES))
      .replace('{PROMPT}', userPrompt);
    const ocEnv: Record<string, string> = { XDG_DATA_HOME: dataDir };
    if (resolvedKey && keyEnvVar) ocEnv[keyEnvVar] = resolvedKey;
    await run('opencode', ['run', fullPrompt], tmpDir, () => {}, {
      env: ocEnv,
      timeoutMs: 60_000,
    });
    const dbPath = path.join(dataDir, 'opencode', 'opencode.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let text: string | null = null;
    try {
      const rows = db.prepare(
        'SELECT data FROM part ORDER BY time_created DESC LIMIT 30',
      ).all() as Array<{ data: string }>;
      for (const row of rows) {
        let part: any;
        try { part = JSON.parse(String(row.data)); } catch (_) { continue; }
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          text = part.text; break;
        }
      }
    } finally {
      try { db.close(); } catch (_) {}
    }
    if (!text) throw new Error('no text response from model');
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('model response did not contain a JSON array');
    const stages: unknown = JSON.parse(match[0]);
    if (!Array.isArray(stages) || stages.length < 2 || !stages.every((s) => typeof s === 'string'))
      throw new Error('expected an array of 2+ strings');
    return (stages as string[]).slice(0, SIS_MAX_STAGES).map((s) => s.trim()).filter(Boolean);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

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
    const { matrixId, total } = matrix.begin(r.req.combos, { passes: r.req.passes, fixed: r.req.fixed });
    res.json({ ok: true, matrixId, total, dropped: r.req.dropped, totalPasses: r.req.passes.length });
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
        passes: c.req.passes,
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

  app.post('/api/matrix/split-prompt', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    if (prompt.length > 10_000) return res.status(400).json({ ok: false, error: 'prompt too long' });
    try {
      const stages = await splitPrompt(prompt);
      res.json({ ok: true, stages });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message || 'split failed' });
    }
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
