'use strict';

import type { Express } from 'express';
import { TESTS_DIR } from '../config.ts';
import { FRAMEWORKS } from '../frameworks.ts';
import { sharedTests, frameworkTests } from '../verify/tests.ts';

export default function registerTestsRoutes(app: Express): void {
  // Host-supplied Playwright verification specs, discovered under TESTS_DIR/shared
  // (every platform) + TESTS_DIR/<framework> (per-platform overlay). With ?platform=<fw>
  // returns that platform's collected set; otherwise the shared set + a per-platform map.
  // Lets the wizard/matrix show what the verify stage would run and warn when nothing's there.
  app.get('/api/tests', (req, res) => {
    const platform = typeof req.query.platform === 'string' ? req.query.platform : '';
    const shared = sharedTests();
    if (platform) {
      if (!FRAMEWORKS[platform]) return res.status(400).json({ ok: false, error: `unknown platform: ${platform}` });
      const framework = frameworkTests(platform);
      return res.json({ ok: true, dir: TESTS_DIR, platform, shared, framework, total: shared.length + framework.length });
    }
    const byPlatform: Record<string, string[]> = {};
    for (const fw of Object.keys(FRAMEWORKS)) byPlatform[fw] = frameworkTests(fw);
    res.json({ ok: true, dir: TESTS_DIR, shared, byPlatform });
  });
}
