'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { APP_PORT, subst } from '../frameworks.ts';
import { translate } from '../mcp-translate.ts';
import { discoverRoutes } from '../capture/route-discovery.ts';
import { shoot } from '../capture/screenshots.ts';
import { parseOpencodeStats } from '../capture/usage.ts';
import { collectToolUsage, installedSkills, summarizeToolUsage } from '../capture/tool-usage.ts';
import {
  APP_DIR, LOG_DIR, OPENCODE_PORT, AGENT_TIMEOUT_MS, APP_READY_TIMEOUT_MS, MCP_COMMAND_BY_CLASS,
  LOCAL_SKILLS_DIR, OPENCODE_DATA_DIR, RATE_LIMIT_PATTERN,
} from '../config.ts';
import { run, capture, terminateTree, type RunOpts } from '../proc/exec.ts';
import { spawnWatcher, killWatcher } from '../proc/watcher.ts';
import { waitForPort, waitForPortFree, waitForAppReady } from '../proc/ports.ts';
import { ensureDirs, sleep, rmrf } from '../proc/fsutil.ts';
import { writeOpencodeConfig, providerEnvFor, writePrepareFile } from './opencode-config.ts';
import { classify } from './mcp-classify.ts';
import { stageImages } from '../prompt-images.ts';
import { pruneSkills, overlaySkills, stripGeneratedAgentConfig } from './skills.ts';
import { runVerification } from '../verify/tests.ts';
import { cleanupAppDir } from '../matrix/cleanup.ts';
import { getPackForFramework, getFramework } from '../provider-registry.ts';
import type { RunConfig, Emit, InteractiveResult, HeadlessResult, Stats, ToolContext } from '../types.ts';

export interface PipelineOpts {
  emit: Emit;
  headless?: boolean;
  prompt?: string | null;
  dataDir?: string | null;
  artifactDir?: string | null;
  onChild?: ((child: ChildProcess) => void) | null;
  appDir?: string;
  // Called once the agent is about to start, with what the tool-usage collector needs
  // to scope a read to this run. Headless mode collects for itself (the agent is a
  // one-shot); an interactive session hands this to the StatsCollector, which keeps
  // polling for as long as `opencode web` is up. See src/capture/tool-usage.ts.
  onToolContext?: ((ctx: ToolContext) => void) | null;
}

// Servers opencode will actually expose tools from: `translate` keeps deselected
// servers in the block with `enabled:false`, and those tools never reach the agent.
const activeMcpServers = (block: Record<string, any>): string[] =>
  Object.entries(block).filter(([, def]) => !def || def.enabled !== false).map(([name]) => name);

