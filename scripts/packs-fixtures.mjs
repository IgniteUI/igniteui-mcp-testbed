// Fixture assertions for provider packs: validatePack (v1 + v2), the v1→v2 upgrade,
// class qualification, folder loading and the path-containment checks.
// Run: npm run packs:test (part of the pre-commit gate).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-fixtures-'));
const providersDir = path.join(root, 'providers');
fs.mkdirSync(providersDir);
process.env.PROVIDERS_DIR = providersDir;
process.env.WORK_DIR = path.join(root, 'work');
process.env.HISTORY_DIR = path.join(root, 'history');
// Must be set before the first import: src/secrets.ts scrubs SECRET_* when it loads.
process.env.SECRETS_DIR = path.join(root, 'secrets');
process.env.TESTS_DIR = path.join(root, 'tests');
process.env.SECRET_REVEAL_KEY = 'sk-reveal-0123456789';
process.env.SECRET_SHORT = 'abc';

const reg = await import('../src/provider-registry.ts');
// The built-in Ignite UI pack, as server.ts loads it before anything else.
reg.loadBuiltins();
const { normMcpClass } = await import('../src/mcp-class.ts');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
}
function throws(name, fn, re) {
  try { fn(); } catch (e) {
    if (re.test(e.message)) { passed++; return; }
    failures.push(`${name}\n    expected error ${re}\n    got: ${e.message}`);
    return;
  }
  failures.push(`${name}\n    expected an error matching ${re}, nothing was thrown`);
}

const fw = (id) => ({
  id, label: id,
  scaffold: { cmd: 'npx', argv: ['create', '{{name}}'], cwdIsParent: true },
  dev: { cmd: 'npm', argv: ['run', 'dev', '--', '--port', '{{port}}'] },
});

const v1 = {
  name: 'mat', displayName: 'Mat',
  frameworks: [fw('mat-ng')],
  configure: {
    mcpServers: [
      { name: 'ng-cli', command: 'npx', args: ['-y', '@angular/cli', 'mcp'], class: 'angular', label: 'Angular CLI MCP', description: 'docs' },
      { name: 'ng-cli-2', command: 'ng', class: 'angular', label: 'second label ignored' },
    ],
    skills: { label: 'Install skills', github: 'owner/repo' },
  },
};

const v2 = {
  $schema: './provider.schema.json',
  schemaVersion: 2, name: 'reveal', displayName: 'Reveal',
  frameworks: [fw('reveal-node')],
  mcp: {
    classes: [{ id: 'docs', label: 'Reveal docs', default: false }],
    servers: [{ name: 'reveal', class: 'docs', command: 'reveal-mcp' }],
  },
  skills: { label: 'Reveal skills', sources: [{ github: 'RevealBi/skills' }, { command: ['sh', '-c', 'true'] }] },
};

// ── v1 upgrade ──────────────────────────────────────────────────────────────
{
  const p = reg.validatePack(structuredClone(v1));
  check('v1: schemaVersion', p.schemaVersion, 2);
  check('v1: origin defaults to inline', p.origin, 'inline');
  check('v1: servers sharing a class collapse into one class', p.mcp.classes,
    [{ id: 'mat/angular', label: 'Angular CLI MCP', description: 'docs' }]);
  check('v1: servers keep their order and get qualified classes', p.mcp.servers.map((s) => [s.name, s.class]),
    [['ng-cli', 'mat/angular'], ['ng-cli-2', 'mat/angular']]);
  check('v1: github skills become a source', p.skills, { label: 'Install skills', sources: [{ github: 'owner/repo' }] });
  check('v1: no configure key left', 'configure' in p, false);

  const ic = structuredClone(v1);
  ic.configure.skills = { label: 'x', installCommand: ['npx', 'skills', 'add'] };
  check('v1: installCommand becomes a command source', reg.validatePack(ic).skills.sources, [{ command: ['npx', 'skills', 'add'] }]);

  throws('v1: missing mcpServers', () => reg.validatePack({ name: 'x', displayName: 'X', frameworks: [fw('x')] }), /configure\.mcpServers/);
  const badLabel = structuredClone(v1); delete badLabel.configure.mcpServers[0].label;
  throws('v1: server label required', () => reg.validatePack(badLabel), /label is required/);
  const badGh = structuredClone(v1); badGh.configure.skills.github = '--upload-pack=evil';
  throws('v1: unsafe github ref', () => reg.validatePack(badGh), /owner\/repo/);
}

// ── v2 ──────────────────────────────────────────────────────────────────────
{
  const p = reg.validatePack(structuredClone(v2));
  check('v2: classes qualified', p.mcp.classes, [{ id: 'reveal/docs', label: 'Reveal docs', default: false }]);
  check('v2: servers qualified', p.mcp.servers, [{ name: 'reveal', class: 'reveal/docs', command: 'reveal-mcp' }]);
  check('v2: skill sources kept in order', p.skills.sources, [{ github: 'RevealBi/skills' }, { command: ['sh', '-c', 'true'] }]);
  check('v2: $schema dropped', '$schema' in p, false);
  check('v2: no mcp block ⇒ empty', reg.validatePack({ ...structuredClone(v2), mcp: undefined }).mcp, { classes: [], servers: [] });

  const mut = (f) => { const b = structuredClone(v2); f(b); return b; };
  throws('v2: unknown top-level field', () => reg.validatePack(mut((b) => { b.templates = []; })), /unknown field "templates"/);
  throws('v2: unsupported schemaVersion', () => reg.validatePack(mut((b) => { b.schemaVersion = 3; })), /unsupported schemaVersion/);
  throws('v2: server class must be declared', () => reg.validatePack(mut((b) => { b.mcp.servers[0].class = 'other'; })), /not declared in mcp\.classes/);
  throws('v2: duplicate class', () => reg.validatePack(mut((b) => { b.mcp.classes.push({ id: 'docs', label: 'again' }); })), /declared twice/);
  throws('v2: duplicate server name', () => reg.validatePack(mut((b) => { b.mcp.servers.push({ ...b.mcp.servers[0] }); })), /declared twice/);
  throws('v2: "custom" class is reserved', () => reg.validatePack(mut((b) => { b.mcp.classes[0].id = 'custom'; b.mcp.servers[0].class = 'custom'; })), /reserved/);
  throws('v2: class id must be a safe id', () => reg.validatePack(mut((b) => { b.mcp.classes[0].id = 'a/b'; })), /disallowed characters/);
  throws('v2: skill source needs exactly one kind', () => reg.validatePack(mut((b) => { b.skills.sources = [{ github: 'a/b', command: ['x'] }]; })), /exactly one/);
  throws('v2: duplicate framework id', () => reg.validatePack(mut((b) => { b.frameworks.push(fw('reveal-node')); })), /declared twice/);
  throws('v2: __proto__ pack name', () => reg.validatePack(mut((b) => { b.name = '__proto__'; })), /disallowed characters/);
  throws('v2: path-like pack name', () => reg.validatePack(mut((b) => { b.name = '../x'; })), /disallowed characters/);
}

