'use strict';

const fs = require('fs');
const path = require('path');
const { APP_DIR, OPENCODE_PORT } = require('../config');
const history = require('../history');
const session = require('../session');
const { runPipeline } = require('../pipeline/pipeline');
const { spawnWatcher, killWatcher } = require('../proc/watcher');
const { waitForPort } = require('../proc/ports');
const { writeOpencodeConfig, providerEnvFor } = require('../pipeline/opencode-config');

module.exports = function registerRunRoutes(app) {
  app.post('/api/run', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    // Stream to the launching tab AND record/broadcast so a reconnecting wizard can
    // re-attach. Writes are guarded: closing the launching tab must not abort the run.
    // Per-stage wall-clock, closed out when the next step starts or the run ends.
    const timings = {};
    let stepName = null, stepStart = null;
    const markStep = (name) => {
      const now = Date.now();
      if (stepName) timings[stepName] = now - stepStart;
      stepName = name; stepStart = now;
    };
    const closeStep = () => {
      if (stepName) { timings[stepName] = Date.now() - stepStart; stepName = null; }
    };

    const emit = (type, payload) => {
      const obj = typeof payload === 'string' ? { type, msg: payload } : { type, ...payload };
      if (type === 'step') markStep(obj.step);
      session.recordRun(obj);
      try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
    };

    const cfg = req.body || {};
    const runId = session.beginRun(cfg);

    try {
      const result = await runPipeline(cfg, { emit });
      // Begin gathering live stats (messages / tokens / cost) into /work/stats.json.
      session.startStats(cfg);
      emit('log', 'stats collector started → stats.json');
      emit('done', result);
      closeStep();
      history.finish(runId, { status: 'success', completed: session.getRunState().completed.slice(), timings, logs: session.getRunState().logs.slice() });
    } catch (err) {
      emit('error', err.message);
      closeStep();
      history.finish(runId, { status: 'error', error: err.message, completed: session.getRunState().completed.slice(), timings, logs: session.getRunState().logs.slice() });
    } finally {
      try { res.end(); } catch (_) {}
    }
  });

  // Switch model/key later: rewrite opencode.json + restart opencode.
  app.post('/api/model', async (req, res) => {
    const lastConfig = session.getLastConfig();
    if (!lastConfig) return res.status(400).json({ error: 'no active session' });
    lastConfig.model = req.body.model || lastConfig.model;
    lastConfig.apiKey = req.body.apiKey || lastConfig.apiKey;
    lastConfig.customBaseUrl = req.body.customBaseUrl || lastConfig.customBaseUrl;

    // Preserve existing mcp block from the file.
    let mcp = {};
    const p = path.join(APP_DIR, 'opencode.json');
    if (fs.existsSync(p)) mcp = JSON.parse(fs.readFileSync(p, 'utf8')).mcp || {};
    writeOpencodeConfig(lastConfig, mcp, APP_DIR);

    killWatcher('opencode');
    const ocEnv = providerEnvFor(lastConfig.model, lastConfig.apiKey);
    if (lastConfig.customBaseUrl && lastConfig.apiKey) ocEnv.CUSTOM_API_KEY = lastConfig.apiKey;
    spawnWatcher('opencode', 'opencode',
      ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)], APP_DIR, ocEnv);
    try { await waitForPort(OPENCODE_PORT, 60000); } catch (_) {}
    // Collector keeps its accumulated totals; just point it at the new model. Its
    // SSE dropped when opencode was killed and reconnects to the new process.
    const stats = session.getStats();
    if (stats) stats.setModel(lastConfig.model);
    history.addModel(session.getCurrentRunId(), lastConfig.model);
    res.json({ ok: true, model: lastConfig.model });
  });

  // Re-attach to an in-progress (or finished) pipeline run: replay current state,
  // then stream subsequent events so a reopened wizard follows it to completion.
  app.get('/api/run/stream', (req, res) => {
    session.runSSE.attach(req, res, { type: 'state', state: session.publicRunState() });
  });
};
