'use strict';

const path = require('path');
const { ARTIFACT_DIR } = require('../config');
const history = require('../history');
const { rmrf } = require('../proc/fsutil');
const session = require('../session');

module.exports = function registerHistoryRoutes(app) {
  // Persisted run history (cross-container). List is newest-first; detail by id.
  app.get('/api/history', (_req, res) => {
    res.json({ ok: true, runs: history.list() });
  });

  app.get('/api/history/:id', (req, res) => {
    const run = history.get(req.params.id);
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
    const id = req.params.id;
    if (id === session.getCurrentRunId() && session.getRunState().phase === 'running') {
      return res.status(409).json({ ok: false, error: 'run is still in progress' });
    }
    const removed = history.remove(id);
    if (!removed) return res.status(404).json({ ok: false, error: 'not found' });
    try { await rmrf(path.join(ARTIFACT_DIR, id)); } catch (_) {}
    res.json({ ok: true });
  });
};
