'use strict';

const { WIZARD_PORT } = require('./config');
const { ensureDirs } = require('./proc/fsutil');
const history = require('./history');
const app = require('./app');

ensureDirs();

// Settle any records left 'running' by a previous container that stopped mid-run.
try {
  const reaped = history.reapStale();
  if (reaped) console.log(`history: marked ${reaped} stale run(s) as interrupted`);
} catch (e) { console.error(`history reap failed: ${e.message}`); }

app.listen(WIZARD_PORT, '0.0.0.0', () =>
  console.log(`Ignite UI MCP Testbed UI started on port ${WIZARD_PORT} (http://localhost:${WIZARD_PORT})`));