// ── containment ─────────────────────────────────────────────────────────────
{
  const withPrepare = (rel) => { const b = structuredClone(v2); b.frameworks[0].prepare = { [rel]: 'x' }; return b; };
  check('prepare: nested relative path is fine', reg.validatePack(withPrepare('sub/Directory.Build.props')).frameworks[0].prepare, { 'sub/Directory.Build.props': 'x' });
  throws('prepare: .. climb', () => reg.validatePack(withPrepare('../../etc/passwd')), /must not leave/);
  throws('prepare: hidden .. climb', () => reg.validatePack(withPrepare('a/../../b')), /must not leave/);
  throws('prepare: absolute posix', () => reg.validatePack(withPrepare('/etc/passwd')), /must be relative/);
  throws('prepare: absolute windows', () => reg.validatePack(withPrepare('C:\\x')), /must be relative/);
  throws('prepare: backslash climb', () => reg.validatePack(withPrepare('..\\x')), /must not leave/);

  const dir = path.join(root, 'contain', 'pack');
  fs.mkdirSync(path.join(dir, 'template'), { recursive: true });
  fs.mkdirSync(path.join(root, 'contain', 'outside'));
  const folderPack = reg.validatePack(structuredClone(v2), { origin: 'folder', dir });
  check('resolvePackPath: inside', reg.resolvePackPath(folderPack, 'template'), path.join(dir, 'template'));
  throws('resolvePackPath: climb', () => reg.resolvePackPath(folderPack, '../outside'), /must not leave/);
  throws('resolvePackPath: absolute', () => reg.resolvePackPath(folderPack, path.join(root, 'contain', 'outside')), /must be relative/);
  throws('resolvePackPath: inline pack has no folder', () => reg.resolvePackPath(reg.validatePack(structuredClone(v2)), 'template'), /not a folder pack/);
  let linked = false;
  try { fs.symlinkSync(path.join(root, 'contain', 'outside'), path.join(dir, 'escape'), 'junction'); linked = true; } catch { /* no symlink rights */ }
  if (linked) throws('resolvePackPath: symlink escape', () => reg.resolvePackPath(folderPack, 'escape'), /resolves outside/);
}

// ── qualification helpers ───────────────────────────────────────────────────
{
  check('env fold of a qualified class', normMcpClass('angular-material/angular'), 'angular_material_angular');
}

// ── loadAll: file + folder packs ────────────────────────────────────────────
{
  fs.writeFileSync(path.join(providersDir, 'mat.json'), JSON.stringify(v1));
  fs.mkdirSync(path.join(providersDir, 'reveal'));
  fs.writeFileSync(path.join(providersDir, 'reveal', 'pack.json'), JSON.stringify(v2));
  fs.mkdirSync(path.join(providersDir, 'misnamed'));
  fs.writeFileSync(path.join(providersDir, 'misnamed', 'pack.json'), JSON.stringify({ ...v2, name: 'other', frameworks: [fw('other-fw')] }));
  fs.mkdirSync(path.join(providersDir, 'not-a-pack'));
  fs.writeFileSync(path.join(providersDir, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(providersDir, 'igniteui.json'), JSON.stringify({ ...v1, name: 'igniteui', frameworks: [fw('ig-x')] }));

  const warn = console.warn, log = console.log, warnings = [];
  console.warn = (m) => warnings.push(String(m));
  console.log = () => {};
  reg.loadAll();
  console.warn = warn; console.log = log;

  check('loadAll: built-in first, then the file and folder packs', reg.listPacks().map((p) => [p.name, p.origin]),
    [['igniteui', 'builtin'], ['mat', 'file'], ['reveal', 'folder']]);
  check('loadAll: folder pack keeps its dir', reg.getPack('reveal').dir, path.join(providersDir, 'reveal'));
  check('loadAll: folder name must match pack name', warnings.some((w) => /misnamed.*rename one/.test(w)), true);
  check('loadAll: igniteui reserved', warnings.some((w) => /igniteui.*reserved/.test(w)), true);
  check('loadAll: other warnings', warnings.length, 2);
  check('publicPack hides dir', 'dir' in reg.publicPack(reg.getPack('reveal')), false);
  check('framework registered', !!reg.getFramework('reveal-node'), true);

  check('canonical: bare → qualified', reg.canonicalMcpClasses('mat-ng', ['angular', 'custom']), ['mat/angular', 'custom']);
  check('canonical: built-in pack qualified too', reg.canonicalMcpClasses('angular', ['igniteui', 'theming', 'custom']), ['igniteui/igniteui', 'igniteui/theming', 'custom']);

  throws('deletePack refuses folder packs', () => reg.deletePack('reveal'), /folder pack/);
  throws('savePack refuses to shadow a folder pack', () => reg.savePack(v2, reg.validatePack(structuredClone(v2))), /folder pack/);

  const authored = { ...structuredClone(v1), name: 'saved', frameworks: [fw('saved-fw')] };
  reg.savePack(authored, reg.validatePack(structuredClone(authored)));
  check('savePack writes the authored body, not the normalized one',
    JSON.parse(fs.readFileSync(path.join(providersDir, 'saved.json'), 'utf8')).configure.mcpServers.length, 2);
  check('savePack registers as a file pack', reg.getPack('saved').origin, 'file');
  reg.deletePack('saved');
  check('deletePack removes the file', fs.existsSync(path.join(providersDir, 'saved.json')), false);

  throws('framework id clash across packs', () => reg.registerPack(reg.validatePack({ ...structuredClone(v2), name: 'thief' })), /already registered by pack "reveal"/);
  throws('built-in framework id clash', () => reg.registerPack(reg.validatePack({ ...structuredClone(v2), name: 'x2', frameworks: [fw('angular')] })), /built-in/);
}

// ── skill sources (1b) ──────────────────────────────────────────────────────
{
  const { matchesInclude, hashSkills, installPackSkills, describeSkillSource } = await import('../src/pipeline/pack-skills.ts');
  const { pruneSkills } = await import('../src/pipeline/skills.ts');
  const { execFileSync } = await import('child_process');

  const withSources = (sources, origin = 'inline', dir) =>
    reg.validatePack({ ...structuredClone(v2), skills: { label: 's', sources } }, { origin, dir });

  check('github: ref/path/include kept',
    withSources([{ github: 'o/r', ref: 'v1.2.0', path: 'pkg/skills', include: ['ig-*'] }]).skills.sources,
    [{ github: 'o/r', ref: 'v1.2.0', path: 'pkg/skills', include: ['ig-*'] }]);
  check('github: sha ref ok', withSources([{ github: 'o/r', ref: '0123abcd' }]).skills.sources[0].ref, '0123abcd');
  throws('github: ref starting with -', () => withSources([{ github: 'o/r', ref: '--upload-pack=x' }]), /ref must be/);
  throws('github: ref with ..', () => withSources([{ github: 'o/r', ref: 'a..b' }]), /ref must be/);
  throws('github: ref with space', () => withSources([{ github: 'o/r', ref: 'a b' }]), /ref must be/);
  throws('github: path climb', () => withSources([{ github: 'o/r', path: '../x' }]), /must not leave/);
  throws('github: bad include glob', () => withSources([{ github: 'o/r', include: ['../x'] }]), /include must be/);
  throws('github: empty include', () => withSources([{ github: 'o/r', include: [] }]), /include must be/);
  throws('command: include not allowed', () => withSources([{ command: ['x'], include: ['a'] }]), /not valid on a "command"/);
  throws('dir: needs a folder pack', () => withSources([{ dir: 'skills' }]), /needs a folder pack/);
  throws('dir: needs a folder pack (file)', () => withSources([{ dir: 'skills' }], 'file'), /needs a folder pack/);
  throws('dir: climb', () => withSources([{ dir: '../x' }], 'folder', root), /must not leave/);
  throws('dir: ref not allowed', () => withSources([{ dir: 'skills', ref: 'main' }], 'folder', root), /not valid on a "dir"/);

  check('describe github', describeSkillSource({ github: 'o/r', ref: 'main', path: 'skills' }), 'github:o/r@main/skills');
  check('describe github default ref', describeSkillSource({ github: 'o/r' }), 'github:o/r@HEAD');
  check('include: glob', [matchesInclude('ig-grid', ['ig-*']), matchesInclude('other', ['ig-*']), matchesInclude('x', undefined)], [true, false, true]);
  check('include: dot is literal', matchesInclude('igXgrid', ['ig.grid']), false);

  // A folder pack with two dir sources and a command source.
  const packDir = path.join(root, 'skillpack');
  const mk = (rel, body) => { fs.mkdirSync(path.dirname(path.join(packDir, rel)), { recursive: true }); fs.writeFileSync(path.join(packDir, rel), body); };
  mk('pack.json', '{}');
  mk('skills/ig-grid/SKILL.md', 'grid v1');
  mk('skills/ig-chart/SKILL.md', 'chart');
  mk('skills/ig-chart/ref/a.md', 'ref');
  mk('skills/other/SKILL.md', 'other');
  mk('skills/no-manifest/README.md', 'not a skill');
  mk('extra/ig-grid/SKILL.md', 'grid v2');
  const pack = reg.validatePack({ ...structuredClone(v2), skills: { label: 's', sources: [
    { dir: 'skills', include: ['ig-*'] },
    { dir: 'extra' },
    { command: [process.execPath, '-e', "require('fs').mkdirSync('from-cmd')"] },
  ] } }, { origin: 'folder', dir: packDir });

  const appSkills = path.join(root, 'app', '.agents', 'skills');
  const logs = [], records = [];
  const runStep = async (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd });
  await installPackSkills(pack, appSkills, (_t, m) => logs.push(m), runStep, records);
  check('install: records per source', records.map((r) => [r.source, r.skills]),
    [['dir:skills', ['ig-chart', 'ig-grid']], ['dir:extra', ['ig-grid']], [`command:${process.execPath} -e require('fs').mkdirSync('from-cmd')`, ['from-cmd']]]);
  check('install: dir sources hashed, command not', records.map((r) => typeof r.hash), ['string', 'string', 'undefined']);
  check('install: later source replaces same-named skill', fs.readFileSync(path.join(appSkills, 'ig-grid', 'SKILL.md'), 'utf8'), 'grid v2');
  check('install: replacement is logged', logs.some((l) => /"ig-grid".*replaces/.test(l)), true);
  check('install: excluded and manifest-less folders skipped', fs.readdirSync(appSkills).sort(), ['from-cmd', 'ig-chart', 'ig-grid']);

  const copy = path.join(root, 'copy');
  fs.cpSync(appSkills, copy, { recursive: true });
  check('hash: location-independent', hashSkills(copy, ['ig-chart']), hashSkills(appSkills, ['ig-chart']));
  fs.writeFileSync(path.join(copy, 'ig-chart', 'ref', 'a.md'), 'changed');
  check('hash: content-sensitive', hashSkills(copy, ['ig-chart']) === hashSkills(appSkills, ['ig-chart']), false);

  const failing = reg.validatePack({ ...structuredClone(v2), skills: { label: 's', sources: [{ dir: 'skills', include: ['other'] }, { dir: 'missing' }] } }, { origin: 'folder', dir: packDir });
  const rec2 = [];
  let threw = false;
  try { await installPackSkills(failing, path.join(root, 'app2'), () => {}, runStep, rec2); } catch { threw = true; }
  check('install: a missing source fails the install', threw, true);
  check('install: records survive the failure', rec2.map((r) => [r.source, r.skills, !!r.error]), [['dir:skills', ['other'], false], ['dir:missing', [], true]]);

  const pruneLogs = [];
  pruneSkills(['ig-chart', '../../app2', 'a/b'], (_t, m) => pruneLogs.push(m), path.join(root, 'app'));
  check('prune: removes a named skill', fs.existsSync(path.join(appSkills, 'ig-chart')), false);
  check('prune: refuses path-like names', pruneLogs.filter((l) => /ignored excluded skill/.test(l)).length, 2);
  check('prune: climb target untouched', fs.existsSync(path.join(root, 'app2')), true);
}

