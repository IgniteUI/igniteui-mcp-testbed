'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { FRAMEWORKS, APP_PORT, subst } = require('./lib/frameworks');
const { translate } = require('./lib/mcp-translate');
const { StatsCollector } = require('./lib/stats');
const history = require('./lib/history');
const { discoverRoutes } = require('./lib/routes');
const { shoot } = require('./lib/screenshots');
const { parseOpencodeStats } = require('./lib/usage');

const WIZARD_PORT = Number(process.env.WIZARD_PORT || 8080);
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORK = process.env.WORK_DIR || '/work';
const APP_DIR = path.join(WORK, 'app');
const LOG_DIR = path.join(WORK, 'logs');
// Persistent, cross-container store (second bind mount). Screenshot artifacts live
// under it so they survive container teardown alongside the run records.
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(WORK, 'history');
const ARTIFACT_DIR = path.join(HISTORY_DIR, 'artifacts');

// Matrix-mode tunables.
const MATRIX_MAX_ENTRIES = Number(process.env.MATRIX_MAX_ENTRIES || 24);
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 15 * 60 * 1000);
// How long to wait for the (headless) post-edit dev-server build before giving up
// and screenshotting anyway. Generous because the first build of an agent-edited
// app (esp. Blazor) is slow across the bind mount.
const APP_READY_TIMEOUT_MS = Number(process.env.APP_READY_TIMEOUT_MS || 6 * 60 * 1000);

// Put opencode's storage (SQLite + logs) under /work so `opencode stats` and the
// running `opencode web` share one data dir and the usage data survives the
// ephemeral container. opencode honours XDG_DATA_HOME for its storage location.
process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(WORK, '.opencode-data');

// Reliable launch commands for the known Ignite UI MCP servers, run from the
// globally-installed packages (see Containerfile) instead of the broken/network
// `npx` invocations ig ai-config writes. Keyed by the wizard's server class.
const MCP_COMMAND_BY_CLASS = {
  igniteui: ['ig', 'mcp'],
  theming: ['igniteui-theming-mcp'],
};

// Which env var carries the API key, keyed by the provider prefix of the model id.
const PROVIDER_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve matrix screenshot artifacts read-only from the persistent history store.
app.use('/history/artifacts', express.static(ARTIFACT_DIR));

// Long-lived child processes for this session (one app, one opencode).
const procs = { app: null, opencode: null };
let lastConfig = null; // remembered so /api/model can rebuild opencode.json
let currentRunId = null; // history record id for the current/last run
let stats = null; // live StatsCollector for the current session
const statsClients = new Set(); // open SSE responses for /api/stats/stream

// Progress of the current/last pipeline run, so a wizard that reconnects mid-run
// can re-attach and follow it to completion. runClients are SSE listeners.
const runClients = new Set();
let runState = { phase: 'idle', step: null, completed: [], logs: [], result: null, error: null };

function publicRunState() {
  return {
    phase: runState.phase, step: runState.step,
    completed: runState.completed.slice(),
    logs: runState.logs.slice(-200),
    result: runState.result, error: runState.error,
  };
}

// Update runState from one pipeline event and fan it out to re-attach listeners.
function recordRun(obj) {
  if (obj.type === 'step') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = obj.step;
    runState.phase = 'running';
  } else if (obj.type === 'log') {
    runState.logs.push(obj.msg);
    if (runState.logs.length > 1000) runState.logs.shift();
  } else if (obj.type === 'error') {
    runState.phase = 'error';
    runState.error = obj.msg;
  } else if (obj.type === 'done') {
    if (runState.step) runState.completed.push(runState.step);
    runState.step = null;
    runState.phase = 'done';
    runState.result = obj;
  }
  const sse = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of runClients) { try { r.write(sse); } catch (_) {} }
}

function startStats(cfg) {
  if (stats) stats.stop();
  stats = new StatsCollector({
    port: OPENCODE_PORT,
    dir: WORK,
    model: cfg.model,
    costAvailable: !cfg.customBaseUrl,
  });
  stats.onUpdate((snap) => {
    history.updateStats(currentRunId, snap);
    const line = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of statsClients) { try { res.write(line); } catch (_) {} }
  });
  stats.onWarn((msg) => console.error(msg));
  stats.start();
}

// ---------- helpers ----------

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signal a child's whole process group (negative pid) so its descendants die too,
// not just the launcher. Falls back to the direct child if the group send fails.
function killTree(child, sig) {
  if (!child) return;
  try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
  catch (_) { try { child.kill(sig); } catch (_) {} }
}

