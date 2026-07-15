'use strict';

import type { FrameworkDef, ScaffoldDef } from './types.ts';

/**
 * Per-framework command definitions.
 *
 * This is intentionally the ONE place you tweak when your CLI's generated
 * scripts differ from the assumptions below. Each entry describes, for a given
 * framework, how to (a) scaffold the project and (b) start its dev server in
 * watch mode bound to 0.0.0.0:<APP_PORT> so the container's published port works.
 *
 * `argv` placeholders get substituted at runtime:
 *   {{name}}   project folder name
 *   {{type}}   project type (--type for `ig new`)
 *   {{theme}}  style theme (--theme for `ig new`)
 *   {{dir}}    absolute project directory
 *   {{port}}   APP_PORT (the dev-server port the container publishes)
 */

export const APP_PORT = Number(process.env.APP_PORT || 5000);
// dotnet template short name registered by the IgniteUI.Blazor.Templates package
// ("Blazor Web App (IgniteUI)" → `igb-blazor`; verify with `dotnet new list`).
const TEMPLATE = process.env.BLAZOR_TEMPLATE || 'igb-blazor';

// Frameworks scaffolded by the Ignite UI CLI (`ig new`).
function igNew(framework: string): ScaffoldDef {
  return {
    cmd: 'ig',
    argv: [
      'new', '{{name}}',
      `--framework=${framework}`,
      '--type={{type}}',
      '--theme={{theme}}',
      '--skip-git',
    ],
    // `ig new` creates ./<name>; scaffold runs from the parent of {{dir}}.
    cwdIsParent: true,
  };
}

export const FRAMEWORKS: Record<string, FrameworkDef> = {
  angular: {
    scaffold: igNew('angular'),
    aiFramework: 'angular',
    // `ng` isn't global in the container; npx resolves the local node_modules/.bin/ng.
    // `--poll`: inotify doesn't fire across the Podman bind mount, so the watcher
    // must poll or edits never trigger a rebuild (stale routes / no hot reload).
    dev: { cmd: 'npx', argv: ['ng', 'serve', '--host', '0.0.0.0', '--port', '{{port}}', '--poll', '1500'] },
  },

  react: {
    scaffold: igNew('react'),
    aiFramework: 'react',
    // Vite — the ig-scaffolded React app exposes the dev server as `start`, not `dev`.
    // Polling env: inotify doesn't fire across the Podman bind mount, so Vite's
    // chokidar watcher must poll or edits never hot-reload.
    // `--strictPort`: without it Vite silently moves to the next free port if {{port}}
    // is taken (e.g. a prior matrix entry's server lingering), and we'd then screenshot
    // that stale server on the fixed port. strictPort makes Vite fail instead.
    dev: {
      cmd: 'npm', argv: ['run', 'start', '--', '--host', '0.0.0.0', '--port', '{{port}}', '--strictPort'],
      env: { CHOKIDAR_USEPOLLING: 'true', CHOKIDAR_INTERVAL: '1500' },
    },
  },

  webcomponents: {
    scaffold: igNew('webcomponents'),
    aiFramework: 'webcomponents',
    // Vite/web-dev-server exposed as the `start` script. Same bind-mount polling fix.
    // `--strictPort`: fail rather than silently hop to another port (see react above).
    dev: {
      cmd: 'npm', argv: ['run', 'start', '--', '--host', '0.0.0.0', '--port', '{{port}}', '--strictPort'],
      env: { CHOKIDAR_USEPOLLING: 'true', CHOKIDAR_INTERVAL: '1500' },
    },
  },

  blazor: {
    // No `ig new` here. The igb-blazor template always nests the project as
    // <output>/<name>/, so we scaffold from WORK with `-o .` and `-n {{name}}`
    // to land it directly at WORK/<name> (= APP_DIR), matching the other
    // frameworks — keeps ai-config / dev-server cwd on APP_DIR with no nesting.
    // `--IncludeWeatherSample false`: skip the generated Weather page (IgbGridLite +
    // ApexCharts demo) and its model/service so the scaffold is a clean baseline.
    scaffold: {
      cmd: 'dotnet',
      argv: ['new', TEMPLATE, '-o', '.', '-n', '{{name}}', '--force', '--IncludeWeatherSample', 'false'],
      cwdIsParent: true,
    },
    aiFramework: 'blazor',
    // Relocate obj/ and bin/ off the bind mount. inotify doesn't fire across the
    // Windows<->Podman mount (so we force polling below), but dotnet watch's polling
    // watcher crashes enumerating generated files under obj/ ("An item with the same
    // key has already been added" — dotnet/sdk#45455). Moving build output to a
    // container-local path takes obj/bin out of the watched tree and off the slow
    // mount; the outputs are disposable.
    prepare: {
      'Directory.Build.props':
        '<Project>\n' +
        '  <PropertyGroup>\n' +
        '    <BaseIntermediateOutputPath>/tmp/blazor-build/obj/$(MSBuildProjectName)/</BaseIntermediateOutputPath>\n' +
        '    <BaseOutputPath>/tmp/blazor-build/bin/$(MSBuildProjectName)/</BaseOutputPath>\n' +
        '  </PropertyGroup>\n' +
        '</Project>\n',
    },
    // `--no-hot-reload`: hot reload crashes the whole watcher on the kind of
    // half-finished/uncompilable edits the agent makes (HotReloadMSBuildWorkspace
    // bug), taking the dev server down. Plain rebuild-on-save survives bad edits
    // and recovers once the code compiles.
    dev: {
      cmd: 'dotnet', argv: ['watch', '--no-hot-reload', 'run', '--urls', 'http://0.0.0.0:{{port}}'],
      env: { DOTNET_USE_POLLING_FILE_WATCHER: 'true' },
    },
  },
};

// ── External provider frameworks ──────────────────────────────────────────────
// Additional frameworks (e.g. 3rd party UI frameworks) are loaded at runtime from ProviderPack
// JSON files by src/provider-registry.ts.  They are inserted into FRAMEWORKS by
// registerPack() and carry configure: 'external' so the pipeline drives them
// through the pack's MCP server list and skills config instead of ig ai-config.
// Do NOT add 3rd-party framework entries here — put them in a pack file under
// 3rdPartyConfigurations/ and they will be picked up automatically.

export function subst(argv: string[], vars: Record<string, string | number | undefined>): string[] {
  return argv.map((a) =>
    a.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')));
}
