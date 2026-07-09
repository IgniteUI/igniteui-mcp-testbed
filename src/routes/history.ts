'use strict';

import * as path from 'path';
import type { Express } from 'express';
import { ARTIFACT_DIR } from '../config.ts';
import * as history from '../history.ts';
import { buildExportHtml, buildExportRuns } from '../history-export.ts';
import { rmrf } from '../proc/fsutil.ts';
import * as session from '../session.ts';

export default function registerHistoryRoutes(app: Express): void {
  // Persisted run history (cross-container). List is newest-first; detail by id.
  app.get('/api/history', (_req, res) => {
    res.json({ ok: true, runs: history.list() });
  });

  // Export the full history (with screenshots embedded as base64) as a standalone HTML file.
  // Registered before /:id so the path "export" isn't captured as a run id.
  app.get('/api/history/export', async (_req, res) => {
    try {
      const runs = history.list();
      const html = await buildExportHtml(runs);
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ignite-ui-history-${date}.html"`);
      res.send(html);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Export the same enriched run data as plain JSON (screenshots as base64 data-URLs).
  // Useful for feeding into third-party analysis tools.
  app.get('/api/history/export.json', async (_req, res) => {
    try {
      const runs = history.list();
      const exportRuns = await buildExportRuns(runs);
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ignite-ui-history-${date}.json"`);
      res.json(exportRuns);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/history/:id', (req, res) => {
    const id = history.parseRunId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });
    const run = history.get(id);
    if (!run) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, run });
  });

  app.post('/api/history/:id/rating', (req, res) => {
    const id = history.parseRunId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });
    const raw = req.body && req.body.rating;
    const rating = raw == null || raw === '' ? null : Number(raw);
    if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ ok: false, error: 'rating must be an integer from 1 to 5' });
    }
    const run = history.updateRating(id, rating);
    if (!run) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, run });
  });

  // Delete every record of one matrix submission (and its screenshot artifacts).
  // Registered before /:id so "matrix" isn't captured as an id.
  app.delete('/api/history/matrix/:matrixId', async (req, res) => {
    const matrixId = req.params.matrixId;
    const ids = history.list().filter((r) => r.matrixId === matrixId).map((r) => r.id);
    for (const id of ids) {
      history.remove(id);
      try { await rmrf(path.join(ARTIFACT_DIR, id)); } catch (_) {}
    }
    res.json({ ok: true, deleted: ids.length });
  });

  // Delete a single run record and its screenshot artifacts.
  app.delete('/api/history/:id', async (req, res) => {
    const id = history.parseRunId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });
    if (id === session.getCurrentRunId() && session.getRunState().phase === 'running') {
      return res.status(409).json({ ok: false, error: 'run is still in progress' });
    }
    const removed = history.remove(id);
    if (!removed) return res.status(404).json({ ok: false, error: 'not found' });
    try { await rmrf(path.join(ARTIFACT_DIR, id)); } catch (_) {}
    res.json({ ok: true });
  });
}