// Run a command to completion, streaming its output through `emit`. Optional
// `opts.env` is merged over process.env; `opts.timeoutMs` kills + rejects on hang;
// `opts.heartbeatMs` emits a liveness tick so a long-but-working run (e.g. the agent)
// is distinguishable from a stuck one. stdin is /dev/null so a child that tries to
// prompt interactively (auth, "continue?") gets EOF and fails fast instead of hanging.
function run(cmd, argv, cwd, emit, opts = {}) {
  return new Promise((resolve, reject) => {
    emit('log', `$ ${cmd} ${argv.join(' ')}`);
    // detached -> own process group, so killTree() can take down the whole tree
    // (e.g. `ig new` spawning `npm install`); otherwise SIGTERM to the launcher
    // leaves the real work running and Cancel can't stop it.
    const child = spawn(cmd, argv, {
      cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (opts.onChild) opts.onChild(child);
    let timer = null, beat = null;
    const cleanup = () => { if (timer) clearTimeout(timer); if (beat) clearInterval(beat); };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        cleanup();
        killTree(child, 'SIGTERM');
        reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    if (opts.heartbeatMs) {
      const t0 = Date.now();
      beat = setInterval(() => emit('log', `… ${cmd} still running (${Math.round((Date.now() - t0) / 1000)}s)`), opts.heartbeatMs);
      beat.unref && beat.unref();
    }
    child.stdout.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.stderr.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.on('error', (e) => { cleanup(); reject(e); });
    child.on('close', (code) => {
      cleanup();
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// Run a command to completion and resolve with its captured stdout (for tools
// like `opencode stats` whose output we want to return rather than stream).
function capture(cmd, argv, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...(env || {}) } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with code ${code}`)));
  });
}

// Spawn a long-running watcher; tee its output to a log file. `detached:true` puts
// it in its own process group so killWatcher can take down the WHOLE tree — `npm run
// start` doesn't forward SIGTERM to its Vite/node child, which would otherwise orphan
// the dev server still bound to APP_PORT and let the next matrix entry screenshot it.
function spawnWatcher(name, cmd, argv, cwd, extraEnv) {
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
    detached: true,
  });
  procs[name] = child;
  return child;
}

// SIGTERM the watcher and resolve only once it has actually exited (SIGKILL after
// a grace period). Awaiting this before deleting the project dir matters: a
// still-dying dev server holds file handles, which makes rmSync throw ENOTEMPTY/
// EBUSY on the Windows<->Podman bind mount.
function killWatcher(name) {
  const child = procs[name];
  procs[name] = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once('close', done);
    killTree(child, 'SIGTERM');
    const t = setTimeout(() => { killTree(child, 'SIGKILL'); done(); }, 4000);
    t.unref && t.unref();
  });
}

// Resolve true once nothing is listening on `port` (or false on timeout). Used
// before launching an entry's dev server so we never screenshot a previous entry's
// stale server that's still holding the fixed port.
function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 400);
      });
      sock.once('error', () => { sock.destroy(); resolve(true); });
    };
    attempt();
  });
}

