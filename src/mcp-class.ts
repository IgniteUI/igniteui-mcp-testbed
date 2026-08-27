'use strict';

// One copy of the MCP-class name fold, shared by the backend resolver (src/config.ts)
// and the History re-run check (web/history.ts). Class names may carry characters an env
// var name cannot — classify() yields theming/angular/igniteui/other, the pipeline adds
// `custom`, and a provider pack declares whatever string it likes, so `mui-docs` has to
// reach MCP_CMD_MUI_DOCS. Both sides fold to [a-z0-9_] before matching.
//
// Dependency-free on purpose (same reason as src/status-meta.ts): the esbuild-bundled
// frontend and the Node backend both import it, and the frontend has no Node libs.
export function normMcpClass(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}
