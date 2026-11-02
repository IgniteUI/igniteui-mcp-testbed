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
process.env.SECRET_REVEAL_KEY = 'sk-reveal-0123456789';
process.env.SECRET_SHORT = 'abc';

const reg = await import('../src/provider-registry.ts');
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
  throws('v2: unknown top-level field', () => reg.validatePack(mut((b) => { b.options = []; })), /unknown field "options"/);
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

  check('loadAll: loads the file and folder packs', reg.listPacks().map((p) => [p.name, p.origin]).sort(), [['mat', 'file'], ['reveal', 'folder']]);
  check('loadAll: folder pack keeps its dir', reg.getPack('reveal').dir, path.join(providersDir, 'reveal'));
  check('loadAll: folder name must match pack name', warnings.some((w) => /misnamed.*rename one/.test(w)), true);
  check('loadAll: igniteui reserved', warnings.some((w) => /igniteui.*reserved/.test(w)), true);
  check('loadAll: other warnings', warnings.length, 2);
  check('publicPack hides dir', 'dir' in reg.publicPack(reg.getPack('reveal')), false);
  check('framework registered', !!reg.getFramework('reveal-node'), true);

  check('canonical: bare → qualified', reg.canonicalMcpClasses('mat-ng', ['angular', 'custom']), ['mat/angular', 'custom']);
  check('canonical: built-in framework untouched', reg.canonicalMcpClasses('angular', ['igniteui', 'theming']), ['igniteui', 'theming']);

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

// ── the shipped example + schema ────────────────────────────────────────────
{
  const example = JSON.parse(fs.readFileSync(new URL('../provider.example.angular-material.json', import.meta.url), 'utf8'));
  check('example pack validates', reg.validatePack(example).mcp.classes.map((c) => c.id), ['angular-material/angular']);
  const schema = JSON.parse(fs.readFileSync(new URL('../provider.schema.json', import.meta.url), 'utf8'));
  // validatePack's v2 top-level keys and the schema's must not drift apart.
  check('schema top-level keys', Object.keys(schema.properties).sort(),
    ['$schema', 'containerDeps', 'description', 'displayName', 'frameworks', 'mcp', 'name', 'schemaVersion', 'secrets', 'skills', 'version']);
}

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`packs fixtures: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`packs fixtures: ${passed} passed`);