// rm -rf with a few retries: the bind mount intermittently reports ENOTEMPTY/EBUSY
// while file handles are still being released. force:true already ignores ENOENT.
async function rmrf(dir) {
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) {
      if (i >= 4 || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}

// Heavy/regenerable dirs pruned from a kept matrix entry after its screenshots are
// saved (those live under ARTIFACT_DIR, not appDir, so they're unaffected).
const CLEANUP_DIRS = ['node_modules', 'dist', '.angular', '.vite'];
const CLEANUP_ENABLED = process.env.MATRIX_CLEANUP !== '0';

// Reclaim disk from a headless entry's project dir. Best-effort + non-fatal.
async function cleanupAppDir(appDir, emit) {
  if (!CLEANUP_ENABLED) return;
  for (const d of CLEANUP_DIRS) {
    const target = path.join(appDir, d);
    if (!fs.existsSync(target)) continue;
    try { await rmrf(target); emit('log', `cleanup: removed ${d}/`); }
    catch (e) { emit('log', `cleanup: could not remove ${d}/ (${e.message})`); }
  }
}

// Resolve when a TCP port accepts a connection, or reject on timeout.
function waitForPort(port, timeoutMs, emit) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`port ${port} not ready within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 800);
        }
      });
    };
    attempt();
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function tailLines(s, n) {
  const lines = stripAnsi(s).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

// Terminal build-failure markers per dev server. Post-agent the source is static,
// so the first build is final: a failed build never recovers, no point waiting.
const BUILD_FAILED_RE = /(Application bundle generation failed|The build failed|dotnet watch ❌|Waiting for a file to change before restarting|is already in use|address already in use|EADDRINUSE|error when starting dev server)/i;

// Wait until the dev server is actually serving, or it's clear the build failed —
// whichever comes first. Reads only the bytes appended to <name>.log since spawn
// (the file is shared across matrix entries). Returns { ready, reason, tail }.
function waitForAppReady(port, timeoutMs, logName, startOffset, child, emit) {
  const logPath = path.join(LOG_DIR, `${logName}.log`);
  const deadline = Date.now() + timeoutMs;
  const freshLog = () => {
    try { return fs.readFileSync(logPath).slice(startOffset).toString(); } catch (_) { return ''; }
  };
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve({ ready: true }); });
      sock.once('error', () => {
        sock.destroy();
        const fresh = freshLog();
        if (child && child.exitCode !== null) {
          return resolve({ ready: false, reason: `dev server exited (code ${child.exitCode})`, tail: tailLines(fresh, 40) });
        }
        if (BUILD_FAILED_RE.test(fresh)) {
          return resolve({ ready: false, reason: 'build failed', tail: tailLines(fresh, 40) });
        }
        if (Date.now() > deadline) {
          return resolve({ ready: false, reason: `not ready within ${timeoutMs}ms`, tail: tailLines(fresh, 40) });
        }
        setTimeout(attempt, 800);
      });
    };
    attempt();
  });
}

function providerEnvFor(model, apiKey) {
  const prefix = String(model).split('/')[0];
  const key = PROVIDER_ENV[prefix];
  return key && apiKey ? { [key]: apiKey } : {};
}

// Build the opencode.json the agent will read.
function writeOpencodeConfig(cfg, mcp, appDir) {
  const doc = {
    $schema: 'https://opencode.ai/config.json',
    model: cfg.model,
    // Auto-approve every permission. Headless `opencode run` (matrix) has stdin =
    // /dev/null, and opencode BLOCKS on a permission prompt rather than failing on
    // EOF — e.g. an agent writing scratch files to /tmp triggers `external_directory`
    // (default: ask) and hangs until AGENT_TIMEOUT_MS. This appliance is an ephemeral
    // sandbox, so allowing everything (incl. external dirs) is the right default and
    // also spares the interactive opencode-web user from approval prompts.
    permission: 'allow',
    mcp,
  };
  // Custom OpenAI-compatible endpoint -> declare a provider.
  if (cfg.customBaseUrl) {
    const id = 'custom';
    doc.provider = {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Endpoint',
        options: { baseURL: cfg.customBaseUrl, apiKey: '{env:CUSTOM_API_KEY}' },
        models: { [cfg.model.split('/').slice(1).join('/') || cfg.model]: {} },
      },
    };
  }
  fs.writeFileSync(path.join(appDir, 'opencode.json'), JSON.stringify(doc, null, 2));
}

// Write a framework `prepare` file, merging instead of clobbering when one already
// exists. For MSBuild props/targets we inject our PropertyGroup before the closing
// </Project> (later definitions win, so our properties override); other existing
// files are left untouched so we never overwrite template-provided content.
function writePrepareFile(dest, body, emit, appDir) {
  const rel = path.relative(appDir, dest);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    emit('log', `wrote ${rel}`);
    return;
  }
  if (!/\.(props|targets)$/i.test(dest)) {
    emit('log', `kept existing ${rel} (not overwritten)`);
    return;
  }
  const existing = fs.readFileSync(dest, 'utf8');
  const inner = (body.match(/<Project[^>]*>([\s\S]*)<\/Project>/i) || [, body])[1].trim();
  const idx = existing.toLowerCase().lastIndexOf('</project>');
  if (idx === -1) {
    fs.writeFileSync(dest, existing.trimEnd() + '\n' + body);
  } else {
    fs.writeFileSync(dest, existing.slice(0, idx) + '  ' + inner + '\n' + existing.slice(idx));
  }
  emit('log', `merged into existing ${rel}`);
}

// Remove deselected skill folders (granular skills on/off).
function pruneSkills(excluded, emit, appDir) {
  const base = path.join(appDir, '.claude', 'skills');
  if (!fs.existsSync(base)) return;
  for (const name of excluded) {
    const dir = path.join(base, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      emit('log', `pruned skill: ${name}`);
    }
  }
}

// ---------- the pipeline ----------

// Stages 1–5 are identical for an interactive session and a headless matrix entry.
// Stage 6 branches: interactive launches `opencode web` (long-lived); headless runs
// `opencode run "<prompt>"` once, parses usage, then screenshots every route.
// Returns interactive: { appPort, opencodePort }
//         headless:    { appPort, stats, screenshots, routes, skipped }
async function runPipeline(cfg, { emit, headless = false, prompt = null, dataDir = null, artifactDir = null, onChild = null, appDir = APP_DIR }) {
  const fw = FRAMEWORKS[cfg.framework];
  if (!fw) throw new Error(`unknown framework: ${cfg.framework}`);

  // Report every spawned child to `onChild` (matrix cancel kills whatever is current)
  // so Cancel works during scaffold/npm-install too, not only the agent step.
  const runStep = (cmd, argv, cwd, e, opts = {}) => run(cmd, argv, cwd, e, { ...opts, onChild });

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

  // 2. AI config (skills + MCP definitions), non-interactive via flags.
  emit('step', { step: 'configure' });
  const agents = cfg.skills ? ['claude'] : ['none'];
  await runStep('ig', [
    'ai-config',
    '--framework', fw.aiFramework,
    '--agents', ...agents,
    '--assistants', 'vscode',
  ], appDir, emit);

  // 3. Translate .vscode/mcp.json -> opencode.json (with MCP toggles).
  emit('step', { step: 'translate' });
  let vscodeMcp = {};
  const mcpPath = path.join(appDir, '.vscode', 'mcp.json');
  if (fs.existsSync(mcpPath)) {
    vscodeMcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } else {
    emit('log', 'no .vscode/mcp.json found; continuing with empty MCP set');
  }
  // The user toggles MCPs by class (igniteui / theming / angular). We classify
  // each discovered server by name+command with explicit precedence so the
  // generic "ignite" match can't swallow the theming server. Only classes the
  // caller explicitly selected are enabled — everything else (incl. angular-cli
  // and any unclassified "other" server) stays off, so a variant with no MCPs
  // is a true clean baseline.
  const selected = new Set((cfg.enabledMcps || []).map((t) => t.toLowerCase()));
  const servers = (vscodeMcp && vscodeMcp.servers) || {};
  const classify = (name, s) => {
    const hay = (name + ' ' + [s.command, ...(s.args || [])].join(' ')).toLowerCase();
    if (hay.includes('theming')) return 'theming';
    if (hay.includes('angular')) return 'angular';
    if (hay.includes('ignite')) return 'igniteui';
    return 'other';
  };
  const enabled = new Set();
  const classByName = {};
  for (const [name, s] of Object.entries(servers)) {
    const cls = classify(name, s);
    classByName[name] = cls;
    const on = selected.has(cls);
    if (on) enabled.add(name);
    emit('log', `mcp "${name}" → ${cls} → ${on ? 'enabled' : 'disabled'}`);
  }
  const { mcp, warnings } = translate(vscodeMcp, { enabled, workspaceFolder: appDir });
  warnings.forEach((w) => emit('log', `warning: ${w}`));
  // The ig ai-config `npx -y <pkg> …` invocations don't resolve to a runnable
  // bin (igniteui-cli's bins are `ig`/`igniteui`, not `igniteui-cli`; theming's
  // is `igniteui-theming-mcp`) and cold-fetch from npm in the ephemeral
  // container. Run the globally-installed bins directly instead.
  for (const [name, def] of Object.entries(mcp)) {
    const fix = MCP_COMMAND_BY_CLASS[classByName[name]];
    if (fix && def.type === 'local') {
      def.command = fix.slice();
      emit('log', `mcp "${name}" command → ${fix.join(' ')}`);
    }
  }
  writeOpencodeConfig(cfg, mcp, appDir);
  emit('log', `opencode.json written (${Object.keys(mcp).length} MCP servers, ${[...enabled].length} enabled)`);

  // 4. Prune deselected skills
  if (cfg.skills && Array.isArray(cfg.excludedSkills) && cfg.excludedSkills.length) {
    emit('step', { step: 'prune' });
    pruneSkills(cfg.excludedSkills, emit, appDir);
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
    } catch (e) {
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
  const agentArgv = ['run', ...(process.env.OPENCODE_RUN_ARGS || '').split(' ').filter(Boolean), prompt];
  await runStep('opencode', agentArgv, appDir, emit, {
    env: ocEnv, timeoutMs: AGENT_TIMEOUT_MS, heartbeatMs: 20000,
  });

  // Parse token/cost usage from `opencode stats` (against this entry's data dir).
  let entryStats = null;
  try {
    const text = await capture('opencode', ['stats'], appDir, dataDir ? { XDG_DATA_HOME: dataDir } : null);
    entryStats = parseOpencodeStats(text);
    entryStats.model = cfg.model;
    entryStats.updatedAt = new Date().toISOString();
    if (!entryStats.parsed) emit('log', 'warning: could not parse `opencode stats`; tokens/cost may be incomplete');
  } catch (e) {
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
  let screenshots = [];
  if (disc.routes.length) {
    try {
      screenshots = await shoot(`http://127.0.0.1:${APP_PORT}`, disc.routes, artifactDir);
      emit('log', `screenshots: ${screenshots.filter((s) => s.ok).length}/${screenshots.length} captured`);
    } catch (e) {
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

app.post('/api/run', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  // Stream to the launching tab AND record/broadcast so a reconnecting wizard can
  // re-attach. Writes are guarded: closing the launching tab must not abort the run.
  // Per-stage wall-clock, closed out when the next step starts or the run ends.
  const timings = {};
  let stepName = null, stepStart = null;
  const markStep = (name) => {
    const now = Date.now();
    if (stepName) timings[stepName] = now - stepStart;
    stepName = name; stepStart = now;
  };
  const closeStep = () => {
    if (stepName) { timings[stepName] = Date.now() - stepStart; stepName = null; }
  };

  const emit = (type, payload) => {
    const obj = typeof payload === 'string' ? { type, msg: payload } : { type, ...payload };
    if (type === 'step') markStep(obj.step);
    recordRun(obj);
    try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  };

  runState = { phase: 'running', step: null, completed: [], logs: [], result: null, error: null };
  const cfg = req.body || {};
  lastConfig = cfg;
  currentRunId = history.createRecord(cfg);

  try {
    const result = await runPipeline(cfg, { emit });
    // Begin gathering live stats (messages / tokens / cost) into /work/stats.json.
    startStats(cfg);
    emit('log', 'stats collector started → stats.json');
    emit('done', result);
    closeStep();
    history.finish(currentRunId, { status: 'success', completed: runState.completed.slice(), timings, logs: runState.logs.slice() });
  } catch (err) {
    emit('error', err.message);
    closeStep();
    history.finish(currentRunId, { status: 'error', error: err.message, completed: runState.completed.slice(), timings, logs: runState.logs.slice() });
  } finally {
    try { res.end(); } catch (_) {}
  }
});