// ── secrets (1c) ────────────────────────────────────────────────────────────
{
  const sec = await import('../src/secrets.ts');
  const { writeOpencodeConfig } = await import('../src/pipeline/opencode-config.ts');

  check('scrub: SECRET_* gone from process.env', ['SECRET_REVEAL_KEY', 'SECRET_SHORT'].map((k) => k in process.env), [false, false]);
  check('scrub: kept privately', sec.envSecretNames().sort(), ['REVEAL_KEY', 'SHORT']);

  const secretsPack = (secrets, fwOverride = {}) => ({
    ...structuredClone(v2), name: 'lic', frameworks: [{ ...fw('lic-fw'), ...fwOverride }], secrets,
  });
  const ok = reg.validatePack(secretsPack(
    [{ name: 'REVEAL_KEY' }, { name: 'REVEAL_LICENSE', file: 'license.key', description: 'license' }, { name: 'OPTIONAL_TOKEN', required: false }],
    { dev: { cmd: 'npm', argv: ['run', 'dev'], env: { LICENSE_PATH: '{{secret:REVEAL_LICENSE}}', MODE: 'x' } } }));
  check('validate: secrets kept', ok.secrets.map((s) => s.name), ['REVEAL_KEY', 'REVEAL_LICENSE', 'OPTIONAL_TOKEN']);
  throws('validate: lowercase name', () => reg.validatePack(secretsPack([{ name: 'key' }])), /UPPER_SNAKE_CASE/);
  throws('validate: reserved name', () => reg.validatePack(secretsPack([{ name: 'NODE_OPTIONS' }])), /reserved/);
  throws('validate: duplicate', () => reg.validatePack(secretsPack([{ name: 'A' }, { name: 'A' }])), /declared twice/);
  throws('validate: file climb', () => reg.validatePack(secretsPack([{ name: 'A', file: '../other/x' }])), /must not leave/);
  throws('validate: unknown field', () => reg.validatePack(secretsPack([{ name: 'A', value: 'x' }])), /not a valid field/);
  throws('validate: secret in argv', () => reg.validatePack(secretsPack([{ name: 'A' }],
    { scaffold: { cmd: 'x', argv: ['--key={{secret:A}}'] } })), /must not reference a secret/);
  throws('validate: undeclared reference', () => reg.validatePack(secretsPack([{ name: 'A' }],
    { scaffold: { cmd: 'x', argv: [], env: { K: '{{secret:B}}' } } })), /undeclared secret "B"/);
  throws('validate: env must be strings', () => reg.validatePack(secretsPack([],
    { dev: { cmd: 'x', argv: [], env: { K: 1 } } })), /string values/);

  const status = () => Object.fromEntries(sec.secretStatus(ok).map((s) => [s.name, [s.kind, s.set, s.required]]));
  check('status: file absent', status(), { REVEAL_KEY: ['env', true, true], REVEAL_LICENSE: ['file', false, true], OPTIONAL_TOKEN: ['env', false, false] });
  check('missing: only required', sec.missingSecrets(ok).map((m) => [m.name, m.source]), [['REVEAL_LICENSE', './secrets/lic/license.key']]);

  const secDir = path.join(root, 'secrets', 'lic');
  fs.mkdirSync(secDir, { recursive: true });
  fs.writeFileSync(path.join(secDir, 'license.key'), '');
  check('status: empty file counts as missing', status().REVEAL_LICENSE[1], false);
  fs.writeFileSync(path.join(secDir, 'license.key'), 'LICENSE-BODY');
  check('status: file present', status().REVEAL_LICENSE[1], true);
  check('missing: none', sec.missingSecrets(ok).length, 0);

  const env = sec.secretEnv(ok, ok.frameworks[0].dev.env);
  check('env: env secret by value, file secret by path, refs expanded', env, {
    REVEAL_KEY: 'sk-reveal-0123456789', REVEAL_LICENSE: path.join(secDir, 'license.key'),
    LICENSE_PATH: path.join(secDir, 'license.key'), MODE: 'x',
  });
  check('env: no pack ⇒ extra only', sec.secretEnv(undefined, { A: '1' }), { A: '1' });
  check('env: unset optional ref ⇒ empty', sec.secretEnv(
    reg.validatePack(secretsPack([{ name: 'OPTIONAL_TOKEN', required: false }])), { T: 'x{{secret:OPTIONAL_TOKEN}}y' }).T, 'xy');

  const outside = path.join(root, 'secrets-outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'k'), 'stolen');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(secDir, 'link'), 'junction'); linked = true; } catch { /* no symlink rights */ }
  if (linked) {
    const viaLink = reg.validatePack(secretsPack([{ name: 'VIA_LINK', file: 'link/k' }]));
    check('status: symlink out of the pack folder is not set', sec.secretStatus(viaLink)[0].set, false);
  }

  check('mask: long value', sec.maskSecrets('key=sk-reveal-0123456789!'), 'key=***!');
  check('mask: short value left alone', sec.maskSecrets('abc abc'), 'abc abc');
  const seen = [];
  const masked = sec.maskingEmit((t, p) => seen.push([t, p]));
  masked('log', 'echo sk-reveal-0123456789');
  masked('error', { msg: 'sk-reveal-0123456789' });
  masked('done', { v: 'sk-reveal-0123456789' });
  check('maskingEmit: log/error masked, others untouched', seen,
    [['log', 'echo ***'], ['error', { msg: '***' }], ['done', { v: 'sk-reveal-0123456789' }]]);

  // secretEnv above resolved the license file, which registers its contents.
  check('mask: file secret contents', sec.maskSecrets('cat → LICENSE-BODY'), 'cat → ***');
  const lm = sec.lineMasker();
  const parts = [lm.push('key=sk-rev'), lm.push('eal-0123456789\nnext'), lm.flush()];
  check('lineMasker: secret split across chunks is masked', parts, ['', 'key=***\n', 'next']);

  const { run } = await import('../src/proc/exec.ts');
  const logs = [];
  const script = "process.stdout.write('k=sk-rev');setTimeout(()=>process.stdout.write('eal-0123456789\\ndone'),150)";
  await run(process.execPath, ['-e', script], root, (t, m) => { if (t === 'log') logs.push(m); }, { maskOutput: true });
  check('run maskOutput: split secret never emitted', logs.slice(1).join('|'), 'k=***|done');

  // Registered so writeOpencodeConfig and publicPack find it by framework.
  reg.registerPack(ok);
  const pub = JSON.stringify(reg.publicPack(reg.getPack('lic')));
  check('publicPack: no secret value or file body', [pub.includes('sk-reveal'), pub.includes('LICENSE-BODY')], [false, false]);
  check('publicPack: status shape', reg.publicPack(reg.getPack('lic')).secrets[0], {
    name: 'REVEAL_KEY', kind: 'env', required: true, set: true, source: 'SECRET_REVEAL_KEY' });

  const app = path.join(root, 'oc-app');
  fs.mkdirSync(app);
  const cfgFor = (framework) => ({ framework, model: 'anthropic/x' });
  const read = () => JSON.parse(fs.readFileSync(path.join(app, 'opencode.json'), 'utf8'));
  const sd = process.env.SECRETS_DIR;
  process.env.OPENCODE_MAJOR = '2';
  writeOpencodeConfig(cfgFor('lic-fw'), {}, app);
  const denies = read().permissions.filter((r) => r.effect === 'deny' && r.action !== 'websearch');
  check('opencode 2.x: secrets denied', denies.map((r) => `${r.action} ${r.resource}`).sort(),
    ['edit', 'external_directory', 'read'].flatMap((a) => [`${a} ${sd}/*`, `${a} ${sd}/**`]).sort());
  check('opencode 2.x: allow-all stays first', read().permissions[0], { action: '*', resource: '*', effect: 'allow' });
  writeOpencodeConfig(cfgFor('angular'), {}, app);
  check('opencode 2.x: no secrets ⇒ unchanged rules', read().permissions.length, 2);
  process.env.OPENCODE_MAJOR = '1';
  writeOpencodeConfig(cfgFor('lic-fw'), {}, app);
  check('opencode 1.x: pattern maps', read().permission.read, { '*': 'allow', [`${sd}/*`]: 'deny', [`${sd}/**`]: 'deny' });
  writeOpencodeConfig(cfgFor('angular'), {}, app);
  check('opencode 1.x: no secrets ⇒ plain allow', read().permission, 'allow');
  delete process.env.OPENCODE_MAJOR;
  reg.unregisterPack('lic');
}

// ── scaffold / tests / builds / routes / provenance (1d) ────────────────────
{
  const { fillVars, copyTemplate } = await import('../src/pipeline/template.ts');
  const { discoverRoutes } = await import('../src/capture/route-discovery.ts');
  const { buildFailedRe, BUILD_FAILED_RE } = await import('../src/proc/ports.ts');
  const { frameworkTests } = await import('../src/verify/tests.ts');
  const history = await import('../src/history.ts');

  const withFw = (over, origin = 'inline', dir) =>
    reg.validatePack({ ...structuredClone(v2), name: 'tp', frameworks: [{ ...fw('tp-fw'), ...over }] }, { origin, dir });
  const tmpl = { scaffold: { kind: 'template', from: 'template/node' } };

  check('template: ok on a folder pack', withFw(tmpl, 'folder', root).frameworks[0].scaffold, { kind: 'template', from: 'template/node' });
  throws('template: needs a folder pack', () => withFw(tmpl), /needs a folder pack/);
  throws('template: from climb', () => withFw({ scaffold: { kind: 'template', from: '../x' } }, 'folder', root), /must not leave/);
  throws('template: cmd not allowed', () => withFw({ scaffold: { kind: 'template', from: 't', cmd: 'x' } }, 'folder', root), /not valid on a template/);
  throws('scaffold: unknown kind', () => withFw({ scaffold: { kind: 'git', from: 't' } }), /"command" or "template"/);
  throws('scaffold: command still needs cmd', () => withFw({ scaffold: { argv: [] } }), /scaffold\.cmd is required/);

  check('buildFailed: kept', withFw({ buildFailed: ['error TS\\d+', 'Build failed'] }).frameworks[0].buildFailed, ['error TS\\d+', 'Build failed']);
  throws('buildFailed: bad regex', () => withFw({ buildFailed: ['(unclosed'] }), /not a valid regex/);
  throws('buildFailed: too long', () => withFw({ buildFailed: ['x'.repeat(201)] }), /1–200/);
  throws('buildFailed: empty', () => withFw({ buildFailed: [] }), /non-empty/);
  const re = buildFailedRe(['error TS\\d+', 'Build failed']);
  check('buildFailedRe: matches either, case-insensitive', [re.test('src/a.ts: ERROR TS2322'), re.test('build FAILED'), re.test('compiled ok')], [true, true, false]);
  check('buildFailedRe: none ⇒ null', buildFailedRe(undefined), null);
  check('built-in markers unchanged', BUILD_FAILED_RE.test('Application bundle generation failed'), true);

  check('routes: static', withFw({ routes: { kind: 'static', paths: ['/', '/dash'] } }).frameworks[0].routes, { kind: 'static', paths: ['/', '/dash'] });
  throws('routes: bad kind', () => withFw({ routes: { kind: 'sitemap' } }), /kind must be one of/);
  throws('routes: static path without /', () => withFw({ routes: { kind: 'static', paths: ['dash'] } }), /starting with "\/"/);
  throws('routes: paths only for static', () => withFw({ routes: { kind: 'razor', paths: ['/'] } }), /only valid with kind "static"/);
  throws('routes: bad fallback', () => withFw({ routes: { kind: 'razor', fallback: 'razor' } }), /fallback must be/);
  check('routes: pack default', reg.getFramework('reveal-node').routes, { kind: 'route-config', fallback: 'state-nav' });
  check('routes: built-ins explicit', ['angular', 'react', 'webcomponents', 'blazor'].map((f) => reg.getFramework(f).routes), [
    { kind: 'route-config' }, { kind: 'route-config', fallback: 'state-nav' }, { kind: 'route-config', fallback: 'state-nav' }, { kind: 'razor' }]);

  const emptyApp = path.join(root, 'routes-app');
  fs.mkdirSync(emptyApp);
  check('discoverRoutes: static', discoverRoutes(emptyApp, { kind: 'static', paths: ['/', '/a', '/a'] }).routes, ['/', '/a']);
  check('discoverRoutes: nothing found, no fallback', discoverRoutes(emptyApp, { kind: 'route-config' }).routes, []);
  fs.mkdirSync(path.join(emptyApp, 'src'));
  fs.writeFileSync(path.join(emptyApp, 'src', 'app.routes.ts'), "export const routes = [{ path: '' }, { path: 'grid' }];");
  check('discoverRoutes: route-config', discoverRoutes(emptyApp, { kind: 'route-config', fallback: 'state-nav' }).routes, ['/grid']);

  check('fillVars: known filled, unknown and spaced left alone',
    fillVars('{{name}}:{{port}} {{title}} {{ name }}', { name: 'app', port: 5000 }), 'app:5000 {{title}} {{ name }}');
  const tsrc = path.join(root, 'tmpl-src');
  fs.mkdirSync(path.join(tsrc, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tsrc, 'package.json'), '{"name":"{{name}}","scripts":{"dev":"vite --port {{port}}"}}');
  fs.writeFileSync(path.join(tsrc, 'src', 'app.html'), '<h1>{{title}}</h1>');
  fs.writeFileSync(path.join(tsrc, '{{name}}.config'), 'x');
  const bin = Buffer.from([0x89, 0x50, 0x00, 0x7b, 0x7b, 0x6e, 0x61, 0x6d, 0x65, 0x7d, 0x7d]);
  fs.writeFileSync(path.join(tsrc, 'logo.png'), bin);
  let tlinked = false;
  try { fs.symlinkSync(path.join(root, 'secrets-outside'), path.join(tsrc, 'escape'), 'junction'); tlinked = true; } catch { /* no symlink rights */ }
  const tdest = path.join(root, 'tmpl-dest');
  const tlogs = [];
  const n = copyTemplate(tsrc, tdest, { name: 'app', port: 5000 }, (_t, m) => tlogs.push(m));
  check('copyTemplate: file count', n, 4);
  check('copyTemplate: vars filled', JSON.parse(fs.readFileSync(path.join(tdest, 'package.json'), 'utf8')), { name: 'app', scripts: { dev: 'vite --port 5000' } });
  check('copyTemplate: app bindings kept', fs.readFileSync(path.join(tdest, 'src', 'app.html'), 'utf8'), '<h1>{{title}}</h1>');
  check('copyTemplate: names filled', fs.existsSync(path.join(tdest, 'app.config')), true);
  check('copyTemplate: binary untouched', fs.readFileSync(path.join(tdest, 'logo.png')).equals(bin), true);
  if (tlinked) check('copyTemplate: symlink skipped', [fs.existsSync(path.join(tdest, 'escape')), tlogs.some((l) => /symlink skipped/.test(l))], [false, true]);
  throws('copyTemplate: var turning a name into a path', () => copyTemplate(tsrc, path.join(root, 'tmpl-dest2'), { name: '../x', port: 1 }, () => {}), /expands to/);

  fs.mkdirSync(path.join(root, 'tests', 'reveal-node'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'reveal-node', 'a.spec.ts'), '');
  fs.mkdirSync(path.join(providersDir, 'reveal', 'tests', 'reveal-node', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(providersDir, 'reveal', 'tests', 'reveal-node', 'a.spec.ts'), '');
  fs.writeFileSync(path.join(providersDir, 'reveal', 'tests', 'reveal-node', 'sub', 'b.spec.ts'), '');
  fs.writeFileSync(path.join(providersDir, 'reveal', 'tests', 'reveal-node', 'notes.md'), '');
  check('tests: host and pack specs side by side', frameworkTests('reveal-node').map((f) => f.split(path.sep).join('/')).sort(),
    ['@reveal/a.spec.ts', '@reveal/sub/b.spec.ts', 'a.spec.ts']);
  check('tests: file pack has none of its own', frameworkTests('mat-ng'), []);

  throws('versions: unknown framework', () => reg.validatePack({ ...structuredClone(v2), versions: [{ name: 'x', cmd: 'x', argv: [], frameworks: ['nope'] }] }), /framework ids/);
  throws('versions: secret in argv', () => reg.validatePack({ ...structuredClone(v2), versions: [{ name: 'x', cmd: 'x', argv: ['{{secret:A}}'] }] }), /must not reference a secret/);
  throws('versions: duplicate', () => reg.validatePack({ ...structuredClone(v2), versions: [{ name: 'x', cmd: 'a', argv: [] }, { name: 'x', cmd: 'b', argv: [] }] }), /declared twice/);

  const reordered = Object.fromEntries(Object.entries(structuredClone(v2)).reverse());
  check('hash: JSON key order irrelevant', reg.validatePack(reordered).hash, reg.validatePack(structuredClone(v2)).hash);
  check('hash: JSON content sensitive', reg.validatePack({ ...structuredClone(v2), version: '2' }).hash === reg.validatePack(structuredClone(v2)).hash, false);
  const revealDir = path.join(providersDir, 'reveal');
  const h1 = reg.hashPackFolder(revealDir);
  fs.writeFileSync(path.join(revealDir, 'tests', 'reveal-node', 'a.spec.ts'), 'changed');
  check('hash: any file in the pack folder counts', reg.hashPackFolder(revealDir) === h1, false);
  fs.mkdirSync(path.join(revealDir, 'node_modules'));
  fs.writeFileSync(path.join(revealDir, 'node_modules', 'x'), 'y');
  fs.writeFileSync(path.join(revealDir, '.DS_Store'), 'y');
  const h2 = reg.hashPackFolder(revealDir);
  fs.rmSync(path.join(revealDir, 'node_modules'), { recursive: true });
  check('hash: node_modules and dot files ignored', reg.hashPackFolder(revealDir), h2);

  const stored = history.redact({ framework: 'reveal-node', enabledMcps: [] });
  check('redact: pack provenance', stored.pack, { name: 'reveal', hash: reg.getPack('reveal').hash, origin: 'folder' });
  check('redact: built-in pack provenance', history.redact({ framework: 'angular' }).pack, { name: 'igniteui', hash: reg.getPack('igniteui').hash, origin: 'builtin' });
}

// ── provider data for the UI (2) ────────────────────────────────────────────
{
  const { providerOf } = await import('../src/provider-of.ts');
  const history = await import('../src/history.ts');

  const withOpts = (options, extra = {}) => reg.validatePack({ ...structuredClone(v2), name: 'op', frameworks: [fw('op-fw')], options, ...extra });
  check('options: kept', withOpts([{ id: 'theme', label: 'Theme', choices: ['light', 'dark'], default: 'dark' }, { id: 'title', label: 'Title' }]).options,
    [{ id: 'theme', label: 'Theme', choices: ['light', 'dark'], default: 'dark' }, { id: 'title', label: 'Title' }]);
  throws('options: reserved id', () => withOpts([{ id: 'port', label: 'P' }]), /reserved/);
  throws('options: id with a hyphen', () => withOpts([{ id: 'my-opt', label: 'P' }]), /letters, digits and underscores/);
  throws('options: duplicate', () => withOpts([{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }]), /declared twice/);
  throws('options: default outside choices', () => withOpts([{ id: 'a', label: 'A', choices: ['x'], default: 'y' }]), /one of its choices/);
  throws('options: unknown field', () => withOpts([{ id: 'a', label: 'A', required: true }]), /not a valid field/);

  throws('class frameworks: must be the pack\'s', () => reg.validatePack({ ...structuredClone(v2),
    mcp: { classes: [{ id: 'docs', label: 'D', frameworks: ['angular'] }], servers: [] } }), /framework ids/);
  check('class frameworks: kept', reg.validatePack({ ...structuredClone(v2),
    mcp: { classes: [{ id: 'docs', label: 'D', frameworks: ['reveal-node'] }], servers: [] } }).mcp.classes[0].frameworks, ['reveal-node']);

  reg.registerPack(withOpts([{ id: 'theme', label: 'Theme', choices: ['light', 'dark'], default: 'dark' }, { id: 'title', label: 'Title' }]));
  check('resolve: defaults filled', reg.resolveRunOptions('op-fw', undefined), { theme: 'dark', title: '' });
  check('resolve: given values', reg.resolveRunOptions('op-fw', { theme: 'light', title: 'Hi' }), { theme: 'light', title: 'Hi' });
  throws('resolve: undeclared id', () => reg.resolveRunOptions('op-fw', { color: 'x' }), /not declared/);
  throws('resolve: outside choices', () => reg.resolveRunOptions('op-fw', { theme: 'blue' }), /one of light, dark/);
  throws('resolve: multi-line', () => reg.resolveRunOptions('op-fw', { title: 'a\nb' }), /single-line/);
  throws('resolve: not a string', () => reg.resolveRunOptions('op-fw', { title: 3 }), /single-line/);
  check('resolve: built-in options', reg.resolveRunOptions('angular', { type: 'igx-ts' }), { type: 'igx-ts', theme: '' });
  check('resolve: unknown framework has none', reg.resolveRunOptions('nope', {}), {});

  const ui = reg.listProvidersForUi();
  check('ui: built-in first', [ui[0].name, ui[0].origin], ['igniteui', 'builtin']);
  check('ui: built-in frameworks in UI order', ui[0].frameworks.map((f) => f.id), ['angular', 'blazor', 'react', 'webcomponents']);
  check('ui: built-in classes qualified', ui[0].mcp.classes.map((c) => c.id), ['igniteui/igniteui', 'igniteui/theming', 'igniteui/angular']);
  check('ui: angular class only for angular', ui[0].mcp.classes[2].frameworks, ['angular']);
  check('ui: packs follow', ui.slice(1).some((p) => p.name === 'op'), true);
  check('ui: no container paths', JSON.stringify(ui).includes(providersDir.replace(/\\/g, '\\\\')), false);

  check('providerFor', ['angular', 'op-fw', 'nope'].map((f) => reg.providerFor(f)), ['igniteui', 'op', undefined]);
  check('redact: provider and options', (({ provider, options }) => ({ provider, options }))(history.redact({ framework: 'op-fw', options: { theme: 'light', title: '' } })),
    { provider: 'op', options: { theme: 'light', title: '' } });
  check('redact: built-in provider', history.redact({ framework: 'angular' }).provider, 'igniteui');
  check('providerOf: new record', providerOf({ provider: 'op' }), 'op');
  check('providerOf: 1d pack record', providerOf({ pack: { name: 'reveal' } }), 'reveal');
  check('providerOf: older record ⇒ Ignite UI', [providerOf({}), providerOf(null)], ['igniteui', 'igniteui']);
  reg.unregisterPack('op');
}

// ── built-in pack and the unified configure path (3) ────────────────────────
{
  const { classifyByRules } = await import('../src/pipeline/mcp-config.ts');
  const { expandEnvRefs } = await import('../src/frameworks.ts');

  const ig = reg.getPack('igniteui');
  check('builtin: origin and frameworks', [ig.origin, ig.frameworks.map((f) => f.id)], ['builtin', ['angular', 'blazor', 'react', 'webcomponents']]);
  check('builtin: framework ids registered', ['angular', 'react', 'webcomponents', 'blazor'].every((f) => reg.providerFor(f) === 'igniteui'), true);
  throws('builtin: cannot be removed', () => reg.deletePack('igniteui'), /built-in/);
  throws('builtin: cannot be replaced by an upload', () => reg.savePack({}, { ...structuredClone(ig), origin: 'file' }), /reserved/);
  throws('builtin: name reserved for other packs', () => reg.registerPack({ ...reg.validatePack({ ...structuredClone(v2), name: 'igniteui', frameworks: [fw('ig-y')] }) }), /reserved/);
  throws('builtin: framework ids reserved', () => reg.registerPack(reg.validatePack({ ...structuredClone(v2), name: 'thief2', frameworks: [fw('react')] })), /built-in framework id/);

  const rules = ig.mcp.source.rules;
  check('rules: theming before ignite', classifyByRules('igniteui-theming', { command: 'npx', args: ['igniteui-theming'] }, rules), 'igniteui/theming');
  check('rules: angular before ignite', classifyByRules('angular-cli', { command: 'npx', args: ['@angular/cli', 'mcp'] }, rules), 'igniteui/angular');
  check('rules: generic ignite', classifyByRules('igniteui-cli', { command: 'npx', args: ['igniteui-cli', 'mcp'] }, rules), 'igniteui/igniteui');
  check('rules: no match ⇒ other', classifyByRules('github', { command: 'gh-mcp' }, rules), 'other');

  check('commands: pack default', reg.resolveMcpCommand('igniteui/igniteui'), ['ig', 'mcp']);
  check('commands: class without a default', reg.resolveMcpCommand('igniteui/angular'), undefined);
  check('commands: custom', reg.resolveMcpCommand('custom'), undefined);
  check('commands: no env override ⇒ nothing to stamp', [reg.mcpOverrideFor('igniteui/igniteui'), reg.mcpOverridesForStatus()], [undefined, {}]);

  const base = () => ({ ...structuredClone(v2), name: 'p3', frameworks: [fw('p3-fw')] });
  check('configure: kept', reg.validatePack({ ...base(), configure: [{ cmd: 'x', argv: ['--fw', '{{name}}'], frameworks: ['p3-fw'] }] }).configure,
    [{ cmd: 'x', argv: ['--fw', '{{name}}'], frameworks: ['p3-fw'] }]);
  throws('configure: unknown framework', () => reg.validatePack({ ...base(), configure: [{ cmd: 'x', argv: [], frameworks: ['nope'] }] }), /framework ids/);
  throws('configure: secret in argv', () => reg.validatePack({ ...base(), configure: [{ cmd: 'x', argv: ['{{secret:A}}'] }] }), /secret/);
  throws('configure: builtin hook not supported', () => reg.validatePack({ ...base(), configure: [{ builtin: 'x' }] }), /not a valid field/);
  const withSource = (source, commands) => reg.validatePack({ ...base(), mcp: { classes: [{ id: 'docs', label: 'D' }], servers: [], source, ...(commands ? { commands } : {}) } });
  check('source: qualified rules', withSource({ files: ['.mcp.json'], rules: [{ match: 'docs', class: 'docs' }] }).mcp.source.rules, [{ match: 'docs', class: 'p3/docs' }]);
  throws('source: undeclared class', () => withSource({ files: ['.mcp.json'], rules: [{ match: 'x', class: 'other' }] }), /one of mcp.classes/);
  throws('source: file climb', () => withSource({ files: ['../x.json'], rules: [] }), /must not leave/);
  check('commands: qualified keys', withSource({ files: ['.mcp.json'], rules: [] }, { docs: ['docs-mcp'] }).mcp.commands, { 'p3/docs': ['docs-mcp'] });
  throws('commands: undeclared class', () => withSource({ files: ['.mcp.json'], rules: [] }, { nope: ['x'] }), /not one of mcp.classes/);
  throws('mcp: unknown field', () => reg.validatePack({ ...base(), mcp: { classes: [], servers: [], extra: 1 } }), /mcp.extra/);

  const withVars = (vars) => reg.validatePack({ ...base(), frameworks: [{ ...fw('p3-fw'), vars }] });
  check('vars: kept', withVars({ tpl: '{{env:BLAZOR_TEMPLATE|igb-blazor}}' }).frameworks[0].vars, { tpl: '{{env:BLAZOR_TEMPLATE|igb-blazor}}' });
  throws('vars: reserved name', () => withVars({ port: '1' }), /reserved/);
  throws('vars: reading a secret', () => withVars({ k: '{{env:SECRET_X}}' }), /isn't allowed/);
  process.env.P3_TEMPLATE = 'from-env';
  check('expandEnvRefs', [expandEnvRefs('{{env:P3_TEMPLATE|d}}'), expandEnvRefs('{{env:P3_UNSET|d}}'), expandEnvRefs('{{env:P3_UNSET}}x')], ['from-env', 'd', 'x']);
  delete process.env.P3_TEMPLATE;
}

// ── container deps and pack validation (4) ──────────────────────────────────
{
  const deps = await import('../src/pack-deps.ts');
  const { validatePackCli } = await import('../src/pack-validate.ts');

  const withDeps = (npmGlobal) => reg.validatePack({ ...structuredClone(v2), name: 'd4', frameworks: [fw('d4-fw')], containerDeps: { npmGlobal } });
  check('deps: registry names and versions accepted',
    withDeps(['reveal-cli', '@scope/pkg@^1.2.3', 'x@1.0.0', 'y@latest']).containerDeps.npmGlobal.length, 4);
  for (const bad of ['git+https://github.com/a/b.git', '../local', '-g', 'file:x', 'a b', 'https://x/y.tgz', 'UPPER']) {
    throws(`deps: rejects ${bad}`, () => withDeps([bad]), /registry package name/);
  }

  const none = reg.validatePack(structuredClone(v2));
  check('deps: none declared ⇒ nothing to install', [await deps.ensurePackDeps(none), deps.packDepsStatus(none).state], [{}, 'none']);
  const declared = withDeps(['left-pad@1.3.0']);
  check('deps: declared, not started ⇒ pending', deps.packDepsStatus(declared).state, 'pending');
  process.env.MATRIX_VALIDATE = '1';
  deps.startPackDeps(declared);
  check('deps: validate-only modes never start an install', deps.packDepsStatus(declared).state, 'pending');
  delete process.env.MATRIX_VALIDATE;
  check('deps: per-pack prefix', deps.packDepsDir('d4').split(path.sep).join('/').endsWith('/d4'), true);

  const run = async (target) => {
    const out = [], log = console.log, err = console.error;
    console.log = (m) => out.push(String(m)); console.error = (m) => out.push(String(m));
    try { return { code: await validatePackCli(target), out }; } finally { console.log = log; console.error = err; }
  };
  const mkPack = (name, body, files = {}) => {
    const dir = path.join(root, 'vp', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ schemaVersion: 2, name, displayName: name, ...body }));
    for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), c); }
    return dir;
  };
  const node = { cmd: 'node', argv: [] };
  const good = mkPack('vp-good', {
    frameworks: [{ id: 'vp-good-fw', label: 'G', scaffold: { kind: 'template', from: 'template' }, dev: node }],
    mcp: { classes: [{ id: 'docs', label: 'D' }], servers: [{ name: 'docs', class: 'docs', command: 'node' }] },
  }, { 'template/package.json': '{}', 'tests/vp-good-fw/a.spec.ts': '' });
  const g = await run(good);
  check('validate: good pack exits 0', g.code, 0);
  check('validate: good pack reports no ✗', g.out.filter((l) => l.startsWith('✗')), []);
  check('validate: reports tests and the template', [g.out.some((l) => /tests for vp-good-fw/.test(l)), g.out.some((l) => /folder template present/.test(l))], [true, true]);

  const bad = mkPack('vp-bad', {
    frameworks: [{ id: 'vp-bad-fw', label: 'B', scaffold: { kind: 'template', from: 'missing' }, dev: { cmd: 'no-such-cmd-xyz', argv: [] } }],
    mcp: { classes: [{ id: 'docs', label: 'D' }, { id: 'unused', label: 'U' }], servers: [{ name: 'docs', class: 'docs', command: 'node' }] },
    secrets: [{ name: 'VP_LICENSE', file: 'license.key' }],
  });
  const b = await run(bad);
  check('validate: broken pack exits 1', b.code, 1);
  check('validate: names each problem', [
    b.out.some((l) => /✗ folder missing not found/.test(l)),
    b.out.some((l) => /✗ secret VP_LICENSE missing/.test(l)),
    b.out.some((l) => /✗ command no-such-cmd-xyz not found/.test(l)),
    b.out.some((l) => /⚠ MCP class vp-bad\/unused has no server/.test(l)),
  ], [true, true, true, true]);
  const clash = mkPack('vp-clash', { frameworks: [{ id: 'react', label: 'R', scaffold: node, dev: node }] });
  check('validate: framework id collision', (await run(clash)).out.some((l) => /✗ collision: .*built-in framework id/.test(l)), true);
  const broken = mkPack('vp-schema', { frameworks: [] });
  const s = await run(broken);
  check('validate: schema error exits 1 with the reason', [s.code, s.out.some((l) => /frameworks must be a non-empty array/.test(l))], [1, true]);
  check('validate: missing path is misuse', (await run(path.join(root, 'vp', 'nope'))).code, 2);
  for (const n of ['vp-good', 'vp-bad']) reg.unregisterPack(n);
}

