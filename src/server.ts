'use strict';

import { WIZARD_PORT } from './config.ts';
import { ensureDirs } from './proc/fsutil.ts';
import * as history from './history.ts';
import { loadAll } from './provider-registry.ts';
import app from './app.ts';

ensureDirs();

// Load any provider packs (3rd-party library configs) from the /providers bind mount.
try { loadAll(); } catch (e: any) { console.error(`provider-registry load failed: ${e.message}`); }

// Settle any records left 'running' by a previous container that stopped mid-run.
try {
  const reaped = history.reapStale();
  if (reaped) console.log(`history: marked ${reaped} stale run(s) as interrupted`);
} catch (e: any) { console.error(`history reap failed: ${e.message}`); }

app.listen(WIZARD_PORT, '0.0.0.0', () =>
  console.log(`Ignite UI MCP Testbed UI started on port ${WIZARD_PORT} (http://localhost:${WIZARD_PORT})`));