// Switch model/key later: rewrite opencode.json + restart opencode.
app.post('/api/model', async (req, res) => {
  if (!lastConfig) return res.status(400).json({ error: 'no active session' });
  lastConfig.model = req.body.model || lastConfig.model;
  lastConfig.apiKey = req.body.apiKey || lastConfig.apiKey;
  lastConfig.customBaseUrl = req.body.customBaseUrl || lastConfig.customBaseUrl;

  // Preserve existing mcp block from the file.
  let mcp = {};
  const p = path.join(APP_DIR, 'opencode.json');
  if (fs.existsSync(p)) mcp = JSON.parse(fs.readFileSync(p, 'utf8')).mcp || {};
  writeOpencodeConfig(lastConfig, mcp, APP_DIR);

  killWatcher('opencode');
  const ocEnv = providerEnvFor(lastConfig.model, lastConfig.apiKey);
  if (lastConfig.customBaseUrl && lastConfig.apiKey) ocEnv.CUSTOM_API_KEY = lastConfig.apiKey;
  spawnWatcher('opencode', 'opencode',
    ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)], APP_DIR, ocEnv);
  try { await waitForPort(OPENCODE_PORT, 60000); } catch (_) {}
  // Collector keeps its accumulated totals; just point it at the new model. Its
  // SSE dropped when opencode was killed and reconnects to the new process.
  if (stats) stats.setModel(lastConfig.model);
  history.addModel(currentRunId, lastConfig.model);
  res.json({ ok: true, model: lastConfig.model });
});

