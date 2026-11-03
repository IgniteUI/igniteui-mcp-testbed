'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { APP_PORT, subst, expandEnvRefs } from '../frameworks.ts';
import { discoverRoutes } from '../capture/route-discovery.ts';
import { shoot } from '../capture/screenshots.ts';
import { parseOpencodeStats } from '../capture/usage.ts';
import { agentRunArgv, isV2, serverArgv, serverEnv, serverPassword, statsArgv } from './opencode-cli.ts';
import { collectToolUsage, installedSkills, summarizeToolUsage } from '../capture/tool-usage.ts';
import { openStore, readUsage } from '../capture/opencode-store.ts';
import {
  APP_DIR, LOG_DIR, OPENCODE_PORT, AGENT_TIMEOUT_MS, APP_READY_TIMEOUT_MS, AGENT_SERVER_PORT, MCP_READY_TIMEOUT_MS,
  LOCAL_SKILLS_DIR, OPENCODE_DATA_DIR, STATS_TIMEOUT_MS, DIAGNOSTICS_STREAM_DEBUG, AGENT_STALL_MS, AGENT_LOOP_REPEATS,
} from '../config.ts';
import { run, capture, type RunOpts } from '../proc/exec.ts';
import { spawnWatcher, killWatcher, killAllWatchers } from '../proc/watcher.ts';
import { waitForPort, waitForPortFree, waitForAppReady, buildFailedRe } from '../proc/ports.ts';
import { ensureDirs, sleep, rmrf } from '../proc/fsutil.ts';
import { writeOpencodeConfig, providerEnvFor, writePrepareFile } from './opencode-config.ts';
import { buildMcpConfig } from './mcp-config.ts';
import { waitForMcp } from './mcp-ready.ts';
import { stageImages } from '../prompt-images.ts';
import { pruneSkills, overlaySkills, stripGeneratedAgentConfig } from './skills.ts';
import { runVerification } from '../verify/tests.ts';
import { cleanupAppDir } from '../matrix/cleanup.ts';
import { getPackForFramework, getFramework, resolvePackPath, refreshFolderPack } from '../provider-registry.ts';
import type { FrameworkDef, RunConfig, Emit, InteractiveResult, HeadlessResult, Stats, ToolContext, Diagnostic, AgentRunError, ToolUsage, SkillSourceRecord, PackProvenance } from '../types.ts';
import { installPackSkills } from './pack-skills.ts';
import { copyTemplate } from './template.ts';
import { maskingEmit, missingSecrets, secretEnv } from '../secrets.ts';
import { ensurePackDeps, packPathEnv } from '../pack-deps.ts';
import { createDiagnosticsCollector, modelDiagnostic, summarizeDiagnostics, type OutputStream } from '../capture/diagnostics.ts';

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
  /**
   * Observe `opencode web`'s output during an interactive session. The watcher is
   * spawned in here but the collector that consumes this lives in src/session.ts, since
   * an interactive session outlives runPipeline() — this is the seam between them.
   * Headless runs never use it (their agent output comes through run()'s onOutput).
   */
  onAgentOutput?: ((stream: OutputStream, chunk: string) => void) | null;
  /** Paired with onAgentOutput: the watcher closed, so flush any buffered partial line. */
  onAgentClose?: (() => void) | null;
  /**
   * Whether the user has cancelled this entry (or the whole matrix). The diagnostics
   * collector needs it because killing opencode's process group is itself a reliable
   * way to produce torn-connection stderr — without this, a user pressing Cancel would
   * manufacture a `network` diagnostic blaming the provider for their own button.
   * matrixCancelled / cancelledEntries are module-scoped in matrix.ts, so the matrix
   * passes the same closure `onChild` already evaluates. Interactive runs pass nothing.
   */
  isCancelled?: (() => boolean) | null;
  /** What a pack's skill sources resolved to (commit / hash per source), for the history record. */
  onSkillSources?: ((sources: SkillSourceRecord[]) => void) | null;
  /** Output of the pack's `versions` probes, by name, for the history record. */
  onToolVersions?: ((versions: Record<string, string>) => void) | null;
  /** The pack was edited on disk since it loaded and has been reloaded for this run. */
  onPackReloaded?: ((pack: PackProvenance) => void) | null;
}

