'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { FRAMEWORKS, APP_PORT, subst } from '../frameworks.ts';
import { translate } from '../mcp-translate.ts';
import { discoverRoutes } from '../capture/route-discovery.ts';
import { shoot } from '../capture/screenshots.ts';
import { parseOpencodeStats } from '../capture/usage.ts';
import {
  APP_DIR, LOG_DIR, OPENCODE_PORT, AGENT_TIMEOUT_MS, APP_READY_TIMEOUT_MS, MCP_COMMAND_BY_CLASS,
  LOCAL_SKILLS_DIR,
} from '../config.ts';
import { run, capture, type RunOpts } from '../proc/exec.ts';
import { spawnWatcher, killWatcher } from '../proc/watcher.ts';
import { waitForPort, waitForPortFree, waitForAppReady } from '../proc/ports.ts';
import { ensureDirs, sleep, rmrf } from '../proc/fsutil.ts';
import { writeOpencodeConfig, providerEnvFor, writePrepareFile } from './opencode-config.ts';
import { classify } from './mcp-classify.ts';
import { pruneSkills, overlaySkills } from './skills.ts';
import { cleanupAppDir } from '../matrix/cleanup.ts';
import type { RunConfig, Emit, InteractiveResult, HeadlessResult, Stats } from '../types.ts';

export interface PipelineOpts {
  emit: Emit;
  headless?: boolean;
  prompt?: string | null;
  dataDir?: string | null;
  artifactDir?: string | null;
  onChild?: ((child: ChildProcess) => void) | null;
  appDir?: string;
}