// ---------- matrix / multi-run mode ----------

// Run the same prompt across platform × model as one-shot headless runs. Sequential
// (the app + opencode bind fixed ports, so only one entry can be live at a time).
let matrixRunning = false;
let matrixCancelled = false;
let currentChild = null; // the in-flight pipeline child (scaffold/agent/…), for cancellation
let matrixState = { running: false, matrixId: null, total: 0, done: 0, entries: [] };
const matrixClients = new Set();

function matrixBroadcast(obj) {
  const sse = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of matrixClients) { try { r.write(sse); } catch (_) {} }
}

// Heartbeat lines ("… opencode still running (Ns)") are pure liveness — collapse
// consecutive ones into a single updating line so they don't flood out real logs.
const HEARTBEAT_RE = /still running \(\d+s\)/;
const ENTRY_LOG_CAP = 800;

// Append a streamed line to an entry's retained log buffer (so reconnecting clients
// and the History record can replay it; the live SSE alone is lost on disconnect).
function pushEntryLog(entry, line) {
  if (!entry.logs) entry.logs = [];
  const logs = entry.logs;
  if (HEARTBEAT_RE.test(line) && logs.length && HEARTBEAT_RE.test(logs[logs.length - 1])) {
    logs[logs.length - 1] = line;
  } else {
    logs.push(line);
    if (logs.length > ENTRY_LOG_CAP) logs.shift();
  }
}

