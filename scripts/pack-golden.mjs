// The phase 3 gate, offline: Ignite UI run through its built-in pack must produce what
// the code it replaced produced. scripts/fixtures/igniteui-golden.json was generated
// from that code (src/frameworks.ts's FRAMEWORKS + the 'igniteui' configure/translate stage) before the
// pack existed; this checks scaffold, configure, dev and prepare commands, and the
// opencode.json + log lines of the MCP stage over 8 scenarios × 4 frameworks.
//
// The one intended difference: classes are qualified now, so a log line's
// `→ igniteui/theming →` is compared as `→ theming →`.
//
// Runs itself a second time with MCP_CMD_IGNITEUI set (the A/B alias), since overrides
// are read once at module load. Part of `npm run packs:test`.
//
// What this can't see: the real `ig` / `dotnet` / opencode. The container matrix run
// (matrix.smoke-all-platforms.json) is still the final check.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const variant = process.argv[2] || 'plain';
if (variant === 'override' && !process.env.MCP_CMD_IGNITEUI) throw new Error('override run needs MCP_CMD_IGNITEUI');
// The operator's own settings must not change the result; only the tested override stays.
for (const k of Object.keys(process.env)) {
  if (/^(MCP_CMD_|SECRET_)/.test(k) && !(variant === 'override' && k === 'MCP_CMD_IGNITEUI')) delete process.env[k];
}
for (const k of ['IGNITEUI_MCP_CMD', 'OPENCODE_CODEMODE', 'BLAZOR_TEMPLATE', 'SECRETS_DIR', 'BUILTIN_PACKS_DIR']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-golden-'));
process.env.WORK_DIR = tmp;
process.env.HISTORY_DIR = tmp;
process.env.PROVIDERS_DIR = path.join(tmp, 'providers');
process.env.OPENCODE_MAJOR = '2';

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/igniteui-golden.json', import.meta.url), 'utf8'))[variant];
const reg = await import('../src/provider-registry.ts');
const { subst } = await import('../src/frameworks.ts');
const { runVars } = await import('../src/pipeline/pipeline.ts');
const { buildMcpConfig } = await import('../src/pipeline/mcp-config.ts');
const { writeOpencodeConfig } = await import('../src/pipeline/opencode-config.ts');
reg.loadBuiltins();

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
}

const APP = '/work/app';
const pack = reg.getPack('igniteui');
const options = { type: 'igx-ts', theme: 'default' };

for (const [id, g] of Object.entries(golden)) {
  const fw = reg.getFramework(id);
  if (!fw) { failures.push(`${id}: not in the built-in pack`); continue; }
  for (const skills of [true, false]) {
    const key = skills ? 'skills' : 'noskills';
    const vars = runVars(fw, { framework: id, options, skills, model: 'm' }, APP);
    check(`${id} scaffold (${key})`, { cmd: fw.scaffold.cmd, argv: subst(fw.scaffold.argv, vars), cwdIsParent: !!fw.scaffold.cwdIsParent }, g.scaffold[key]);
    const steps = (pack.configure || []).filter((s) => !s.frameworks || s.frameworks.includes(id));
    check(`${id} configure (${key})`, steps.flatMap((s) => [s.cmd, ...subst(s.argv, vars)]), g.configure[key]);
  }
  const vars = runVars(fw, { framework: id, options, skills: true, model: 'm' }, APP);
  check(`${id} dev`, { cmd: fw.dev.cmd, argv: subst(fw.dev.argv, vars), env: fw.dev.env || {} }, g.dev);
  check(`${id} prepare`, Object.fromEntries(Object.entries(fw.prepare || {}).map(([k, b]) => [k, subst([b], vars)[0]])), g.prepare);
  check(`${id} install`, fw.install || [], g.install);
  check(`${id} routes`, fw.routes, g.routes);

  for (const [sc, want] of Object.entries(g.mcp)) {
    const app = fs.mkdtempSync(path.join(tmp, `${id}-${sc}-`));
    const gen = want.input.generated;
    if (gen) {
      fs.mkdirSync(path.dirname(path.join(app, gen.file)), { recursive: true });
      fs.writeFileSync(path.join(app, gen.file), JSON.stringify(gen.doc));
    }
    const logs = [];
    const cfg = { framework: id, model: 'anthropic/claude-x', enabledMcps: want.input.enabledMcps, customMcp: want.input.customMcp };
    const { mcp, enabledCount } = buildMcpConfig(pack, cfg, app, (t, m) => { if (t === 'log') logs.push(m); });
    writeOpencodeConfig(cfg, mcp, app);
    logs.push(`opencode.json written (${Object.keys(mcp).length} MCP servers, ${enabledCount} enabled)`);
    // The project dir is a temp dir here and /work/app in the snapshot.
    const oc = JSON.parse(fs.readFileSync(path.join(app, 'opencode.json'), 'utf8')
      .split(JSON.stringify(app).slice(1, -1)).join(APP));
    check(`${id} mcp ${sc}: opencode.json`, oc, want.opencode);
    check(`${id} mcp ${sc}: log`, logs.map((l) => l.replace(/→ igniteui\//g, '→ ')), want.logs);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`pack golden (${variant}): ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`pack golden (${variant}): ${passed} passed`);

if (variant === 'plain') {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'override'], {
    stdio: 'inherit',
    env: { ...process.env, MCP_CMD_IGNITEUI: '/opt/local-mcp/bin/igniteui-mcp --stdio' },
  });
}