// RATE_LIMIT_PATTERN is env-overridable (see config.ts) so a bad override can't crash
// the pipeline — fall back to a literal match of the configured text.
const RATE_LIMIT_RE = (() => {
  try { return new RegExp(RATE_LIMIT_PATTERN, 'i'); }
  catch (_) { return new RegExp(RATE_LIMIT_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
})();

// Stages 1–4b are identical for an interactive session and a headless matrix entry.
// Stage 5+ branches: interactive launches `opencode web` (long-lived); headless runs
// `opencode run "<prompt>"` once, parses usage, then screenshots every route.
// Returns interactive: { appPort, opencodePort }
//         headless:    { appPort, stats, screenshots, routes, skipped }
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless?: false }): Promise<InteractiveResult>;
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless: true }): Promise<HeadlessResult>;
export async function runPipeline(
  cfg: RunConfig,
  { emit, headless = false, prompt = null, dataDir = null, artifactDir = null, onChild = null, appDir = APP_DIR, onToolContext = null }: PipelineOpts,
): Promise<InteractiveResult | HeadlessResult> {
  const fw = getFramework(cfg.framework);
  if (!fw) throw new Error(`unknown framework: ${cfg.framework}`);

  // MCP servers the agent will actually be offered, recorded so the tool-usage report
  // can say which of them were never called. Filled in by whichever configure branch runs.
  let mcpServers: string[] = [];

  // Report every spawned child to `onChild` (matrix cancel kills whatever is current)
  // so Cancel works during scaffold/npm-install too, not only the agent step.
  const runStep = (cmd: string, argv: string[], cwd: string, e: Emit, opts: RunOpts = {}) => {
    const localOnChild = opts.onChild;
    const mergedOnChild = (child: ChildProcess) => {
      if (onChild) onChild(child);
      if (localOnChild) localOnChild(child);
    };
    return run(cmd, argv, cwd, e, { ...opts, onChild: mergedOnChild });
  };

  ensureDirs();
  // Clean any previous attempt. In matrix mode `appDir` is unique per entry, so
  // this is a no-op there; await the watchers' exit first so their file handles
  // are released before we delete (else rmrf races a dying dev server).
  await killWatcher('app'); await killWatcher('opencode');
  await rmrf(appDir);

  // 1. Scaffold
  emit('step', { step: 'scaffold' });
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  // `agents` feeds `ig new --agents=` so the scaffold's built-in ai-config pass honours
  // the skills toggle instead of falling back to the CLI's checkbox defaults.
  const vars = {
    name: 'app', dir: appDir, type: cfg.projectType || '', theme: cfg.theme || '',
    port: APP_PORT, agents: cfg.skills ? 'generic' : 'none',
  };
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
    // Existing IgniteUI flow: ig ai-config writes .mcp.json + .agents/skills/.
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
      const skillsDir = path.join(appDir, '.agents', 'skills');
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
    mcpServers = activeMcpServers(mcpBlock);
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
    mcpServers = activeMcpServers(mcp);
    emit('log', `opencode.json written (${Object.keys(mcp).length} MCP servers, ${[...enabled].length} enabled)`);
  } // end if (configureStrategy !== 'none')

  // 4. Prune skills. With the toggle off, sweep away anything the scaffold or ai-config
  // wrote anyway (the flags above should have prevented it — this is the guarantee, not
  // the mechanism). With it on, drop just the folders the caller deselected.
  if (!cfg.skills) {
    stripGeneratedAgentConfig(appDir, emit);
  } else if (configureStrategy === 'igniteui' && Array.isArray(cfg.excludedSkills) && cfg.excludedSkills.length) {
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

  // 4c. Attach prompt images: stage the selected host-supplied reference images into
  // the project. Headless runs hand the staged copies to `opencode run --file` below;
  // an interactive session gets them in `prompt-images/` to @-mention (or drag into)
  // opencode web, since the wizard has no prompt box of its own.
  let promptImageFiles: string[] = [];
  if (cfg.promptImages && cfg.promptImages.length) {
    emit('step', { step: 'attach-images' });
    promptImageFiles = stageImages(cfg.promptImages, appDir, emit);
    // Reading an image needs a vision-capable model, which in practice means a paid one.
    // No API key (and no custom base URL) ⇒ one of opencode's free hosted models, which
    // have no vision: the attachment is ignored/rejected and the run quietly degrades to
    // a text-only prompt. Warn rather than fail — only the provider knows for sure.
    if (promptImageFiles.length && !cfg.apiKey && !cfg.customBaseUrl) {
      emit('log', 'warning: images attached but no API key — free/keyless models have no vision '
        + 'and will ignore them; use a paid vision-capable model to test image-driven generation');
    }
    if (promptImageFiles.length && !headless) {
      emit('log', `reference these in opencode as ${promptImageFiles
        .map((f) => `@prompt-images/${path.basename(f)}`).join(' ')}`);
    }
  }

  // The skill set is final once prune (4) and overlay (4b) have run, so this is the
  // list to compare against what the agent actually invoked. Both dirs opencode loads
  // from are scanned — with skills off, this is legitimately empty.
  const skillNames = installedSkills(appDir);
  if (skillNames.length || mcpServers.length) {
    emit('log', `agent tooling: ${mcpServers.length} MCP server(s)${mcpServers.length ? ` (${mcpServers.join(', ')})` : ''}, ${skillNames.length} skill(s)`);
  }
  // Everything after this point in the store belongs to this run. An interactive store
  // is shared across /api/run invocations in one container, so the collector needs a
  // floor; a matrix entry's store is already private but the floor is harmless there.
  const toolDataDir = dataDir || OPENCODE_DATA_DIR;
  const agentSince = Date.now();

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
    // An interactive session has no end the pipeline can observe — `opencode web` keeps
    // running and the user keeps prompting — so hand the collection context off to the
    // StatsCollector, which re-reads the store on its reconcile tick.
    if (onToolContext) onToolContext({ dataDir: toolDataDir, since: agentSince, mcpServers, skillNames });
    return { appPort: APP_PORT, opencodePort: OPENCODE_PORT };
  }

  // 6b. Headless: run the agent once with the prompt — with NO dev server running.
  emit('step', { step: 'agent' });
  const ocEnv = providerEnvFor(cfg.model, cfg.apiKey);
  if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
  // Isolate this entry's opencode storage so `opencode stats` reflects only it.
  if (dataDir) { fs.mkdirSync(dataDir, { recursive: true }); ocEnv.XDG_DATA_HOME = dataDir; }
  emit('log', `agent (one-shot): ${prompt}`);
  if (promptImageFiles.length) {
    emit('log', `with ${promptImageFiles.length} image attachment(s): ${promptImageFiles.map((f) => path.basename(f)).join(', ')}`);
  }
  // stdin is /dev/null (see run()) so opencode can never block on an interactive
  // prompt (auth / confirmation); heartbeat shows liveness if it streams nothing.
  // Extra args (e.g. a non-interactive/log flag for your opencode version) via env.
  // `--file` (opencode's prompt attachment flag) is a yargs *array* option, so it must
  // come AFTER the positional message — placed before it, it would greedily swallow the
  // prompt as another filename.
  const agentArgv = [
    'run', ...(process.env.OPENCODE_RUN_ARGS || '').split(' ').filter(Boolean), prompt || '',
    ...promptImageFiles.flatMap((f) => ['--file', f]),
  ];
  let rateLimited = false;
  let rateLimitLine = '';
  let agentChild: ChildProcess | null = null;
  let signaled = false;
  const opencodeLogPath = path.join(toolDataDir, 'opencode', 'log', 'opencode.log');
  let opencodeLogOffset = 0;
  try {
    const fd = fs.openSync(opencodeLogPath, 'r');
    try {
      opencodeLogOffset = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
  const readFreshOpencodeLog = () => {
    try {
      const fd = fs.openSync(opencodeLogPath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        // log rotate/truncate: restart from the new beginning
        if (stat.size < opencodeLogOffset) opencodeLogOffset = 0;
        const bytes = stat.size - opencodeLogOffset;
        if (bytes <= 0) return '';
        const buf = Buffer.allocUnsafe(bytes);
        const read = fs.readSync(fd, buf, 0, bytes, opencodeLogOffset);
        opencodeLogOffset += read;
        return read > 0 ? buf.subarray(0, read).toString() : '';
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {
      return '';
    }
  };
  const rateLimitWatch = setInterval(() => {
    if (rateLimited || signaled) return;
    const fresh = readFreshOpencodeLog();
    if (!fresh) return;
    const lines = fresh.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!RATE_LIMIT_RE.test(line)) continue;
      rateLimited = true;
      rateLimitLine = line;
      emit('log', 'rate limit detected in opencode log; aborting agent early');
      if (agentChild) {
        signaled = true;
        terminateTree(agentChild);
      }
      break;
    }
  }, 1000);
  rateLimitWatch.unref && rateLimitWatch.unref();

  try {
    await runStep('opencode', agentArgv, appDir, emit, {
      env: ocEnv,
      timeoutMs: AGENT_TIMEOUT_MS,
      heartbeatMs: 20000,
      onChild: (child) => { agentChild = child; },
    });
    if (rateLimited) {
      throw new Error(`opencode rate-limited${rateLimitLine ? `: ${rateLimitLine}` : ''}`);
    }
  } catch (e: any) {
    if (rateLimited) {
      throw new Error(`opencode rate-limited${rateLimitLine ? `: ${rateLimitLine}` : ''}`);
    }
    throw e;
  } finally {
    clearInterval(rateLimitWatch);
  }

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

  // Which MCP tools and skills the agent actually reached for. The one-shot agent has
  // exited, so its store is complete and quiescent — read it once, right here, before
  // the dev server and screenshot stages can fail and skip past it.
  let entryTools: HeadlessResult['tools'] = null;
  try {
    entryTools = await collectToolUsage({ dataDir: toolDataDir, since: agentSince, mcpServers, skillNames });
    if (entryTools) {
      emit('log', `tools: ${summarizeToolUsage(entryTools)}`);
      if (entryTools.warning) emit('log', `warning: ${entryTools.warning}`);
    } else {
      emit('log', 'warning: no opencode store found; tool/skill usage not recorded');
    }
  } catch (e: any) {
    emit('log', `warning: tool usage collection failed (${e.message})`);
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
    return { appPort: APP_PORT, stats: entryStats, tools: entryTools, screenshots: [], routes: [], skipped: [], appReady: false, appError: ready.reason };
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
  return { appPort: APP_PORT, stats: entryStats, tools: entryTools, screenshots, routes: disc.routes, skipped: disc.skipped, appReady: true, tests };
}