function newMatrixId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `mx-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

// Known MCP classes a matrix variant may toggle (angular-cli is intentionally not
// here — it's never enabled). Used to sanitize incoming variant definitions.
const MATRIX_MCP_CLASSES = ['igniteui', 'theming'];

// Short, human label for a variant: which MCPs + skills on/off.
function variantLabel(v) {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `${mcps} · ${v.skills ? 'skills' : 'no-skills'}`;
}

// Filesystem-safe, self-describing dir name for a matrix entry so the per-entry
// app/data dirs are findable at a glance (e.g. entry-0-angular-igniteui+theming-skills).
function entryDirName(i, platform, v) {
  const mcps = (v.mcps && v.mcps.length) ? v.mcps.join('+') : 'none';
  return `entry-${i}-${platform}-${mcps}-${v.skills ? 'skills' : 'noskills'}`;
}

// Normalize + dedupe the variant rows from the request.
function parseVariants(raw) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    const mcps = MATRIX_MCP_CLASSES.filter((c) => Array.isArray(v && v.mcps) && v.mcps.includes(c));
    const skills = !!(v && v.skills);
    const key = mcps.join(',') + '|' + skills;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mcps, skills });
  }
  return out;
}

async function runMatrix(combos, { prompt, matrixId, fixed }) {
  matrixBroadcast({ type: 'matrix-start', matrixId, total: combos.length, entries: matrixState.entries });
  for (let i = 0; i < combos.length; i++) {
    if (matrixCancelled) {
      // Mark this and every remaining entry as cancelled and stop.
      for (let j = i; j < combos.length; j++) {
        matrixState.entries[j].status = 'cancelled';
        matrixBroadcast({ type: 'entry-done', index: j, status: 'cancelled', runId: matrixState.entries[j].runId });
      }
      break;
    }
    const c = combos[i];
    const entry = matrixState.entries[i];
    entry.status = 'running';

    const cfg = {
      framework: c.platform,
      projectType: fixed.projectType || '',
      theme: fixed.theme || '',
      enabledMcps: c.variant.mcps,
      skills: !!c.variant.skills,
      excludedSkills: [],
      model: fixed.model,
      apiKey: fixed.apiKey,
      customBaseUrl: fixed.customBaseUrl || undefined,
    };
    const runId = history.createRecord(cfg, { mode: 'matrix', prompt, matrixId });
    entry.runId = runId;
    matrixBroadcast({ type: 'entry-start', index: i, platform: c.platform, variantLabel: c.variantLabel, runId });

    // Per-entry stage timings + completed list, surfaced through the matrix SSE.
    const timings = {};
    const completed = [];
    let stepName = null, stepStart = null;
    const markStep = (name) => {
      const now = Date.now();
      if (stepName) { timings[stepName] = now - stepStart; completed.push(stepName); }
      stepName = name; stepStart = now;
    };
    const closeStep = () => {
      if (stepName) { timings[stepName] = Date.now() - stepStart; completed.push(stepName); stepName = null; }
    };
    const emit = (type, payload) => {
      const obj = typeof payload === 'string' ? { type, msg: payload } : { type, ...payload };
      if (type === 'step') { markStep(obj.step); pushEntryLog(entry, `— ${obj.step} —`); }
      else if (type === 'log') pushEntryLog(entry, obj.msg);
      else if (type === 'error') pushEntryLog(entry, 'ERROR: ' + obj.msg);
      matrixBroadcast({ ...obj, index: i });
    };

    // Each entry gets its own project dir (and opencode data dir) so a previous
    // entry's still-dying dev server can't make this one's cleanup throw ENOTEMPTY.
    const entryDir = path.join(WORK, 'matrix', matrixId, entryDirName(i, c.platform, c.variant));
    const appDir = path.join(entryDir, 'app');
    const dataDir = path.join(entryDir, '.opencode-data');
    const artifactDir = path.join(ARTIFACT_DIR, runId);
    // Track the current child so Cancel can kill it. If cancellation already
    // arrived between steps, kill this one immediately so the pipeline aborts now
    // instead of running the step (e.g. don't start the agent after Cancel).
    const onChild = (child) => {
      currentChild = child;
      if (matrixCancelled) killTree(child, 'SIGTERM');
    };
    try {
      const result = await runPipeline(cfg, { emit, headless: true, prompt, dataDir, artifactDir, onChild, appDir });
      closeStep();
      if (result.stats) history.updateStats(runId, result.stats);
      // The agent ran fine but the edited app may not compile — flag that distinctly
      // from a clean success so "0 shots" isn't mistaken for "app had no routes".
      const status = matrixCancelled ? 'cancelled'
        : (result.appReady === false ? 'build-error' : 'success');
      const buildErr = status === 'build-error' ? (result.appError || 'app build failed') : null;
      history.finish(runId, { status, error: buildErr, completed, timings, screenshots: result.screenshots || [], logs: entry.logs || [] });
      entry.status = status;
      matrixBroadcast({
        type: 'entry-done', index: i, status, runId,
        screenshots: result.screenshots || [], stats: result.stats || null, error: buildErr,
      });
    } catch (err) {
      closeStep();
      // runPipeline threw (cancel / timeout / error) before its own cleanup stage —
      // free any watcher and reclaim disk here so the kept entry dir isn't left heavy.
      await killWatcher('app'); await killWatcher('opencode');
      try { await cleanupAppDir(appDir, emit); } catch (_) {}
      const status = matrixCancelled ? 'cancelled' : 'error';
      history.finish(runId, { status, error: matrixCancelled ? 'cancelled' : err.message, completed, timings, logs: entry.logs || [] });
      entry.status = status;
      matrixBroadcast({ type: 'entry-done', index: i, status, runId, error: status === 'error' ? err.message : null });
    } finally {
      currentChild = null;
    }
    matrixState.done = i + 1;
  }
  killWatcher('app'); killWatcher('opencode');
  matrixState.running = false;
  matrixRunning = false;
  matrixBroadcast({ type: 'matrix-done', matrixId, total: combos.length, cancelled: matrixCancelled });
}

// Kick off a matrix: body = { prompt, platforms[], variants[], model, apiKey, ... }.
// Axes are platforms × variants (each variant = a set of MCPs + skills on/off); the
// model + API key are one fixed config applied to every entry.
app.post('/api/matrix', (req, res) => {
  if (matrixRunning) return res.status(409).json({ ok: false, error: 'a matrix run is already in progress' });
  const body = req.body || {};
  const platforms = (body.platforms || []).filter((p) => FRAMEWORKS[p]);
  const variants = parseVariants(body.variants);
  const model = String(body.model || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!platforms.length || !variants.length) {
    return res.status(400).json({ ok: false, error: 'select at least one platform and one variant' });
  }
  if (!model) return res.status(400).json({ ok: false, error: 'a model is required for matrix runs' });
  if (!prompt) return res.status(400).json({ ok: false, error: 'a prompt is required for matrix runs' });

  let combos = [];
  for (const platform of platforms) for (const variant of variants) {
    combos.push({ platform, variant, variantLabel: variantLabel(variant) });
  }
  let dropped = 0;
  if (combos.length > MATRIX_MAX_ENTRIES) {
    dropped = combos.length - MATRIX_MAX_ENTRIES;
    combos = combos.slice(0, MATRIX_MAX_ENTRIES);
  }

  const matrixId = newMatrixId();
  matrixRunning = true;
  matrixCancelled = false;
  matrixState = {
    running: true, matrixId, total: combos.length, done: 0,
    entries: combos.map((c, i) => ({
      index: i, platform: c.platform, variantLabel: c.variantLabel,
      mcps: c.variant.mcps, skills: c.variant.skills, status: 'pending', runId: null,
    })),
  };
  // Respond immediately; the client follows progress via /api/matrix/stream.
  res.json({ ok: true, matrixId, total: combos.length, dropped });
  runMatrix(combos, { prompt, matrixId, fixed: { model, apiKey: body.apiKey, customBaseUrl: body.customBaseUrl } }).catch((e) => {
    matrixRunning = false; matrixState.running = false;
    matrixBroadcast({ type: 'error', msg: e.message });
  });
});

app.get('/api/matrix/status', (_req, res) => {
  res.json({ ok: true, ...matrixState });
});

// Abort the in-progress matrix: kill whatever the current entry is running (whole
// process group — scaffold/npm-install, ai-config, or the agent) plus app/opencode,
// which rejects the current entry's pipeline; the loop then sees `matrixCancelled`
// and skips the rest.
app.post('/api/matrix/cancel', (_req, res) => {
  if (!matrixRunning) return res.status(400).json({ ok: false, error: 'no matrix run in progress' });
  matrixCancelled = true;
  killTree(currentChild, 'SIGTERM');
  killWatcher('app'); killWatcher('opencode');
  matrixBroadcast({ type: 'log', msg: 'cancellation requested — stopping the current step' });
  res.json({ ok: true });
});

app.get('/api/matrix/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'state', state: matrixState })}\n\n`);
  matrixClients.add(res);
  req.on('close', () => matrixClients.delete(res));
});

