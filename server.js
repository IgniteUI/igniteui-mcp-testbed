'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { FRAMEWORKS, APP_PORT, subst } = require('./lib/frameworks');
const { translate } = require('./lib/mcp-translate');
const { StatsCollector } = require('./lib/stats');

const WIZARD_PORT = Number(process.env.WIZARD_PORT || 8080);
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const WORK = process.env.WORK_DIR || '/work';
const APP_DIR = path.join(WORK, 'app');
const LOG_DIR = path.join(WORK, 'logs');

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

// Long-lived child processes for this session (one app, one opencode).
const procs = { app: null, opencode: null };
let lastConfig = null; // remembered so /api/model can rebuild opencode.json
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

// Run a command to completion, streaming its output through `emit`.
function run(cmd, argv, cwd, emit) {
  return new Promise((resolve, reject) => {
    emit('log', `$ ${cmd} ${argv.join(' ')}`);
    const child = spawn(cmd, argv, { cwd, env: process.env });
    child.stdout.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.stderr.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

// Run a command to completion and resolve with its captured stdout (for tools
// like `opencode stats` whose output we want to return rather than stream).
function capture(cmd, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with code ${code}`)));
  });
}

// Spawn a detached, long-running watcher; tee its output to a log file.
function spawnWatcher(name, cmd, argv, cwd, extraEnv) {
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
  });
  procs[name] = child;
  return child;
}

function killWatcher(name) {
  if (procs[name] && !procs[name].killed) {
    try { procs[name].kill('SIGTERM'); } catch (_) {}
  }
  procs[name] = null;
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

function providerEnvFor(model, apiKey) {
  const prefix = String(model).split('/')[0];
  const key = PROVIDER_ENV[prefix];
  return key && apiKey ? { [key]: apiKey } : {};
}

// Build the opencode.json the agent will read.
function writeOpencodeConfig(cfg, mcp) {
  const doc = {
    $schema: 'https://opencode.ai/config.json',
    model: cfg.model,
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
  fs.writeFileSync(path.join(APP_DIR, 'opencode.json'), JSON.stringify(doc, null, 2));
}

// Write a framework `prepare` file, merging instead of clobbering when one already
// exists. For MSBuild props/targets we inject our PropertyGroup before the closing
// </Project> (later definitions win, so our properties override); other existing
// files are left untouched so we never overwrite template-provided content.
function writePrepareFile(dest, body, emit) {
  const rel = path.relative(APP_DIR, dest);
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
function pruneSkills(excluded, emit) {
  const base = path.join(APP_DIR, '.claude', 'skills');
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

app.post('/api/run', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  // Stream to the launching tab AND record/broadcast so a reconnecting wizard can
  // re-attach. Writes are guarded: closing the launching tab must not abort the run.
  const emit = (type, payload) => {
    const obj = typeof payload === 'string' ? { type, msg: payload } : { type, ...payload };
    recordRun(obj);
    try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  };

  runState = { phase: 'running', step: null, completed: [], logs: [], result: null, error: null };
  const cfg = req.body || {};
  lastConfig = cfg;
  const fw = FRAMEWORKS[cfg.framework];
  if (!fw) { emit('error', `unknown framework: ${cfg.framework}`); return res.end(); }

  try {
    ensureDirs();
    // Clean any previous attempt in this (already ephemeral) container.
    killWatcher('app'); killWatcher('opencode');
    fs.rmSync(APP_DIR, { recursive: true, force: true });

    // 1. Scaffold
    emit('step', { step: 'scaffold' });
    const vars = { name: 'app', dir: APP_DIR, type: cfg.projectType || '', theme: cfg.theme || '', port: APP_PORT };
    const scaffoldCwd = fw.scaffold.cwdIsParent ? WORK : WORK;
    await run(fw.scaffold.cmd, subst(fw.scaffold.argv, vars), scaffoldCwd, emit);

    // Drop any framework-specific files into the fresh project (e.g. Blazor's
    // Directory.Build.props that relocates obj/bin off the bind mount).
    for (const [rel, body] of Object.entries(fw.prepare || {})) {
      writePrepareFile(path.join(APP_DIR, rel), subst([body], vars)[0], emit);
    }

    // 2. AI config (skills + MCP definitions), non-interactive via flags.
    emit('step', { step: 'configure' });
    const agents = cfg.skills ? ['claude'] : ['none'];
    await run('ig', [
      'ai-config',
      '--framework', fw.aiFramework,
      '--agents', ...agents,
      '--assistants', 'vscode',
    ], APP_DIR, emit);

    // 3. Translate .vscode/mcp.json -> opencode.json (with MCP toggles).
    emit('step', { step: 'translate' });
    let vscodeMcp = {};
    const mcpPath = path.join(APP_DIR, '.vscode', 'mcp.json');
    if (fs.existsSync(mcpPath)) {
      vscodeMcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } else {
      emit('log', 'no .vscode/mcp.json found; continuing with empty MCP set');
    }
    // The user toggles MCPs by class (igniteui / theming / angular). We classify
    // each discovered server by name+command with explicit precedence so the
    // generic "ignite" match can't swallow the theming server. Unclassified
    // servers are kept enabled and logged, so nothing is silently dropped.
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
      const on = cls === 'other' ? true : selected.has(cls);
      if (on) enabled.add(name);
      emit('log', `mcp "${name}" → ${cls} → ${on ? 'enabled' : 'disabled'}`);
    }
    const { mcp, warnings } = translate(vscodeMcp, { enabled, workspaceFolder: APP_DIR });
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
    writeOpencodeConfig(cfg, mcp);
    emit('log', `opencode.json written (${Object.keys(mcp).length} MCP servers, ${[...enabled].length} enabled)`);

    // 4. Prune deselected skills
    if (cfg.skills && Array.isArray(cfg.excludedSkills) && cfg.excludedSkills.length) {
      emit('step', { step: 'prune' });
      pruneSkills(cfg.excludedSkills, emit);
    }

    // 5. Launch app dev server (watch) on APP_PORT
    emit('step', { step: 'launch-app' });
    spawnWatcher('app', fw.dev.cmd, subst(fw.dev.argv, vars), APP_DIR, fw.dev.env || {});
    try {
      await waitForPort(APP_PORT, 180000, emit);
      emit('log', `app is serving on :${APP_PORT}`);
    } catch (e) {
      emit('log', `app not confirmed ready (${e.message}); check logs/app.log`);
    }

    // 6. Launch opencode web
    emit('step', { step: 'launch-opencode' });
    const ocEnv = providerEnvFor(cfg.model, cfg.apiKey);
    if (cfg.customBaseUrl && cfg.apiKey) ocEnv.CUSTOM_API_KEY = cfg.apiKey;
    spawnWatcher('opencode', 'opencode',
      ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)], APP_DIR, ocEnv);
    await waitForPort(OPENCODE_PORT, 60000, emit);

    // Begin gathering live stats (messages / tokens / cost) into /work/stats.json.
    startStats(cfg);
    emit('log', 'stats collector started → stats.json');

    emit('done', { opencodePort: OPENCODE_PORT, appPort: APP_PORT });
  } catch (err) {
    emit('error', err.message);
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
  writeOpencodeConfig(lastConfig, mcp);

  killWatcher('opencode');
  const ocEnv = providerEnvFor(lastConfig.model, lastConfig.apiKey);
  if (lastConfig.customBaseUrl && lastConfig.apiKey) ocEnv.CUSTOM_API_KEY = lastConfig.apiKey;
  spawnWatcher('opencode', 'opencode',
    ['web', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)], APP_DIR, ocEnv);
  try { await waitForPort(OPENCODE_PORT, 60000); } catch (_) {}
  // Collector keeps its accumulated totals; just point it at the new model. Its
  // SSE dropped when opencode was killed and reconnects to the new process.
  if (stats) stats.setModel(lastConfig.model);
  res.json({ ok: true, model: lastConfig.model });
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

app.listen(WIZARD_PORT, '0.0.0.0', () =>
  console.log(`Ignite UI testbed wizard on http://0.0.0.0:${WIZARD_PORT}`));
