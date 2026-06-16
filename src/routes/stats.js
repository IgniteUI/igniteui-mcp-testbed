'use strict';

const fs = require('fs');
const { APP_PORT } = require('../frameworks');
const { OPENCODE_PORT, WORK, APP_DIR } = require('../config');
const { capture } = require('../proc/exec');
const { procs } = require('../proc/watcher');
const session = require('../session');

module.exports = function registerStatsRoutes(app) {
  // Structured live stats for the current session (messages / tokens / cost).
  app.get('/api/stats', (_req, res) => {
    const stats = session.getStats();
    if (!stats) return res.json({ ok: true, stats: null });
    res.json({ ok: true, stats: stats.snapshot() });
  });

  // Push stats to the wizard in real time as the collector updates stats.json.
  app.get('/api/stats/stream', (req, res) => {
    const stats = session.getStats();
    session.statsSSE.attach(req, res, stats ? stats.snapshot() : undefined);
  });

  // Token usage + cost for this session, straight from `opencode stats`.
  // Returns the plain-text report; the wizard renders it in a <pre>.
  app.get('/api/usage', async (_req, res) => {
    const cwd = fs.existsSync(APP_DIR) ? APP_DIR : WORK;
    try {
      const text = await capture('opencode', ['stats'], cwd);
      res.json({ ok: true, text });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/status', (_req, res) => {
    const lastConfig = session.getLastConfig();
    res.json({
      app: !!procs.app && !procs.app.killed,
      opencode: !!procs.opencode && !procs.opencode.killed,
      appPort: APP_PORT,
      opencodePort: OPENCODE_PORT,
      model: lastConfig && lastConfig.model,
      phase: session.getRunState().phase,
    });
  });
};