// Persisted run history (cross-container). List is newest-first; detail by id.
app.get('/api/history', (_req, res) => {
  res.json({ ok: true, runs: history.list() });
});

app.get('/api/history/:id', (req, res) => {
  const run = history.get(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, run });
});

// Delete every record of one matrix submission (and its screenshot artifacts).
// Registered before /:id so "matrix" isn't captured as an id.
app.delete('/api/history/matrix/:matrixId', async (req, res) => {
  const matrixId = req.params.matrixId;
  const ids = history.list().filter((r) => r.matrixId === matrixId).map((r) => r.id);
  for (const id of ids) {
    history.remove(id);
    try { await rmrf(path.join(ARTIFACT_DIR, id)); } catch (_) {}
  }
  res.json({ ok: true, deleted: ids.length });
});

// Delete a single run record and its screenshot artifacts.
app.delete('/api/history/:id', async (req, res) => {
  const id = req.params.id;
  if (id === currentRunId && runState.phase === 'running') {
    return res.status(409).json({ ok: false, error: 'run is still in progress' });
  }
  const removed = history.remove(id);
  if (!removed) return res.status(404).json({ ok: false, error: 'not found' });
  try { await rmrf(path.join(ARTIFACT_DIR, id)); } catch (_) {}
  res.json({ ok: true });
});

