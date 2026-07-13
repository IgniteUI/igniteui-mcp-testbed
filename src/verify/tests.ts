'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { spawn, type ChildProcess } from 'child_process';
import { APP_PORT } from '../frameworks.ts';
import { TESTS_DIR, TEST_TIMEOUT_MS } from '../config.ts';
import { killTree } from '../proc/exec.ts';
import type { Emit, TestResult, TestFailure } from '../types.ts';

const SPEC_RE = /\.(spec|test)\.(m|c)?[jt]sx?$/;

// Playwright reports absolute spec paths under the throwaway harness; show the path
// relative to the collected specs dir (what the user actually authored) instead.
function cleanSpecPath(file: string): string {
  const marker = `${path.sep}specs${path.sep}`;
  const i = file.indexOf(marker);
  return i >= 0 ? file.slice(i + marker.length) : file;
}

// Recursively test whether a directory contains at least one Playwright spec file.
function hasSpecs(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (hasSpecs(full)) return true; }
    else if (SPEC_RE.test(e.name)) return true;
  }
  return false;
}

// Collect the relative paths of every spec file under a directory (for reporting).
function listSpecs(dir: string, base = dir, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listSpecs(full, base, out);
    else if (SPEC_RE.test(e.name)) out.push(path.relative(base, full));
  }
  return out;
}

// Resolve the node_modules root that holds `@playwright/test` (the wizard's own deps),
// so the harness can borrow it via a symlink regardless of container vs host-dev layout.
function nodeModulesRoot(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@playwright/test/package.json');
  // <nm>/@playwright/test/package.json -> <nm>
  return path.dirname(path.dirname(path.dirname(pkg)));
}