// Servers opencode will actually expose tools from: `translate` keeps deselected
// servers in the block with `enabled:false`, and those tools never reach the agent.
const VERSION_PROBE_TIMEOUT_MS = 30_000;

/** The first version number a probe prints, else its first line. Some CLIs print a
 * banner first (`ig --version` opens with an ASCII-art logo). */
export function probeVersion(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = l.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/);
    if (m) return m[1];
  }
  return (lines[0] || '(no output)').slice(0, 200);
}

/** The {{vars}} a run's commands see. Later entries win: the framework's own `vars`, then
 * the provider's options, then the run's fixed names. `type`/`theme` are also still
 * accepted as the older projectType/theme fields (matrix configs, history re-runs).
 * `agents` feeds `ig new --agents=` so the scaffold's built-in ai-config pass honours the
 * skills toggle instead of falling back to the CLI's checkbox defaults. */
export function runVars(fw: FrameworkDef, cfg: RunConfig, appDir: string): Record<string, string | number> {
  const fwVars = Object.fromEntries(Object.entries(fw.vars || {}).map(([k, v]) => [k, expandEnvRefs(v)]));
  return {
    type: cfg.projectType || '', theme: cfg.theme || '',
    ...fwVars,
    ...(cfg.options || {}),
    name: 'app', dir: appDir, port: APP_PORT, agents: cfg.skills ? 'generic' : 'none',
  };
}

const activeMcpServers = (block: Record<string, any>): string[] =>
  Object.entries(block).filter(([, def]) => !def || def.enabled !== false).map(([name]) => name);

