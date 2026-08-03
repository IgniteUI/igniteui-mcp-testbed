'use strict';

import * as fs from 'fs';
import type { Express } from 'express';
import { APP_PORT } from '../frameworks.ts';
import { OPENCODE_PORT, WORK, APP_DIR } from '../config.ts';
import { capture } from '../proc/exec.ts';
import { procs } from '../proc/watcher.ts';
import * as session from '../session.ts';

export default function registerStatsRoutes(app: Express): void {
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
    // Tool usage rides the same channel as a `type:'tools'` frame, so replay the last
    // read too — otherwise a reconnecting client shows no tools until the next tick.
    if (stats?.tools) res.write(`data: ${JSON.stringify({ type: 'tools', tools: stats.tools })}\n\n`);
  });

  // Token usage + cost for this session, straight from `opencode stats`.
  // Returns the plain-text report; the wizard renders it in a <pre>.
  app.get('/api/usage', async (_req, res) => {
    const cwd = fs.existsSync(APP_DIR) ? APP_DIR : WORK;
    try {
      const text = await capture('opencode', ['stats'], cwd);
      res.json({ ok: true, text });
    } catch (err: any) {
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
}