// Path to the Playwright CLI entry (run via `node <cli> test …`), avoiding reliance on
// an executable .bin shim or npx network access.
function playwrightCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('playwright/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

// Spawn the runner, streaming output through `emit`, resolving with the exit code.
// Unlike proc/exec.ts `run()`, a non-zero exit (i.e. failing tests) is NOT an error —
// we still need to parse the JSON report afterwards.
function spawnRunner(
  cmd: string, argv: string[], cwd: string, env: Record<string, string>, emit: Emit,
  onChild?: ((c: ChildProcess) => void) | null,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    emit('log', `$ ${cmd} ${argv.join(' ')}`);
    const child = spawn(cmd, argv, {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    if (onChild) onChild(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGTERM'); }, TEST_TIMEOUT_MS);
    child.stdout?.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.stderr?.on('data', (d) => emit('log', d.toString().trimEnd()));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}

// Parse Playwright's JSON reporter output into pass/fail counts + failure details.
function parseReport(reportPath: string): Omit<TestResult, 'ran' | 'ok' | 'files' | 'reportFile'> {
  const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const stats = raw.stats || {};
  const passed = Number(stats.expected || 0);
  const failed = Number(stats.unexpected || 0);
  const flaky = Number(stats.flaky || 0);
  const skipped = Number(stats.skipped || 0);
  const durationMs = stats.duration != null ? Math.round(Number(stats.duration)) : null;

  const failures: TestFailure[] = [];
  const walkSuite = (suite: any, file: string) => {
    const suiteFile = suite.file || file;
    for (const spec of suite.specs || []) {
      if (spec.ok) continue;
      let error = '';
      for (const t of spec.tests || []) {
        for (const r of t.results || []) {
          if (r.error && r.error.message) { error = String(r.error.message); break; }
          if (Array.isArray(r.errors) && r.errors[0] && r.errors[0].message) { error = String(r.errors[0].message); break; }
        }
        if (error) break;
      }
      failures.push({
        title: spec.title || '(untitled)',
        file: cleanSpecPath(spec.file || suiteFile || ''),
        error: error.replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n'),
      });
    }
    for (const child of suite.suites || []) walkSuite(child, suiteFile);
  };
  for (const suite of raw.suites || []) walkSuite(suite, suite.file || '');

  return { total: passed + failed + flaky + skipped, passed, failed, skipped, flaky, durationMs, failures };
}

export interface VerifyOpts {
  framework: string;
  appDir: string;
  artifactDir?: string | null;
  emit: Emit;
  onChild?: ((c: ChildProcess) => void) | null;
}

// Run the injected Playwright tests against the already-serving app at APP_PORT.
// Collects TESTS_DIR/shared + TESTS_DIR/<framework> (framework overlays shared),
// executes them in a throwaway harness dir beside the project, and returns a
// TestResult. Returns null when no test files are present (the stage is skipped).
export async function runVerification(
  { framework, appDir, artifactDir = null, emit, onChild = null }: VerifyOpts,
): Promise<TestResult | null> {
  const sources = [path.join(TESTS_DIR, 'shared'), path.join(TESTS_DIR, framework)]
    .filter((d) => fs.existsSync(d) && hasSpecs(d));
  if (!sources.length) {
    emit('log', `no test files under ${TESTS_DIR}/{shared,${framework}} — skipping verification`);
    return null;
  }

  // Harness lives beside the project (under /work, not the read-only /tests mount) so
  // Playwright can write its report + a node_modules symlink to the wizard's deps.
  const harness = path.join(path.dirname(appDir), '.verify');
  const specsDir = path.join(harness, 'specs');
  fs.rmSync(harness, { recursive: true, force: true });
  fs.mkdirSync(specsDir, { recursive: true });

  const files: string[] = [];
  for (const src of sources) {
    fs.cpSync(src, specsDir, { recursive: true }); // later (framework) overlays earlier (shared)
    files.push(...listSpecs(src));
  }

  // Borrow the wizard's installed @playwright/test via a node_modules symlink so the
  // copied specs resolve `@playwright/test`; NODE_PATH is a belt-and-suspenders backup.
  const nmRoot = nodeModulesRoot();
  try { fs.symlinkSync(nmRoot, path.join(harness, 'node_modules'), 'dir'); }
  catch (e: any) { emit('log', `warning: could not link node_modules for tests (${e.message})`); }

  const baseURL = `http://127.0.0.1:${APP_PORT}`;
  const reportRel = 'report.json';
  const configPath = path.join(harness, 'playwright.config.cjs');
  fs.writeFileSync(configPath,
    'module.exports = {\n' +
    "  testDir: './specs',\n" +
    '  fullyParallel: false,\n' +
    '  forbidOnly: false,\n' +
    '  retries: 0,\n' +
    "  reporter: [['list'], ['json', { outputFile: './" + reportRel + "' }]],\n" +
    "  outputDir: './output',\n" +
    '  timeout: 30000,\n' +
    '  use: {\n' +
    "    baseURL: '" + baseURL + "',\n" +
    '    headless: true,\n' +
    "    screenshot: 'only-on-failure',\n" +
    "    trace: 'off',\n" +
    "    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },\n" +
    '  },\n' +
    '};\n');
  // Minimal manifest so Playwright treats the harness as its own (CJS) project root.
  fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ name: 'verify-harness', private: true }) + '\n');

  emit('log', `verify: ${files.length} test file(s) → ${baseURL}`);
  const env: Record<string, string> = { NODE_PATH: nmRoot, CI: '1', APP_BASE_URL: baseURL };

  let res: { code: number | null; timedOut: boolean };
  try {
    res = await spawnRunner('node', [playwrightCli(), 'test', '--config', configPath], harness, env, emit, onChild);
  } catch (e: any) {
    emit('error', `verify: runner failed to start (${e.message})`);
    return { ran: false, ok: false, total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: null, files, failures: [], error: e.message };
  }

  const reportPath = path.join(harness, reportRel);
  if (!fs.existsSync(reportPath)) {
    const reason = res.timedOut ? `timed out after ${TEST_TIMEOUT_MS}ms` : `no report produced (exit ${res.code})`;
    emit('error', `verify: ${reason}`);
    return { ran: false, ok: false, total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: null, files, failures: [], error: reason };
  }

  let parsed: Omit<TestResult, 'ran' | 'ok' | 'files' | 'reportFile'>;
  try {
    parsed = parseReport(reportPath);
  } catch (e: any) {
    emit('error', `verify: could not parse report (${e.message})`);
    return { ran: false, ok: false, total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: null, files, failures: [], error: e.message };
  }

  // Persist the raw JSON report alongside the run's screenshots (cross-container store).
  let reportFile: string | null = null;
  if (artifactDir) {
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.copyFileSync(reportPath, path.join(artifactDir, 'test-report.json'));
      reportFile = 'test-report.json';
    } catch (e: any) { emit('log', `warning: could not save test report (${e.message})`); }
  }

  const ok = !res.timedOut && parsed.failed === 0;
  const result: TestResult = { ran: true, ok, ...parsed, files, reportFile, error: res.timedOut ? 'timed out' : null };
  emit('log', `verify: ${parsed.passed}/${parsed.total} passed`
    + (parsed.failed ? `, ${parsed.failed} failed` : '')
    + (parsed.flaky ? `, ${parsed.flaky} flaky` : '')
    + (parsed.skipped ? `, ${parsed.skipped} skipped` : ''));
  for (const f of parsed.failures) emit('log', `  ✗ ${f.title} (${f.file})`);
  return result;
}
