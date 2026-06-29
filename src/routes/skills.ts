'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Express } from 'express';
import { LOCAL_SKILLS_DIR } from '../config.ts';
import { FRAMEWORKS } from '../frameworks.ts';

// List the SKILL.md-bearing subfolders of one platform's local-skills dir.
function listPlatform(platform: string): { name: string; valid: boolean }[] {
  const dir = path.join(LOCAL_SKILLS_DIR, platform);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, valid: fs.existsSync(path.join(dir, d.name, 'SKILL.md')) }));
  } catch (_) {
    return []; // dir absent (no bind mount / nothing supplied for this platform)
  }
}

export default function registerSkillsRoutes(app: Express): void {
  // Host-supplied skills available to overlay, organized per-platform under
  // LOCAL_SKILLS_DIR/<framework>/<skill>/ (bind-mounted at /local-skills). With
  // ?platform=<fw> returns that platform's list; otherwise a map of every platform.
  // Lets the wizard/matrix show what's there and warn when nothing is supplied.
  app.get('/api/local-skills', (req, res) => {
    const platform = typeof req.query.platform === 'string' ? req.query.platform : '';
    if (platform) {
      if (!FRAMEWORKS[platform]) return res.status(400).json({ ok: false, error: `unknown platform: ${platform}` });
      return res.json({ ok: true, dir: path.join(LOCAL_SKILLS_DIR, platform), platform, skills: listPlatform(platform) });
    }
    const byPlatform: Record<string, { name: string; valid: boolean }[]> = {};
    for (const fw of Object.keys(FRAMEWORKS)) byPlatform[fw] = listPlatform(fw);
    res.json({ ok: true, dir: LOCAL_SKILLS_DIR, byPlatform });
  });
}