// Structured live stats for the current session (messages / tokens / cost).
app.get('/api/stats', (_req, res) => {
  if (!stats) return res.json({ ok: true, stats: null });
  res.json({ ok: true, stats: stats.snapshot() });
});

// Push stats to the wizard in real time as the collector updates stats.json.
app.get('/api/stats/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (stats) res.write(`data: ${JSON.stringify(stats.snapshot())}\n\n`);
  statsClients.add(res);
  req.on('close', () => statsClients.delete(res));
});

// Re-attach to an in-progress (or finished) pipeline run: replay current state,
// then stream subsequent events so a reopened wizard follows it to completion.
app.get('/api/run/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'state', state: publicRunState() })}\n\n`);
  runClients.add(res);
  req.on('close', () => runClients.delete(res));
});

// Token usage + cost for this session, straight from `opencode stats`.
// Returns the plain-text report; the wizard renders it in a <pre>.
app.get('/api/usage', async (_req, res) => {
  const cwd = fs.existsSync(APP_DIR) ? APP_DIR : WORK;
  try {
    const text = await capture('opencode', ['stats'], cwd);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    app: !!procs.app && !procs.app.killed,
    opencode: !!procs.opencode && !procs.opencode.killed,
    appPort: APP_PORT,
    opencodePort: OPENCODE_PORT,
    model: lastConfig && lastConfig.model,
    phase: runState.phase,
  });
});

// Settle any records left 'running' by a previous container that stopped mid-run.
try {
  const reaped = history.reapStale();
  if (reaped) console.log(`history: marked ${reaped} stale run(s) as interrupted`);
} catch (e) { console.error(`history reap failed: ${e.message}`); }

app.listen(WIZARD_PORT, '0.0.0.0', () =>
  console.log(`Ignite UI MCP Testbed UI started on port ${WIZARD_PORT} (http://localhost:${WIZARD_PORT})`));