// Stages 1–4b are identical for an interactive session and a headless matrix entry.
// Stage 5+ branches: interactive launches `opencode web` (long-lived); headless runs
// `opencode run "<prompt>"` once, parses usage, then screenshots every route.
// Returns interactive: { appPort, opencodePort }
//         headless:    { appPort, stats, screenshots, routes, skipped }
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless?: false }): Promise<InteractiveResult>;
export function runPipeline(cfg: RunConfig, opts: PipelineOpts & { headless: true }): Promise<HeadlessResult>;
export async function runPipeline(
  cfg: RunConfig,
  { emit: rawEmit, headless = false, prompt = null, dataDir = null, artifactDir = null, onChild = null, appDir = APP_DIR, onToolContext = null, isCancelled = null, onAgentOutput = null, onAgentClose = null, onSkillSources = null, onToolVersions = null, onPackReloaded = null }: PipelineOpts,
): Promise<InteractiveResult | HeadlessResult> {
  const loaded = getPackForFramework(cfg.framework);
  const refreshed = loaded && refreshFolderPack(loaded.name);
  if (refreshed && loaded && refreshed.hash !== loaded.hash) {
    rawEmit('log', `pack "${refreshed.name}" changed on disk since it loaded — reloaded (hash ${loaded.hash} → ${refreshed.hash})`);
    onPackReloaded?.({ name: refreshed.name, ...(refreshed.version ? { version: refreshed.version } : {}), hash: refreshed.hash, origin: refreshed.origin });
  }
  const fw = getFramework(cfg.framework);
  if (!fw) throw new Error(`unknown framework: ${cfg.framework}`);

  // A step that prints a secret must not get it into the log or the history record.
  const emit = maskingEmit(rawEmit);
  // Every framework belongs to a pack (Ignite UI's is built in).
  const pack = getPackForFramework(cfg.framework);
  if (!pack) throw new Error(`no provider pack found for framework "${cfg.framework}" — is the pack loaded?`);
  // Pack secrets reach only the pack's scaffold / install / configure / dev-server steps
  // (src/secrets.ts).
  const missing = missingSecrets(pack);
  if (missing.length) {
    throw new Error(`missing required secret(s) for "${pack.name}": ` +
      missing.map((m) => `${m.name} (${m.source})`).join(', '));
  }
  const depsEnv = packPathEnv(pack);
  const stepEnv = (extra?: Record<string, string>) => ({ ...depsEnv, ...secretEnv(pack, extra || {}) });
  const maskOutput = !!pack.secrets?.length;
  // The pack's containerDeps (src/pack-deps.ts): usually already installed at load; the
  // first run of a freshly loaded pack waits here. A failed install fails the run now.
  if (pack.containerDeps?.npmGlobal?.length) emit('log', `pack deps: ${pack.containerDeps.npmGlobal.join(', ')}`);
  const depVersions = await ensurePackDeps(pack);

  // MCP servers the agent will actually be offered, recorded so the tool-usage report
  // can say which of them were never called. Filled in by whichever configure branch runs.
  let mcpServers: string[] = [];

  // Report every spawned child to `onChild` (matrix cancel kills whatever is current)
  // so Cancel works during scaffold/npm-install too, not only the agent step.
  const runStep = (cmd: string, argv: string[], cwd: string, e: Emit, opts: RunOpts = {}) =>
    run(cmd, argv, cwd, e, { ...opts, onChild });

  ensureDirs();
  // Clean any previous attempt. In matrix mode `appDir` is unique per entry, so
  // this is a no-op there; await the watchers' exit first so their file handles
  // are released before we delete (else rmrf races a dying dev server).
  await killAllWatchers();
  await rmrf(appDir);

  // 1. Scaffold
  emit('step', { step: 'scaffold' });
  fs.mkdirSync(path.dirname(appDir), { recursive: true });
  const vars = runVars(fw, cfg, appDir);
  const scaffold = fw.scaffold;
  if (scaffold.kind === 'template') {
    const n = copyTemplate(resolvePackPath(pack, scaffold.from), appDir, vars, emit);
    emit('log', `scaffolded from template ${scaffold.from} (${n} file(s))`);
  } else {
    await runStep(scaffold.cmd, subst(scaffold.argv, vars), path.dirname(appDir), emit, { env: stepEnv(scaffold.env), maskOutput });
  }

  // Drop any framework-specific files into the fresh project (e.g. Blazor's
  // Directory.Build.props that relocates obj/bin off the bind mount).
  for (const [rel, body] of Object.entries(fw.prepare || {})) {
    writePrepareFile(path.join(appDir, rel), subst([body], vars)[0], emit, appDir);
  }

  // 1b. Post-scaffold package install (e.g. MUI into a plain Vite project). A template
  // ships a package.json but not its node_modules, so it always gets an install.
  const templateDeps = scaffold.kind === 'template' && fs.existsSync(path.join(appDir, 'package.json'));
  if ((fw.install && fw.install.length) || templateDeps) {
    emit('log', `installing packages${fw.install?.length ? `: ${fw.install.join(' ')}` : ' from package.json'}`);
    await runStep('npm', ['install', ...(fw.install || [])], appDir, emit, { env: stepEnv(scaffold.env), maskOutput });
  }

  // 1c. What the pack's tools actually resolved to, since a pack's `version` is only what
  // its author typed. A probe that fails is recorded as such rather than failing the run.
  const found: Record<string, string> = Object.fromEntries(
    Object.entries(depVersions).map(([name, v]) => [`npm:${name}`, v]));
  if (pack.versions?.length) {
    for (const v of pack.versions) {
      if (v.frameworks && !v.frameworks.includes(cfg.framework)) continue;
      try {
        const out = await capture(v.cmd, v.argv, appDir, depsEnv, VERSION_PROBE_TIMEOUT_MS);
        found[v.name] = probeVersion(out);
      } catch (e: any) {
        found[v.name] = `error: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`;
      }
    }
  }
  if (Object.keys(found).length) {
    emit('log', `tool versions: ${Object.entries(found).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    onToolVersions?.(found);
  }

  // 2. Configure — the pack's own steps (Ignite UI: `ig ai-config`), which may generate
  // skills and an MCP config file. For `ig new` frameworks this mostly re-runs what the
  // scaffold did, but after `npm install`, so it upgrades the scaffold's bundled skills to
  // the installed package's; Blazor (`dotnet new`) has no built-in pass, so this is its
  // only one.
  emit('step', { step: 'configure' });
  for (const step of pack.configure || []) {
    if (step.frameworks && !step.frameworks.includes(cfg.framework)) continue;
    await runStep(step.cmd, subst(step.argv, vars), appDir, emit, { env: stepEnv(), maskOutput });
  }

  if (cfg.skills && pack.skills?.sources.length) {
    const records: SkillSourceRecord[] = [];
    try {
      await installPackSkills(pack, path.join(appDir, '.agents', 'skills'),
        emit, (cmd, argv, cwd) => runStep(cmd, argv, cwd, emit, { env: depsEnv }), records);
    } finally {
      // Reported even when a source failed, so the record shows what did resolve.
      onSkillSources?.(records);
    }
  }

  // 3. MCP servers → opencode.json (src/pipeline/mcp-config.ts).
  emit('step', { step: 'translate' });
  const { mcp, enabledCount } = buildMcpConfig(pack, cfg, appDir, emit);
  writeOpencodeConfig(cfg, mcp, appDir);
  mcpServers = activeMcpServers(mcp);
  emit('log', `opencode.json written (${Object.keys(mcp).length} MCP servers, ${enabledCount} enabled)`);

  // 4. Prune skills. With the toggle off, sweep away anything the scaffold or ai-config
  // wrote anyway (the flags above should have prevented it — this is the guarantee, not
  // the mechanism). With it on, drop just the folders the caller deselected.
  if (!cfg.skills) {
    stripGeneratedAgentConfig(appDir, emit);
  } else if (Array.isArray(cfg.excludedSkills) && cfg.excludedSkills.length) {
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
    spawnWatcher('app', fw.dev.cmd, subst(fw.dev.argv, vars), appDir, stepEnv(fw.dev.env), { maskOutput });
    try {
      await waitForPort(APP_PORT, 180000, emit);
      emit('log', `app is serving on :${APP_PORT}`);
    } catch (e: any) {
      emit('log', `app not confirmed ready (${e.message}); check logs/app.log`);
    }

    // 6a. Interactive: launch the opencode web server and hand off.
    emit('step', { step: 'launch-opencode' });
    const ocEnv = { ...depsEnv, ...providerEnvFor(cfg.model, cfg.apiKey), ...serverEnv() };
    if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
    spawnWatcher('opencode', 'opencode', serverArgv(OPENCODE_PORT), appDir, ocEnv,
      // Teeing (rather than redirecting) opencode's output is what makes provider errors
      // observable in an interactive session at all; logs/opencode.log still gets
      // everything. Omit the callback and the watcher keeps the plain fd redirect.
      { onOutput: onAgentOutput || null, onClose: onAgentClose || null });
    await waitForPort(OPENCODE_PORT, 60000, emit);
    // An interactive session has no end the pipeline can observe — `opencode web` keeps
    // running and the user keeps prompting — so hand the collection context off to the
    // StatsCollector, which re-reads the store on its reconcile tick.
    if (onToolContext) onToolContext({ dataDir: toolDataDir, since: agentSince, mcpServers, skillNames });
    return { appPort: APP_PORT, opencodePort: OPENCODE_PORT, opencodePassword: serverPassword() };
  }

  // 6b. Headless: run the agent once with the prompt — with NO dev server running.
  emit('step', { step: 'agent' });
  const ocEnv: Record<string, string> = { ...depsEnv, ...providerEnvFor(cfg.model, cfg.apiKey), ...serverEnv() };
  if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
  // Isolate this entry's opencode storage so `opencode stats` reflects only it.
  if (dataDir) { fs.mkdirSync(dataDir, { recursive: true }); ocEnv.XDG_DATA_HOME = dataDir; }
  // 2.x: a private server, so the prompt can wait for MCP (mcp-ready.ts).
  let agentServer: string | null = null;
  const agentLog = path.join(path.dirname(appDir), 'opencode-agent.log');
  let agentServerExit: string | null = null;
  let killingAgentServer = false;
  const stopAgentServer = async () => { killingAgentServer = true; await killWatcher('opencode-agent'); };
  if (isV2()) {
    await killWatcher('opencode-agent');
    // A survivor would answer waitForPort with the previous entry's env.
    if (!(await waitForPortFree(AGENT_SERVER_PORT, 15000))) {
      throw new Error(`port ${AGENT_SERVER_PORT} is still in use by a previous agent server`);
    }
    const srv = spawnWatcher('opencode-agent', 'opencode', serverArgv(AGENT_SERVER_PORT, '127.0.0.1'), appDir, ocEnv, { logPath: agentLog });
    srv.once('exit', (code, signal) => {
      if (!killingAgentServer) agentServerExit = signal ? `signal ${signal}` : `code ${code}`;
    });
    const stopWaiting = () => agentServerExit !== null || !!(isCancelled && isCancelled());
    try {
      await waitForPort(AGENT_SERVER_PORT, 30000, emit, stopWaiting);
      agentServer = `http://127.0.0.1:${AGENT_SERVER_PORT}`;
      if (mcpServers.length) await waitForMcp(AGENT_SERVER_PORT, appDir, mcpServers, MCP_READY_TIMEOUT_MS, emit, stopWaiting);
    } catch (e) {
      if (agentServerExit) throw new Error(`agent server exited (${agentServerExit}) during startup; see ${agentLog}`);
      throw e;
    }
  }
  // Once our server is gone, a ConnectionRefused is ours, not the provider's.
  const dropLocalNetwork = (ds: Diagnostic[]): Diagnostic[] => {
    if (!agentServerExit && !(isCancelled && isCancelled())) return ds;
    const kept = ds.filter((d) => d.kind !== 'network');
    if (kept.length !== ds.length) emit('diagnostics', { diagnostics: kept });
    return kept;
  };
  emit('log', `agent (one-shot): ${prompt}`);
  if (promptImageFiles.length) {
    emit('log', `with ${promptImageFiles.length} image attachment(s): ${promptImageFiles.map((f) => path.basename(f)).join(', ')}`);
  }
  // stdin is /dev/null (see run()) so opencode can never block on an interactive
  // prompt (auth / confirmation); heartbeat shows liveness if it streams nothing.
  // Extra args (e.g. a non-interactive/log flag for your opencode version) via env.
  const agentArgv = agentRunArgv(prompt || '', promptImageFiles,
    (process.env.OPENCODE_RUN_ARGS || '').split(' ').filter(Boolean), agentServer);
  // Token/cost and MCP-call evidence, collected the same way on the success and the
  // failure path. Extracted because every failed run in the corpus lost all of it —
  // and with diagnostics in play that matters more, since "429 at minute 2 with 0
  // tokens" and "429 at minute 24 with 180k tokens" are different stories.
  const collectRunEvidence = async (): Promise<{ stats: Stats | null; tools: ToolUsage | null; modelDiag: Diagnostic | null }> => {
    let stats: Stats | null = null;
    let modelDiag: Diagnostic | null = null;
    try {
      const store = await openStore(toolDataDir);
      if (store) {
        try {
          const usage = readUsage(store, agentSince);
          if (usage) {
            stats = { ...usage.stats, model: cfg.model, updatedAt: new Date().toISOString() };
            modelDiag = modelDiagnostic(cfg.model, usage.models);
            if (modelDiag) emit('log', `${modelDiag.severity === 'fatal' ? 'error' : 'warning'}: ${modelDiag.title} — ${modelDiag.advice}`);
          }
        } finally {
          store.close();
        }
      }
    } catch (e: any) {
      emit('log', `warning: could not read usage from opencode.db (${e.message})`);
    }
    // 1.x has no per-message cost in the store.
    if (!stats && !isV2()) {
      try {
        const text = await capture('opencode', statsArgv(), appDir, dataDir ? { XDG_DATA_HOME: dataDir } : null, STATS_TIMEOUT_MS);
        stats = parseOpencodeStats(text);
        stats.model = cfg.model;
        stats.updatedAt = new Date().toISOString();
        if (!stats.parsed) emit('log', 'warning: could not parse `opencode stats`; tokens/cost may be incomplete');
      } catch (e: any) {
        emit('log', `warning: opencode stats failed (${e.message})`);
      }
    }

    // Which MCP tools and skills the agent actually reached for. The one-shot agent has
    // exited, so its store is complete and quiescent — read it once, right here, before
    // the dev server and screenshot stages can fail and skip past it.
    let tools: ToolUsage | null = null;
    try {
      tools = await collectToolUsage({ dataDir: toolDataDir, since: agentSince, mcpServers, skillNames });
      if (tools) {
        emit('log', `tools: ${summarizeToolUsage(tools)}`);
        if (tools.warning) emit('log', `warning: ${tools.warning}`);
      } else {
        emit('log', 'warning: no opencode store found; tool/skill usage not recorded');
      }
    } catch (e: any) {
      emit('log', `warning: tool usage collection failed (${e.message})`);
    }
    return { stats, tools, modelDiag };
  };

  // Observe the agent's output for provider failures. Purely observational with respect
  // to *execution* — a detector that throws is caught in run() and degrades to "no
  // diagnostics", never to "no run" — but a valid diagnostic absolutely does decide the
  // recorded verdict, which is the whole point.
  const diag = createDiagnosticsCollector({
    isCancelled,
    onDebug: DIAGNOSTICS_STREAM_DEBUG ? (msg: string) => emit('log', `diag: ${msg}`) : null,
    // Mid-run channel: a stall reported only in the final record is reported too late to
    // be acted on. Always the full set, so the far side can replace wholesale.
    onChange: (ds) => emit('diagnostics', { diagnostics: ds }),
    // Detector C polls opencode's own store while the agent works. `since` scopes the
    // read to this run — a store can be shared across runs in one container.
    loop: { dataDir: toolDataDir, since: agentSince, repeats: AGENT_LOOP_REPEATS },
  });
  let diagnostics: Diagnostic[] = [];
  try {
    await runStep('opencode', agentArgv, appDir, emit, {
      env: ocEnv, timeoutMs: AGENT_TIMEOUT_MS, heartbeatMs: 20000,
      onOutput: (stream, chunk) => diag.onOutput(stream, chunk),
      // Nothing is killed on a stall — AGENT_TIMEOUT_MS is still the only deadline.
      stallMs: AGENT_STALL_MS,
      onStall: (silentMs) => {
        emit('log', `warning: no output for ${Math.round(silentMs / 1000)}s — the provider may be unresponsive (the run continues)`);
        diag.noteStall(silentMs);
      },
      onResume: (silentMs) => {
        emit('log', `output resumed after ${Math.round(silentMs / 1000)}s of silence`);
        diag.noteResume(silentMs);
      },
    });
    await stopAgentServer();
    diagnostics = dropLocalNetwork(await diag.finish({ exitCode: 0 }));
  } catch (err: any) {
    await stopAgentServer();
    diagnostics = dropLocalNetwork(await diag.finish({ exitCode: err.timedOut ? null : 1, timedOut: !!err.timedOut, timeoutMs: AGENT_TIMEOUT_MS }));
    if (agentServerExit && !(isCancelled && isCancelled())) {
      err.message = `agent server exited (${agentServerExit}) while the agent was running; see ${agentLog}`;
    }
    for (const d of diagnostics) {
      emit('log', `${d.severity === 'fatal' ? 'error' : 'warning'}: ${d.title} — ${d.advice}`);
      emit('log', `  evidence: ${d.detail}`);
    }
    // A failed pipeline returns no HeadlessResult, so the evidence has to ride out on
    // the error or it is lost exactly when it is most wanted.
    const agentErr: AgentRunError = err;
    agentErr.diagnostics = diagnostics;
    // A cancelled entry's stats are of little interest and the user is waiting for the
    // matrix to stop, so skip the collection rather than make Cancel feel slow.
    if (!(isCancelled && isCancelled())) {
      const evidence = await collectRunEvidence();
      agentErr.stats = evidence.stats;
      agentErr.tools = evidence.tools;
      if (evidence.modelDiag) {
        agentErr.diagnostics = [...(agentErr.diagnostics || []), evidence.modelDiag];
        emit('diagnostics', { diagnostics: agentErr.diagnostics });
      }
    }
    throw agentErr;
  }
  if (diagnostics.length) {
    const summary = summarizeDiagnostics(diagnostics);
    if (summary) emit('log', `warning: ${summary}`);
  }

  const { stats: entryStats, tools: entryTools, modelDiag } = await collectRunEvidence();
  if (modelDiag) {
    diagnostics = [...diagnostics, modelDiag];
    emit('diagnostics', { diagnostics });
    if (modelDiag.severity === 'fatal') {
      emit('log', 'skipping build, screenshots and tests: the agent ran on a different model');
      emit('step', { step: 'cleanup' });
      await cleanupAppDir(appDir, emit);
      return { appPort: APP_PORT, stats: entryStats, tools: entryTools, screenshots: [], routes: [], skipped: [], diagnostics };
    }
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
  const appChild = spawnWatcher('app', fw.dev.cmd, subst(fw.dev.argv, vars), appDir, stepEnv(fw.dev.env), { maskOutput });
  const ready = await waitForAppReady(APP_PORT, APP_READY_TIMEOUT_MS, 'app', logOffset, appChild, emit, buildFailedRe(fw.buildFailed));
  if (ready.ready) {
    emit('log', `app is serving on :${APP_PORT}`);
  } else {
    emit('log', `app did not start — ${ready.reason}; screenshots will be skipped`);
    if (ready.tail) emit('log', `--- app build output (tail) ---\n${ready.tail}\n--- end ---`);
  }
  emit('step', { step: 'screenshot' });
  if (!ready.ready) {
    await killAllWatchers();
    emit('step', { step: 'cleanup' });
    await cleanupAppDir(appDir, emit);
    return { appPort: APP_PORT, stats: entryStats, tools: entryTools, screenshots: [], routes: [], skipped: [], appReady: false, appError: ready.reason, diagnostics };
  }
  await sleep(Number(process.env.SCREENSHOT_SETTLE_MS || 5000));
  const disc = discoverRoutes(appDir, fw.routes);
  emit('log', `routes: ${disc.routes.length} found${disc.skipped.length ? `, ${disc.skipped.length} skipped` : ''}${disc.stateNav ? ' (state-nav, will click through)' : ''}`);
  disc.skipped.forEach((s) => emit('log', `  skip ${s.path} (${s.reason})`));
  // When no routes are discovered (e.g. a plain Vite React app with no router, or an
  // Angular app whose routes array is still empty after scaffold), fall back to '/' —
  // the app IS serving and at minimum the root page should be captured.
  const routesToShoot = disc.routes.length ? disc.routes : ['/'];
  if (!disc.routes.length) emit('log', 'no routes discovered — falling back to root (/)');
  let screenshots: HeadlessResult['screenshots'] = [];
  try {
    screenshots = await shoot(`http://127.0.0.1:${APP_PORT}`, routesToShoot, artifactDir || '', {
      stateNav: disc.stateNav,
      log: (m) => emit('log', m),
      isCancelled,
      onChild,
    });
    emit('log', `screenshots: ${screenshots.filter((s) => s.ok).length}/${screenshots.length} captured`);
    // The count alone hides WHY a capture failed — the reason sat only in the history
    // record's screenshots array, so a run that captured nothing looked identical to
    // one with no routes. First line only; the full error stays on the record.
    for (const s of screenshots.filter((s) => !s.ok)) {
      emit('log', `  ${s.route}: ${String(s.error || 'failed').split('\n')[0]}`);
    }
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
  await killAllWatchers();
  // Prune heavy regenerable dirs from the kept entry (screenshots already saved).
  emit('step', { step: 'cleanup' });
  await cleanupAppDir(appDir, emit);
  return { appPort: APP_PORT, stats: entryStats, tools: entryTools, screenshots, routes: disc.routes, skipped: disc.skipped, appReady: true, tests, diagnostics };
}
