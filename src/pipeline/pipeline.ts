'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { APP_PORT, subst } from '../frameworks.ts';
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
import { runVerification } from '../verify/tests.ts';
import { cleanupAppDir } from '../matrix/cleanup.ts';
import { getPackForFramework, getFramework } from '../provider-registry.ts';
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
  const fw = getFramework(cfg.framework);
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

  // 1b. Post-scaffold package install (e.g. MUI into a plain Vite project).
  if (fw.install && fw.install.length) {
    emit('log', `installing packages: ${fw.install.join(' ')}`);
    await runStep('npm', ['install', ...fw.install], appDir, emit);
  }

  // 2. AI config — branches on the framework's configure strategy.
  emit('step', { step: 'configure' });
  const configureStrategy = fw.configure ?? 'igniteui';

  if (configureStrategy === 'igniteui') {
    // Existing IgniteUI flow: ig ai-config writes .mcp.json + .agent/skills/.
    const agents = cfg.skills ? ['generic'] : ['none'];
    await runStep('ig', [
      'ai-config',
      '--framework', fw.aiFramework,
      '--agents', ...agents,
      '--assistants', 'generic',
    ], appDir, emit);

  } else if (configureStrategy === 'external') {
    // External provider flow: driven entirely by the ProviderPack definition.
    // Write .mcp.json from the pack's MCP server list, then optionally
    // clone + copy the pack's skills from GitHub. opencode.json is written here
    // directly (no translate step needed — the pack supplies correct commands).
    const pack = getPackForFramework(cfg.framework);
    if (!pack) throw new Error(`no provider pack found for framework "${cfg.framework}" — is the pack loaded?`);

    // Write .mcp.json at the project root (used as a record; opencode.json is
    // written below), in the standard shape: servers under `mcpServers`.
    // Object.create(null) gives a null-prototype object so writing '__proto__' is
    // harmless (it becomes a plain enumerable key rather than the prototype setter).
    // The explicit forbidden-key guard is the barrier CodeQL requires to resolve
    // js/remote-property-injection — Object.fromEntries() is not recognised.
    const packServers: Record<string, any> = Object.create(null);
    for (const s of pack.configure.mcpServers) {
      if (s.name !== '__proto__' && s.name !== 'constructor' && s.name !== 'prototype') {
        packServers[s.name] = { type: 'stdio', command: s.command, args: s.args || [] };
      }
    }
    fs.writeFileSync(path.join(appDir, '.mcp.json'), JSON.stringify({ mcpServers: packServers }, null, 2));
    emit('log', `wrote .mcp.json (${Object.keys(packServers).length} server(s) from pack "${pack.name}")`);

    // Optionally install skills.
    if (cfg.skills) {
      const skillsDir = path.join(appDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      const skillsConf = pack.configure.skills;
      if (skillsConf?.github) {
        // Clone the GitHub repo and copy every top-level skill folder.
        // Validate the ref before embedding it in a git argument to prevent
        // second-order command injection (e.g. "--upload-pack=malicious").
        const githubRef = skillsConf.github;
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(githubRef)) {
          throw new Error(`invalid skills.github value "${githubRef}" — expected "owner/repo" with only safe characters`);
        }
        const tmpDir = fs.mkdtempSync(path.join('/tmp', 'skills-clone-'));
        emit('log', `cloning skills from github.com/${githubRef}`);
        await runStep('git', ['clone', '--depth', '1', `https://github.com/${githubRef}.git`, tmpDir], appDir, emit);
        let count = 0;
        for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          fs.cpSync(path.join(tmpDir, entry.name), path.join(skillsDir, entry.name), { recursive: true });
          count++;
        }
        emit('log', `installed ${count} skill(s) from github.com/${githubRef}`);
        await rmrf(tmpDir);
      } else if (skillsConf?.installCommand?.length) {
        const [cmd, ...args] = skillsConf.installCommand;
        emit('log', `installing skills: ${[cmd, ...args].join(' ')}`);
        await runStep(cmd, args, skillsDir, emit);
      }
    }

    // Write opencode.json directly — pack commands are already correct,
    // so the translate step is not needed.
    const selected = new Set((cfg.enabledMcps || []).map((t) => t.toLowerCase()));
    // Null-prototype object + explicit forbidden-key guard: same pattern as vsServers
    // above. The guard is the barrier CodeQL needs to close js/remote-property-injection.
    const mcpBlock: Record<string, any> = Object.create(null);
    for (const s of pack.configure.mcpServers) {
      const on = selected.has(s.class.toLowerCase());
      // Sanitize server name and class before emitting to logs (CodeQL js/log-injection).
      const safeName = s.name.replace(/[\r\n]/g, ' ');
      const safeClass = s.class.replace(/[\r\n]/g, ' ');
      emit('log', `mcp "${safeName}" → class "${safeClass}" → ${on ? 'enabled' : 'disabled'}`);
      if (on && s.name !== '__proto__' && s.name !== 'constructor' && s.name !== 'prototype') {
        mcpBlock[s.name] = { type: 'local', command: [s.command, ...(s.args || [])] };
      }
    }
    // Custom MCP servers are provider-agnostic: inject them on top of any pack's MCPs
    // when the 'custom' class is enabled. Uses translate() to convert from the
    // .mcp.json server format to opencode format.
    if (selected.has('custom') && cfg.customMcp?.trim()) {
      try {
        const parsed = JSON.parse(cfg.customMcp);
        const isServerDef = (o: any) => o && typeof o === 'object' && (o.command || o.url);
        const rawCustom: Record<string, any> =
          parsed?.servers && typeof parsed.servers === 'object' ? parsed.servers :
          parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers :
          isServerDef(parsed) ? { custom: parsed } :
          parsed;
        const tempMcpDoc: any = { servers: {} };
        for (const [rawName, def] of Object.entries(rawCustom || {})) {
          let key = 'custom-' + rawName, n = 1;
          while (Object.prototype.hasOwnProperty.call(tempMcpDoc.servers, key)) key = `custom-${rawName}-${n++}`;
          tempMcpDoc.servers[key] = def;
        }
        const { mcp: customMcp } = translate(tempMcpDoc, {
          enabled: new Set(Object.keys(tempMcpDoc.servers)),
          workspaceFolder: appDir,
        });
        for (const [name, def] of Object.entries(customMcp)) {
          if (name !== '__proto__' && name !== 'constructor' && name !== 'prototype') {
            mcpBlock[name] = def;
          }
          emit('log', `mcp "${name}" → custom → enabled`);
        }
      } catch (e: any) {
        emit('log', `warning: could not parse custom MCP JSON (${e.message}); skipped`);
      }
    }
    writeOpencodeConfig(cfg, mcpBlock, appDir);
    emit('log', `opencode.json written (${Object.keys(mcpBlock).length} MCP server(s) enabled)`);

  } else {
    // 'none': write a bare opencode.json now (no MCPs, no skills) and skip translate.
    writeOpencodeConfig(cfg, {}, appDir);
    emit('log', 'configure=none: wrote bare opencode.json, skipping translate');
  }

  // 3. Translate .mcp.json -> opencode.json (IgniteUI only).
  // The 'external' strategy already wrote opencode.json in step 2.
  // The 'none' strategy wrote a bare opencode.json in step 2 as well.
  if (configureStrategy === 'igniteui') {
    emit('step', { step: 'translate' });
    let mcpDoc: any = {};
    const mcpPath = path.join(appDir, '.mcp.json');
    const legacyMcpPath = path.join(appDir, '.vscode', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      mcpDoc = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } else if (fs.existsSync(legacyMcpPath)) {
      // Older igniteui-cli versions wrote the VS Code file instead.
      mcpDoc = JSON.parse(fs.readFileSync(legacyMcpPath, 'utf8'));
      emit('log', 'no .mcp.json found; using legacy .vscode/mcp.json');
    } else {
      emit('log', 'no .mcp.json found; continuing with empty MCP set');
    }
    // Normalize: the standard .mcp.json wraps servers in `mcpServers`, the legacy
    // VS Code file in `servers`. Everything downstream works on the `servers` map.
    mcpDoc.servers = mcpDoc.servers || mcpDoc.mcpServers || {};
    // Inject user-supplied custom MCP servers (pasted JSON) into mcpDoc before classify/translate.
    const customNames = new Set<string>();
    if (cfg.customMcp && cfg.customMcp.trim()) {
      try {
        const parsed = JSON.parse(cfg.customMcp);
        const isServerDef = (o: any) => o && typeof o === 'object' && (o.command || o.url);
        const customServers: Record<string, any> =
          (parsed && parsed.servers && typeof parsed.servers === 'object') ? parsed.servers :
          (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers :
          isServerDef(parsed) ? { custom: parsed } :
          parsed;
        // rawName is attacker/user-controlled (pasted JSON). Per CodeQL's guidance for
        // js/remote-property-injection, a fixed non-empty marker prefix is prepended
        // before the untrusted string is ever used as an object property key. This
        // guarantees the resulting key can never equal a dangerous name such as
        // "__proto__" / "constructor" / "prototype", closing off prototype pollution
        // regardless of what the pasted JSON contains.
        for (const [rawName, def] of Object.entries(customServers || {})) {
          let key = 'custom-' + rawName, n = 1;
          while (Object.prototype.hasOwnProperty.call(mcpDoc.servers, key)) key = `custom-${rawName}-${n++}`;
          mcpDoc.servers[key] = def;
          customNames.add(key);
        }
      } catch (e: any) {
        emit('log', `warning: could not parse custom MCP JSON (${e.message}); skipped`);
      }
    }
    // The user toggles MCPs by class (igniteui / theming / angular / custom); `classify`
    // maps each server with explicit precedence. Only classes the caller explicitly
    // selected are enabled — everything else stays off, so a variant with no MCPs is a
    // true clean baseline.
    const selected = new Set((cfg.enabledMcps || []).map((t) => t.toLowerCase()));
    const servers = mcpDoc.servers;
    const enabled = new Set<string>();
    const classByName: Record<string, string> = {};
    for (const [name, s] of Object.entries(servers)) {
      const cls = customNames.has(name) ? 'custom' : classify(name, s);
      classByName[name] = cls;
      const on = selected.has(cls);
      if (on) enabled.add(name);
      emit('log', `mcp "${name}" → ${cls} → ${on ? 'enabled' : 'disabled'}`);
    }
    const { mcp, warnings } = translate(mcpDoc, { enabled, workspaceFolder: appDir });
    warnings.forEach((w) => emit('log', `warning: ${w}`));
    // Rewrite `npx` invocations that cold-fetch from npm to globally-installed bins
    // (ig mcp, igniteui-theming-mcp).
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

  // 4. Prune deselected skills (IgniteUI only).
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
  emit('log', `routes: ${disc.routes.length} found${disc.skipped.length ? `, ${disc.skipped.length} skipped` : ''}${disc.stateNav ? ' (state-nav, will click through)' : ''}`);
  disc.skipped.forEach((s) => emit('log', `  skip ${s.path} (${s.reason})`));
  // When no routes are discovered (e.g. a plain Vite React app with no router, or an
  // Angular app whose routes array is still empty after scaffold), fall back to '/' —
  // the app IS serving and at minimum the root page should be captured.
  const routesToShoot = disc.routes.length ? disc.routes : ['/'];
  if (!disc.routes.length) emit('log', 'no routes discovered — falling back to root (/)');
  let screenshots: HeadlessResult['screenshots'] = [];
  try {
    screenshots = await shoot(`http://127.0.0.1:${APP_PORT}`, routesToShoot, artifactDir || '', { stateNav: disc.stateNav });
    emit('log', `screenshots: ${screenshots.filter((s) => s.ok).length}/${screenshots.length} captured`);
  } catch (e: any) {
    emit('log', `warning: screenshots failed (${e.message})`);
  }

  // 7b. Verify: run the injected Playwright tests against the serving app (app must
  // still be up, so this runs before the watchers are killed). Only the user-selected
  // test files run; returns null (stage skipped) when nothing is selected/found. A
  // failing suite flips the entry to 'test-failed' upstream.
  let tests: HeadlessResult['tests'] = null;
  emit('step', { step: 'verify' });
  try {
    tests = await runVerification({ framework: cfg.framework, appDir, artifactDir, emit, onChild, selectedTests: cfg.selectedTests });
  } catch (e: any) {
    emit('log', `warning: verification stage failed (${e.message})`);
  }

  // Free the ports before the next matrix entry reuses them.
  await killWatcher('app'); await killWatcher('opencode');
  // Prune heavy regenerable dirs from the kept entry (screenshots already saved).
  emit('step', { step: 'cleanup' });
  await cleanupAppDir(appDir, emit);
  return { appPort: APP_PORT, stats: entryStats, screenshots, routes: disc.routes, skipped: disc.skipped, appReady: true, tests };
}