// ── PR #34 review fixes ─────────────────────────────────────────────────────
{
  check('options: legacy projectType/theme fill unset options',
    reg.resolveRunOptions('angular', {}, { type: 'igx-ts', theme: 'dark' }), { type: 'igx-ts', theme: 'dark' });
  check('options: explicit option beats legacy',
    reg.resolveRunOptions('angular', { type: 'x' }, { type: 'igx-ts' }).type, 'x');

  const bfPack = (re) => ({ ...structuredClone(v2), name: 'bf', frameworks: [{ ...fw('bf-fw'), buildFailed: [re] }] });
  throws('buildFailed: nested quantifier rejected', () => reg.validatePack(bfPack('(a+)+$')), /nests quantifiers/);
  check('buildFailed: ordinary alternation kept', reg.validatePack(bfPack('(error|fail)+ in')).frameworks[0].buildFailed, ['(error|fail)+ in']);

  const { buildMcpConfig } = await import('../src/pipeline/mcp-config.ts');
  const scoped = reg.validatePack({
    schemaVersion: 2, name: 'scoped', displayName: 'Scoped', frameworks: [fw('sc-ng'), fw('sc-react')],
    mcp: {
      classes: [{ id: 'ngonly', label: 'NG', frameworks: ['sc-ng'] }, { id: 'all', label: 'All' }],
      servers: [{ name: 'ng-srv', class: 'ngonly', command: 'ng-mcp' }, { name: 'all-srv', class: 'all', command: 'all-mcp' }],
    },
  });
  const mcpApp = path.join(root, 'mcp-app');
  fs.mkdirSync(mcpApp);
  const enabledFor = (framework) => {
    const { mcp } = buildMcpConfig(scoped, { framework, enabledMcps: ['ngonly', 'all'] }, mcpApp, () => {});
    return Object.entries(mcp).filter(([, d]) => d.enabled !== false).map(([n]) => n).sort();
  };
  check('mcp: framework-limited class on for its framework', enabledFor('sc-ng'), ['all-srv', 'ng-srv']);
  check('mcp: framework-limited class off elsewhere', enabledFor('sc-react'), ['all-srv']);

  const { copyTemplate } = await import('../src/pipeline/template.ts');
  const tplSrc = path.join(root, 'tpl-src'), tplDest = path.join(root, 'tpl-dest');
  fs.mkdirSync(tplSrc);
  fs.writeFileSync(path.join(tplSrc, 'run.sh'), '#!/bin/sh\necho {{name}}\n');
  fs.chmodSync(path.join(tplSrc, 'run.sh'), 0o755);
  copyTemplate(tplSrc, tplDest, { name: 'app' }, () => {});
  if (process.platform !== 'win32') {
    check('template: executable bit kept', fs.statSync(path.join(tplDest, 'run.sh')).mode & 0o777, 0o755);
  }
  check('template: vars filled', fs.readFileSync(path.join(tplDest, 'run.sh'), 'utf8'), '#!/bin/sh\necho app\n');

  const livePack = path.join(providersDir, 'live');
  fs.mkdirSync(livePack);
  const liveBody = { schemaVersion: 2, name: 'live', displayName: 'Live', version: '1', frameworks: [fw('live-fw')] };
  fs.writeFileSync(path.join(livePack, 'pack.json'), JSON.stringify(liveBody));
  reg.registerPack(reg.readPackFrom(livePack));
  const before = reg.getPack('live').hash;
  check('refresh: unchanged folder keeps the same object', reg.refreshFolderPack('live') === reg.getPack('live'), true);
  fs.writeFileSync(path.join(livePack, 'pack.json'), JSON.stringify({ ...liveBody, version: '2' }));
  const after = reg.refreshFolderPack('live');
  check('refresh: edit reloads the pack', [after.hash !== before, reg.getPack('live').version], [true, '2']);
  fs.writeFileSync(path.join(livePack, 'pack.json'), '{ broken');
  throws('refresh: broken edit fails the run', () => reg.refreshFolderPack('live'), /changed on disk and no longer loads/);
  reg.unregisterPack('live');
  reg.unregisterPack('scoped');

  const { probeVersion } = await import('../src/pipeline/pipeline.ts');
  check('versions: banner skipped', probeVersion(' _____  _ _\r\n|_   _|\r\n\r\nIgnite UI CLI version: 15.8.2\nOS: Linux\n'), '15.8.2');
  check('versions: v-prefixed', probeVersion('v20.11.1\n'), '20.11.1');
  check('versions: prerelease kept', probeVersion('my-lib 2.0.0-beta.3'), '2.0.0-beta.3');
  check('versions: no number ⇒ first line', probeVersion('\n  unknown build\nmore'), 'unknown build');

  const { packPathEnv } = await import('../src/pack-deps.ts');
  const depsPack = { name: 'withdeps', containerDeps: { npmGlobal: ['x@1.0.0'] } };
  check('deps PATH: pack bin first, global PATH untouched',
    [packPathEnv(depsPack).PATH.split(path.delimiter)[0].endsWith(path.join('withdeps', 'bin')), process.env.PATH.includes('withdeps')],
    [true, false]);
  check('deps PATH: no deps ⇒ no PATH', packPathEnv({ name: 'none' }), {});
}

// ── the shipped example + schema ────────────────────────────────────────────
{
  const example = JSON.parse(fs.readFileSync(new URL('../provider.example.angular-material.json', import.meta.url), 'utf8'));
  check('example pack validates', reg.validatePack(example).mcp.classes.map((c) => c.id), ['angular-material/angular']);
  const schema = JSON.parse(fs.readFileSync(new URL('../provider.schema.json', import.meta.url), 'utf8'));
  // validatePack's v2 top-level keys and the schema's must not drift apart.
  check('schema top-level keys', Object.keys(schema.properties).sort(),
    ['$schema', 'configure', 'containerDeps', 'description', 'displayName', 'frameworks', 'mcp', 'name', 'options', 'schemaVersion', 'secrets', 'skills', 'version', 'versions']);
}

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`packs fixtures: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`packs fixtures: ${passed} passed`);
