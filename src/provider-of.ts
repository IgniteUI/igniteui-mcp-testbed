'use strict';

// Which provider a history record ran on. Records written before `config.provider`
// existed fall back to the pack provenance (phase 1d), then to Ignite UI, which is what
// every record from before provider packs was.
//
// Dependency-free: the bundled frontend, the Node backend and scripts/compare-runs.mjs
// all import it.
export function providerOf(config: { provider?: string | null; pack?: { name?: string } | null } | null | undefined): string {
  return config?.provider || config?.pack?.name || 'igniteui';
}