// Stages 1–4b are identical for an interactive session and a headless matrix entry.
// Stage 5+ branches: interactive launches `opencode web` (long-lived); headless runs
// `opencode run "<prompt>"` once, parses usage, then screenshots every route.
// Returns interactive: { appPort, opencodePort }
//         headless:    { appPort, stats, screenshots, routes, skipped }
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless?: false }): Promise<InteractiveResult>;
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless: true }): Promise<HeadlessResult>;
export async function runPipeline(
  cfg: RunConfig,
  { emit, headless = false, prompt = null, dataDir = null, artifactDir = null, onChild = null, appDir = APP_DIR }: PipelineOpts,
): Promise<InteractiveResult | HeadlessResult> {
  const fw = FRAMEWORKS[cfg.framework];
  if (!fw) throw new Error(`unknown framework: ${cfg.framework}`);

  // Report every spawned child to `onChild` (matrix cancel kills whatever is current)
  // so Cancel works during scaffold/npm-install too, not only the agent step.
  const runStep = (cmd: string, argv: string[], cwd: string, e: Emit, opts: RunOpts = {}) =>
    run(cmd, argv, cwd, e, { ...opts, onChild });

  ensureDirs();
  // Clean any previous attempt. In matrix mode `appDir` is unique per entry, so
  // this is a no-op there; await the watchers' exit first so their file handles
  // are released before we delete (else rmrf races a dying dev server).
  await killWatcher('app'); await killWatcher('opencode');
  await rmrf(appDir);

  // 1. Scaffold
  emit('step', { step: 'scaffold' });
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  const vars = { name: 'app', dir: appDir, type: cfg.projectType || '', theme: cfg.theme || '', port: APP_PORT };
  await runStep(fw.scaffold.cmd, subst(fw.scaffold.argv, vars), path.dirname(appDir), emit);

  // Drop any framework-specific files into the fresh project (e.g. Blazor's
  // Directory.Build.props that relocates obj/bin off the bind mount).
  for (const [rel, body] of Object.entries(fw.prepare || {})) {
    writePrepareFile(path.join(appDir, rel), subst([body], vars)[0], emit, appDir);
  }

  // 1b. Post-scaffold package install (e.g. ag-grid packages into a plain Vite project).
  if (fw.install && fw.install.length) {
    emit('log', `installing packages: ${fw.install.join(' ')}`);
    await runStep('npm', ['install', ...fw.install], appDir, emit);
  }

  // 2. AI config — branches on the framework's configure strategy.
  emit('step', { step: 'configure' });
  const configureStrategy = fw.configure ?? 'igniteui';

  if (configureStrategy === 'igniteui') {
    // Existing IgniteUI flow: ig ai-config writes .vscode/mcp.json + .claude/skills/.
    const agents = cfg.skills ? ['claude'] : ['none'];
    await runStep('ig', [
      'ai-config',
      '--framework', fw.aiFramework,
      '--agents', ...agents,
      '--assistants', 'vscode',
    ], appDir, emit);

  } else if (configureStrategy === 'aggrid') {
    // ag-grid flow: write .vscode/mcp.json directly with the ag-mcp entry, then
    // optionally install official ag-grid skills via `npx skills add ag-grid/skills`.
    const vscodeMcpDir = path.join(appDir, '.vscode');
    fs.mkdirSync(vscodeMcpDir, { recursive: true });
    const agMcpConfig = {
      servers: {
        'ag-mcp': { type: 'stdio', command: 'npx', args: ['ag-mcp'] },
      },
    };
    fs.writeFileSync(path.join(vscodeMcpDir, 'mcp.json'), JSON.stringify(agMcpConfig, null, 2));
    emit('log', 'wrote .vscode/mcp.json with ag-mcp entry');

    if (cfg.skills) {
      // Ensure .claude/skills/ exists before the skills CLI tries to write into it.
      const skillsDir = path.join(appDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      emit('log', 'installing ag-grid skills (npx skills add ag-grid/skills)');
      await runStep('npx', ['--yes', 'skills', 'add', 'ag-grid/skills'], appDir, emit);
    }

  } else {
    // 'none': write a bare opencode.json now (no MCPs, no skills) and skip translate.
    writeOpencodeConfig(cfg, {}, appDir);
    emit('log', 'configure=none: wrote bare opencode.json, skipping translate');
  }

  // 3. Translate .vscode/mcp.json -> opencode.json (with MCP toggles).
  // Skipped for configure='none' (opencode.json already written above).
  if (configureStrategy !== 'none') {
    emit('step', { step: 'translate' });
    let vscodeMcp: any = {};
    const mcpPath = path.join(appDir, '.vscode', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      vscodeMcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } else {
      emit('log', 'no .vscode/mcp.json found; continuing with empty MCP set');
    }
    // The user toggles MCPs by class (igniteui / theming / angular / aggrid); `classify`
    // maps each server with explicit precedence. Only classes the caller explicitly
    // selected are enabled — everything else stays off, so a variant with no MCPs is a
    // true clean baseline.
    const selected = new Set((cfg.enabledMcps || []).map((t) => t.toLowerCase()));
    const servers = (vscodeMcp && vscodeMcp.servers) || {};
    const enabled = new Set<string>();
    const classByName: Record<string, string> = {};
    for (const [name, s] of Object.entries(servers)) {
      const cls = classify(name, s);
      classByName[name] = cls;
      const on = selected.has(cls);
      if (on) enabled.add(name);
      emit('log', `mcp "${name}" → ${cls} → ${on ? 'enabled' : 'disabled'}`);
    }
    const { mcp, warnings } = translate(vscodeMcp, { enabled, workspaceFolder: appDir });
    warnings.forEach((w) => emit('log', `warning: ${w}`));
    // Rewrite `npx` invocations that cold-fetch from npm to globally-installed bins
    // (ig mcp, igniteui-theming-mcp, ag-mcp).
    for (const [name, def] of Object.entries(mcp)) {
      const fix = MCP_COMMAND_BY_CLASS[classByName[name]];
      if (fix && def.type === 'local') {
        def.command = fix.slice();
        emit('log', `mcp "${name}" command → ${fix.join(' ')}`);
      }
    }
    writeOpencodeConfig(cfg, mcp, appDir);
    emit('log', `opencode.json written (${Object.keys(mcp).length} MCP servers, ${[...enabled].length} enabled)`);
  } // end if (configureStrategy !== 'none')

  // 4. Prune deselected skills (IgniteUI only — ag-grid skills have no per-skill exclusion).
  if (configureStrategy === 'igniteui' && cfg.skills && Array.isArray(cfg.excludedSkills) && cfg.excludedSkills.length) {
    emit('step', { step: 'prune' });
    pruneSkills(cfg.excludedSkills, emit, appDir);
  }

  // 4b. Overlay host-supplied local skills onto the generated set (after prune so an
  // override can't be pruned away). Local skills are organized per-platform, so only
  // this run's framework subfolder is used. replaceAll wipes the generated skills first.
  if (cfg.overrideSkills) {
    emit('step', { step: 'overlay-skills' });
    overlaySkills(path.join(LOCAL_SKILLS_DIR, cfg.framework), appDir, emit, { replaceAll: !!cfg.localSkillsOnly });
  }

  // 5. Interactive only: launch the app dev server now (watch) and hand off the
  // live app. In headless/matrix mode we deliberately do NOT start the dev server
  // here — running it during the agent's edits triggers constant rebuilds across
  // the slow bind mount. We build the app once, after the agent, just to screenshot.
  if (!headless) {
    emit('step', { step: 'launch-app' });
    spawnWatcher('app', fw.dev.cmd, subst(fw.dev.argv, vars), appDir, fw.dev.env || {});
    try {
      await waitForPort(APP_PORT, 180000, emit);
      emit('log', `app is serving on :${APP_PORT}`);
    } catch (e: any) {
      emit('log', `app not confirmed ready (${e.message}); check logs/app.log`);
    }

    // 6a. Interactive: launch opencode web and hand off.
    emit('step', { step: 'launch-opencode' });
    const ocEnv = providerEnvFor(cfg.model, cfg.apiKey);
    if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
    spawnWatcher('opencode', 'opencode',
      ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)], appDir, ocEnv);
    await waitForPort(OPENCODE_PORT, 60000, emit);
    return { appPort: APP_PORT, opencodePort: OPENCODE_PORT };
  }

  // 6b. Headless: run the agent once with the prompt — with NO dev server running.
  emit('step', { step: 'agent' });
  const ocEnv = providerEnvFor(cfg.model, cfg.apiKey);
  if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
  // Isolate this entry's opencode storage so `opencode stats` reflects only it.
  if (dataDir) { fs.mkdirSync(dataDir, { recursive: true }); ocEnv.XDG_DATA_HOME = dataDir; }
  emit('log', `agent (one-shot): ${prompt}`);
  // stdin is /dev/null (see run()) so opencode can never block on an interactive
  // prompt (auth / confirmation); heartbeat shows liveness if it streams nothing.
  // Extra args (e.g. a non-interactive/log flag for your opencode version) via env.
  const agentArgv = ['run', ...(process.env.OPENCODE_RUN_ARGS || '').split(' ').filter(Boolean), prompt || ''];
  await runStep('opencode', agentArgv, appDir, emit, {
    env: ocEnv, timeoutMs: AGENT_TIMEOUT_MS, heartbeatMs: 20000,
  });

  // Parse token/cost usage from `opencode stats` (against this entry's data dir).
  let entryStats: Stats | null = null;
  try {
    const text = await capture('opencode', ['stats'], appDir, dataDir ? { XDG_DATA_HOME: dataDir } : null);
    entryStats = parseOpencodeStats(text);
    entryStats.model = cfg.model;
    entryStats.updatedAt = new Date().toISOString();
    if (!entryStats.parsed) emit('log', 'warning: could not parse `opencode stats`; tokens/cost may be incomplete');
  } catch (e: any) {
    emit('log', `warning: opencode stats failed (${e.message})`);
  }

  // 7. Now that edits are done, build the app once and screenshot every route.
  // Bail as soon as the build is known to have failed (the agent's edits often don't
  // compile) instead of waiting out the full timeout, and surface the build errors.
  emit('step', { step: 'launch-app' });
  if (!(await waitForPortFree(APP_PORT, 15000))) {
    emit('log', `warning: port ${APP_PORT} still in use before launch — a prior dev server may not have exited`);
  }
  const appLog = path.join(LOG_DIR, 'app.log');
  const logOffset = fs.existsSync(appLog) ? fs.statSync(appLog).size : 0;
  const appChild = spawnWatcher('app', fw.dev.cmd, subst(fw.dev.argv, vars), appDir, fw.dev.env || {});
  const ready = await waitForAppReady(APP_PORT, APP_READY_TIMEOUT_MS, 'app', logOffset, appChild, emit);
  if (ready.ready) {
    emit('log', `app is serving on :${APP_PORT}`);
  } else {
    emit('log', `app did not start — ${ready.reason}; screenshots will be skipped`);
    if (ready.tail) emit('log', `--- app build output (tail) ---\n${ready.tail}\n--- end ---`);
  }
  emit('step', { step: 'screenshot' });
  if (!ready.ready) {
    await killWatcher('app'); await killWatcher('opencode');
    emit('step', { step: 'cleanup' });
    await cleanupAppDir(appDir, emit);
    return { appPort: APP_PORT, stats: entryStats, screenshots: [], routes: [], skipped: [], appReady: false, appError: ready.reason };
  }
  await sleep(Number(process.env.SCREENSHOT_SETTLE_MS || 5000));
  const disc = discoverRoutes(appDir, cfg.framework);
  emit('log', `routes: ${disc.routes.length} found${disc.skipped.length ? `, ${disc.skipped.length} skipped` : ''}`);
  disc.skipped.forEach((s) => emit('log', `  skip ${s.path} (${s.reason})`));
  let screenshots: HeadlessResult['screenshots'] = [];
  if (disc.routes.length) {
    try {
      screenshots = await shoot(`http://127.0.0.1:${APP_PORT}`, disc.routes, artifactDir || '');
      emit('log', `screenshots: ${screenshots.filter((s) => s.ok).length}/${screenshots.length} captured`);
    } catch (e: any) {
      emit('log', `warning: screenshots failed (${e.message})`);
    }
  }

  // Free the ports before the next matrix entry reuses them.
  await killWatcher('app'); await killWatcher('opencode');
  // Prune heavy regenerable dirs from the kept entry (screenshots already saved).
  emit('step', { step: 'cleanup' });
  await cleanupAppDir(appDir, emit);
  return { appPort: APP_PORT, stats: entryStats, screenshots, routes: disc.routes, skipped: disc.skipped, appReady: true };
}
