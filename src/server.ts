'use strict';

import { MATRIX_CONFIG, WIZARD_PORT } from './config.ts';
import { ensureDirs } from './proc/fsutil.ts';
import * as history from './history.ts';
import { loadMatrixConfig, startAutoRun, type LoadedMatrixConfig } from './matrix/matrix-config.ts';
import app from './app.ts';

ensureDirs();

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

app.listen(WIZARD_PORT, '0.0.0.0', () => {
  console.log(`Ignite UI MCP Testbed UI started on port ${WIZARD_PORT} (http://localhost:${WIZARD_PORT})`);
  // Auto-run fires after listen so the SSE/status endpoints are live the moment
  // entries start streaming.
  if (matrixConfig?.autoRun) startAutoRun();
});
