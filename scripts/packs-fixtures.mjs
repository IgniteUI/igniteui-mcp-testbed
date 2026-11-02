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
  throws('v2: unknown top-level field', () => reg.validatePack(mut((b) => { b.secrets = []; })), /unknown field "secrets"/);
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

// ── the shipped example + schema ────────────────────────────────────────────
{
  const example = JSON.parse(fs.readFileSync(new URL('../provider.example.angular-material.json', import.meta.url), 'utf8'));
  check('example pack validates', reg.validatePack(example).mcp.classes.map((c) => c.id), ['angular-material/angular']);
  const schema = JSON.parse(fs.readFileSync(new URL('../provider.schema.json', import.meta.url), 'utf8'));
  // validatePack's v2 top-level keys and the schema's must not drift apart.
  check('schema top-level keys', Object.keys(schema.properties).sort(),
    ['$schema', 'containerDeps', 'description', 'displayName', 'frameworks', 'mcp', 'name', 'schemaVersion', 'skills', 'version']);
}

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
  console.error(`packs fixtures: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`packs fixtures: ${passed} passed`);
