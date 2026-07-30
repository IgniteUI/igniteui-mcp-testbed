'use strict';

import { MATRIX_CONFIG, WIZARD_PORT } from './config.ts';
import { ensureDirs } from './proc/fsutil.ts';
import * as history from './history.ts';
import { attachConsoleMirror } from './matrix/console-mirror.ts';
import { loadMatrixConfig, startAutoRun, type LoadedMatrixConfig } from './matrix/matrix-config.ts';
import { loadAll } from './provider-registry.ts';
import app from './app.ts';

ensureDirs();

// Load any provider packs (3rd-party library configs) from the /providers bind mount.
try { loadAll(); } catch (e: any) { console.error(`provider-registry load failed: ${e.message}`); }

// Validate-only mode (./run.sh --matrix-config <file> --validate): load + validate the
// config, print what it resolves to, and exit — no server started and no history
// records modified (runs before the history reap). Exit 0 = valid, 1 = invalid, 2 = misuse.
if (process.env.MATRIX_VALIDATE === '1') {
  if (!MATRIX_CONFIG) {
    console.error('MATRIX_VALIDATE is set but no MATRIX_CONFIG file is configured');
    process.exit(2);
  }
  try {
    const c = loadMatrixConfig(MATRIX_CONFIG);
    const { req } = c;
    console.log(`matrix config OK: ${req.combos.length} entries (${req.platforms.join(', ')} × ${req.variants.length} variant(s))`);
    if (req.name) console.log(`  name       : ${req.name}`);
    console.log(`  model      : ${req.fixed.model}`);
    console.log(`  api key    : ${req.fixed.apiKey ? 'resolved' : 'none (fine for keyless providers)'}`);
    console.log(`  tests      : ${req.fixed.selectedTests ? `${req.fixed.selectedTests.length} selected` : 'all discovered'}`);
    console.log(`  images     : ${req.fixed.promptImages?.length ? req.fixed.promptImages.join(', ') : 'none'}`);
    console.log(`  autoRun    : ${c.autoRun} · exitOnDone: ${c.exitOnDone}`);
    for (const w of c.warnings) console.warn(`  warning    — ${w}`);
    process.exit(0);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

// Settle any records left 'running' by a previous container that stopped mid-run.
try {
  const reaped = history.reapStale();
  if (reaped) console.log(`history: marked ${reaped} stale run(s) as interrupted`);
} catch (e: any) { console.error(`history reap failed: ${e.message}`); }

// A MATRIX_CONFIG file (terminal-driven matrix) is loaded before listen and fails
// fast: a user who authored a config wants it honored, and the CI path (exitOnDone)
// must fail loudly rather than start an idle wizard.
let matrixConfig: LoadedMatrixConfig | null = null;
if (MATRIX_CONFIG) {
  try {
    matrixConfig = loadMatrixConfig(MATRIX_CONFIG);
    const { req, autoRun } = matrixConfig;
    console.log(
      `matrix config loaded from ${MATRIX_CONFIG}: ${req.combos.length} entries ` +
      `(${req.platforms.join(', ')} × ${req.variants.length} variant(s))${autoRun ? ' — auto-run' : ''}`);
    for (const w of matrixConfig.warnings) console.warn(`matrix config: warning — ${w}`);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

// Terminal-driven runs watch stdout, not the UI — mirror matrix progress there.
// MATRIX_CONSOLE=1 forces it on for any run (e.g. to follow a UI-submitted matrix
// via `podman logs`).
if (matrixConfig || process.env.MATRIX_CONSOLE === '1') {
  attachConsoleMirror({ exitOnDone: matrixConfig?.exitOnDone ?? false });
}

app.listen(WIZARD_PORT, '0.0.0.0', () => {
  console.log(`Ignite UI MCP Testbed UI started on port ${WIZARD_PORT} (http://localhost:${WIZARD_PORT})`);
  // Auto-run fires after listen so the SSE/status endpoints are live the moment
  // entries start streaming.
  if (matrixConfig?.autoRun) startAutoRun();
});
