#!/usr/bin/env node
// Manual smoke test for proc/exec.ts run(): the single-settlement paths, onOutput
// stream attribution, the SIGTERM -> SIGKILL escalation, the stall detector, and the
// teed spawnWatcher that makes interactive diagnostics possible. Spawns real processes and
// takes a few seconds, so it is NOT in the pre-commit hook — run it by hand
// (`npm run exec:smoke`) after touching run()'s settlement or signalling logic.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from '../src/proc/exec.ts';
import { createDiagnosticsCollector, deriveStatus } from '../src/capture/diagnostics.ts';

const log = [];
const emit = (type, payload) => log.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  ok  ' : '  FAIL') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!cond) fails++;
};

// 1. success + stream attribution
{
  const seen = [];
  const code = 'process.stdout.write("out-a"); process.stderr.write("err-b"); process.stdout.write("out-c\\n");';
  await run('node', ['-e', code], process.cwd(), emit, {
    onOutput: (stream, chunk) => seen.push([stream, chunk]),
  });
  const streams = seen.map((s) => s[0]);
  const joined = seen.filter((s) => s[0] === 'stdout').map((s) => s[1]).join('');
  ok('resolves on exit 0', true);
  ok('onOutput saw both streams', streams.includes('stdout') && streams.includes('stderr'), JSON.stringify(streams));
  ok('stdout chunks are raw/untrimmed', joined === 'out-aout-c\n', JSON.stringify(joined));
}

// 2. non-zero exit keeps the existing message shape, and is not flagged timedOut
{
  let err = null;
  try { await run('node', ['-e', 'process.exit(3)'], process.cwd(), emit, {}); }
  catch (e) { err = e; }
  ok('non-zero exit rejects', !!err);
  ok('message unchanged', err && err.message === 'node exited with code 3', err && err.message);
  ok('not flagged timedOut', err && !err.timedOut);
}

// 3. timeout on a well-behaved child: typed flag, unchanged message, dies on SIGTERM
{
  const t0 = Date.now();
  let err = null;
  try { await run('node', ['-e', 'setTimeout(()=>{}, 60000)'], process.cwd(), emit, { timeoutMs: 400 }); }
  catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok('timeout rejects', !!err);
  ok('err.timedOut is set', err && err.timedOut === true);
  ok('message template unchanged', err && err.message === 'node timed out after 400ms', err && err.message);
  ok('settles only after the tree is confirmed dead (not in-tick)', ms >= 400 && ms < 3500, ms + 'ms');
}

// 4. a child that IGNORES SIGTERM must escalate to SIGKILL and still settle as timedOut,
//    never downgraded to a generic "exited with code N" by the close listener.
{
  const t0 = Date.now();
  let err = null;
  const code = 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000);';
  try { await run('node', ['-e', code], process.cwd(), emit, { timeoutMs: 300 }); }
  catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok('SIGTERM-ignoring child still rejects', !!err);
  ok('still typed as timedOut (no downgrade race)', err && err.timedOut === true, err && err.message);
  // Windows has no process groups: killTree's negative-pid send fails ESRCH and the
  // child.kill fallback force-terminates, so the SIGTERM handler never runs and the
  // grace timer is cancelled before it can fire. The escalation is only observable on
  // Linux (the container, i.e. the real target).
  if (process.platform === 'win32') console.log('  skip escalation timing (no process groups on win32) ' + ms + 'ms');
  else ok('escalated to SIGKILL after the grace period', ms >= 4300, ms + 'ms');
}

// 5. a throwing onOutput must not fail the run
{
  let threw = null;
  try {
    await run('node', ['-e', 'console.log("hi")'], process.cwd(), emit, {
      onOutput: () => { throw new Error('observer exploded'); },
    });
  } catch (e) { threw = e; }
  ok('throwing onOutput does not fail the run', threw === null, threw && threw.message);
  ok('and is reported once in the log', log.filter((l) => String(l).includes('diagnostics failed')).length === 1);
}

// ── Detector B: the stall timer, driven by real quiet periods ───────────────────
// stallMs / onStall / onResume are RunOpts, so they belong in this file rather than
// in the fixture gate: only a real process can actually go quiet.
// Writes, goes quiet past the stall threshold, writes again, exits 0.
const child = `
process.stdout.write("working\\n");
setTimeout(() => { process.stdout.write("back\\n"); process.exit(0); }, 1400);
`;
{
  const events = [];
  const diag = createDiagnosticsCollector({ onChange: (ds) => events.push(ds.map((d) => [d.kind, !!d.resolvedAt])) });
  await run('node', ['-e', child], process.cwd(), emit, {
    stallMs: 500,
    onOutput: (s, c) => diag.onOutput(s, c),
    onStall: (ms) => diag.noteStall(ms),
    onResume: (ms) => diag.noteResume(ms),
  });
  const ds = await diag.finish({ exitCode: 0 });
  ok('stall fired during a real quiet period', ds.length === 1 && ds[0].kind === 'stalled', JSON.stringify(ds.map((d) => d.kind)));
  ok('and was marked recovered when output came back', !!ds[0]?.resolvedAt);
  ok('a recovered stall leaves the run green', deriveStatus(ds, {}) === 'success');
  ok('the live channel saw it appear and then resolve', events.length >= 2, JSON.stringify(events));
}

// Never goes quiet: no stall at all.
{
  const chatty = 'let n=0; const t=setInterval(()=>{process.stdout.write("tick\\n"); if(++n>8){clearInterval(t);process.exit(0)}},100);';
  const diag = createDiagnosticsCollector();
  await run('node', ['-e', chatty], process.cwd(), emit, {
    stallMs: 500,
    onOutput: (s, c) => diag.onOutput(s, c),
    onStall: (ms) => diag.noteStall(ms),
    onResume: (ms) => diag.noteResume(ms),
  });
  ok('a steadily-producing run raises nothing', (await diag.finish({ exitCode: 0 })).length === 0);
}

// Quiet until the deadline: the stall must be superseded, not resolved.
{
  const silent = 'setTimeout(()=>{}, 60000);';
  const diag = createDiagnosticsCollector();
  let err = null;
  try {
    await run('node', ['-e', silent], process.cwd(), emit, {
      timeoutMs: 1200, stallMs: 400,
      onOutput: (s, c) => diag.onOutput(s, c),
      onStall: (ms) => diag.noteStall(ms),
      onResume: (ms) => diag.noteResume(ms),
    });
  } catch (e) { err = e; }
  const ds = await diag.finish({ exitCode: null, timedOut: !!err?.timedOut, timeoutMs: 1200 });
  const stall = ds.find((d) => d.kind === 'stalled');
  const timeout = ds.find((d) => d.kind === 'timed-out');
  ok('a silent run raises the stall before the deadline', !!stall);
  ok('and the timeout after it', !!timeout);
  ok('the stall is superseded, not resolved', !!stall?.supersededAt && !stall?.resolvedAt);
  ok('supersededBy points at the timeout', stall?.supersededBy === timeout?.id);
  ok('status is timed-out', deriveStatus(ds, { errored: true }) === 'timed-out');
}

// A throwing stall callback must not fail the run.
{
  let threw = null;
  try {
    await run('node', ['-e', 'setTimeout(()=>process.exit(0), 900);'], process.cwd(), emit, {
      stallMs: 300, onStall: () => { throw new Error('detector exploded'); },
    });
  } catch (e) { threw = e; }
  ok('a throwing onStall does not fail the run', threw === null, threw && threw.message);
}

// ── The teed spawnWatcher, and the interactive session seam ────────────────────
// The tee must be a strict SUPERSET of the fd-redirect form it replaces: the log file
// keeps getting every byte, and the observer additionally sees it tagged by stream.
// Only a real child process can demonstrate that, hence this file rather than the
// fixture gate. WORK_DIR is set before the dynamic import because config.ts resolves
// LOG_DIR at module load.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
process.env.WORK_DIR = WORK;
fs.mkdirSync(path.join(WORK, 'logs'), { recursive: true });

const { spawnWatcher, killWatcher, procs } = await import('../src/proc/watcher.ts');

const logFile = path.join(WORK, 'logs', 'opencode.log');
const wait = (child) => new Promise((r) => child.once('close', r));

const CHILD = `
process.stdout.write("out-1\\n");
process.stderr.write("err-1\\n");
process.stdout.write("out-2 with unicode: \\u00e9\\u4e2d\\n");
setTimeout(() => process.exit(0), 60);
`;

// 1. Redirect form (no observer) — unchanged behaviour.
{
  fs.writeFileSync(logFile, '');
  const child = spawnWatcher('opencode', 'node', ['-e', CHILD], process.cwd());
  await wait(child);
  await new Promise((r) => setTimeout(r, 60));
  const text = fs.readFileSync(logFile, 'utf8');
  ok('redirect form still writes the log', text.includes('out-1') && text.includes('err-1'), JSON.stringify(text));
  procs.opencode = null;
}

// 2. Teed form — same log content, plus tagged chunks.
{
  fs.writeFileSync(logFile, '');
  const seen = [];
  const child = spawnWatcher('opencode', 'node', ['-e', CHILD], process.cwd(), {},
    { onOutput: (stream, chunk) => seen.push([stream, chunk]) });
  await wait(child);
  await new Promise((r) => setTimeout(r, 80));
  const text = fs.readFileSync(logFile, 'utf8');
  ok('teed form still writes the log', text.includes('out-1') && text.includes('err-1'), JSON.stringify(text));
  ok('log keeps multi-byte characters intact', text.includes('é中'), JSON.stringify(text));
  const joined = seen.map((x) => x[1]).join('');
  ok('observer saw the same bytes the log did', joined.split('').sort().join('') === text.split('').sort().join(''));
  ok('observer saw stdout tagged', seen.some((x) => x[0] === 'stdout' && x[1].includes('out-1')));
  ok('observer saw stderr tagged', seen.some((x) => x[0] === 'stderr' && x[1].includes('err-1')));
  procs.opencode = null;
}

// 3. A throwing observer must not take down the watcher it is watching.
{
  fs.writeFileSync(logFile, '');
  const child = spawnWatcher('opencode', 'node', ['-e', CHILD], process.cwd(), {},
    { onOutput: () => { throw new Error('observer exploded'); } });
  const code = await wait(child);
  await new Promise((r) => setTimeout(r, 60));
  ok('a throwing observer does not kill the watcher', code === 0, 'exit=' + code);
  ok('and the log is still written', fs.readFileSync(logFile, 'utf8').includes('out-1'));
  procs.opencode = null;
}

// 4. killWatcher still settles on a teed (piped) child.
{
  const child = spawnWatcher('opencode', 'node', ['-e', 'setInterval(()=>{},1000)'], process.cwd(), {},
    { onOutput: () => {} });
  const t0 = Date.now();
  await killWatcher('opencode');
  ok('killWatcher settles a piped watcher', Date.now() - t0 < 5000, (Date.now() - t0) + 'ms');
  ok('and the child is actually gone', child.exitCode !== null || child.signalCode !== null);
}

// 5. The session seam: output -> collector -> history record.
{
  process.env.HISTORY_DIR = path.join(WORK, 'history');
  fs.mkdirSync(process.env.HISTORY_DIR, { recursive: true });
  const session = await import('../src/session.ts');
  const history = await import('../src/history.ts');
  const runId = session.beginRun({ framework: 'angular', model: 'anthropic/x' });
  const ESC = String.fromCharCode(27);
  session.feedAgentOutput('stderr', `${ESC}[91mError: ${ESC}[0m{"code":401,"message":"Invalid API key"}\n`);
  await new Promise((r) => setTimeout(r, 30));
  const live = session.getDiagnostics();
  ok('session collector classified a provider error off the watcher stream',
    live.length === 1 && live[0].kind === 'auth', JSON.stringify(live.map((d) => d.kind)));
  const rec = history.get(runId);
  ok('and it accrued into the history record', (rec?.diagnostics || []).length === 1,
    JSON.stringify(rec?.diagnostics?.map((d) => d.kind)));
  ok('interactive stall detection is deliberately absent',
    live.every((d) => d.kind !== 'stalled'));
}
// 6. Every `opencode` watcher must be teed, not just the first one. /api/model kills and
// respawns it on a model switch; a respawn that forgot the observer would leave the
// session's collector deaf from then on — and because the collector keeps running, the
// resulting silence reads as health rather than as a gap.
{
  const src = fs.readFileSync(new URL('../src/routes/run.ts', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/pipeline/pipeline.ts', import.meta.url), 'utf8');
  const spawns = src.split("spawnWatcher('opencode'").length - 1;
  // Count the ones whose call carries an onOutput observer within the next few lines.
  const observed = src.split("spawnWatcher('opencode'").slice(1)
    .filter((tail) => /onOutput|agentSink/.test(tail.slice(0, 400))).length;
  ok('every opencode watcher spawn is teed', spawns > 0 && observed === spawns,
    `${observed}/${spawns}`);
}

// 7. capture() must confirm the tree is dead before rejecting. Rejecting in the tick the
// signal is sent hands the caller back while descendants are still alive — and this call
// site is the post-agent `opencode stats`, which runs on the FAILURE path, so leftovers
// there poison the next matrix entry.
{
  const { capture } = await import('../src/proc/exec.ts');
  const t0 = Date.now();
  let err = null;
  try {
    await capture('node', ['-e', 'setTimeout(()=>{}, 60000)'], process.cwd(), null, 300);
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok('capture() rejects on timeout', !!err);
  ok('capture() flags the error as timedOut', err?.timedOut === true, err?.message);
  ok('capture() settles only after close, not in the signalling tick', ms >= 300 && ms < 9000, ms + 'ms');
}

{
  const { capture } = await import('../src/proc/exec.ts');
  const out = await capture('node', ['-e', 'process.stdout.write("fine")'], process.cwd(), null, 5000);
  ok('capture() still returns stdout on success', out === 'fine', JSON.stringify(out));
}

// 8. The watcher must tell its observer when it closes, or a partial final line is both
// lost AND left to fuse with the replacement watcher's first chunk.
{
  const { spawnWatcher, procs } = await import('../src/proc/watcher.ts');
  let closed = 0;
  const seen = [];
  const child = spawnWatcher('opencode', 'node',
    ['-e', 'process.stderr.write("no trailing newline"); setTimeout(()=>process.exit(0), 40);'],
    process.cwd(), {},
    { onOutput: (stream, chunk) => seen.push(chunk), onClose: () => { closed++; } });
  await new Promise((r) => child.once('close', r));
  await new Promise((r) => setTimeout(r, 80));
  ok('watcher fires onClose', closed === 1, 'closed=' + closed);
  ok('and the unterminated chunk did reach the observer', seen.join('').includes('no trailing newline'));
  procs.opencode = null;
}

// 9. A model switch must AWAIT the old watcher's exit before rebinding the fixed port.
// Fire-and-forget lets the replacement hit EADDRINUSE while waitForPort() succeeds
// against the old process that is still listening.
{
  const src = fs.readFileSync(new URL('../src/routes/run.ts', import.meta.url), 'utf8');
  ok('/api/model awaits killWatcher before respawning', /await killWatcher\('opencode'\)/.test(src));
  const spawns = src.split("spawnWatcher('opencode'").slice(1);
  // agentSink() supplies both halves, so either spelling counts as observed.
  ok('and its respawn flushes on close too', spawns.every((t) => /onClose|agentSink/.test(t.slice(0, 400))));
}

// 10. The caller must stay BLOCKED until the tree is actually gone.
//
// `close` describes the launcher, not its descendants: `npm run x` exits on SIGTERM while
// the node process it spawned ignores it. Settling on that close hands the caller back
// four seconds ahead of the group SIGKILL, so a resistant descendant overlaps whatever
// starts next — the following matrix entry, or the replacement opencode after a model
// switch. terminateTree now resolves only on confirmed tree death or a bounded fallback,
// and run()/capture()/killWatcher() all defer settlement to it.
{
  const { terminateTree, treeAlive, KILL_GRACE_MS } = await import('../src/proc/exec.ts');

  // Ordinary case: a cooperative child costs no extra latency.
  const { spawn } = await import('child_process');
  const easy = spawn('node', ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  const res = await terminateTree(easy);
  const ms = Date.now() - t0;
  ok('terminateTree confirms a cooperative tree', res.confirmed === true);
  ok('and does not wait out the grace period to do it', ms < KILL_GRACE_MS, ms + 'ms');
  ok('treeAlive agrees the tree is gone', treeAlive(easy) === false);
}

// 11. run(): the timeout must not resolve the caller early.
{
  const { KILL_GRACE_MS } = await import('../src/proc/exec.ts');
  const resistant = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
  const t0 = Date.now();
  let err = null;
  try {
    await run('node', ['-e', resistant], process.cwd(), () => {}, { timeoutMs: 200 });
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok('run() rejects the timeout', err?.timedOut === true);
  if (process.platform === 'win32') {
    // No process groups: child.kill terminates unconditionally, so the tree really is
    // gone as soon as the launcher is, and returning promptly is correct here.
    console.log('  skip block-until-escalation timing (kill is unconditional on win32) ' + ms + 'ms');
  } else {
    ok('run() stayed blocked until the SIGKILL escalation, not the launcher close',
      ms >= KILL_GRACE_MS, ms + 'ms');
  }
  ok('run() still settles within the bounded fallback', ms < KILL_GRACE_MS + 12000, ms + 'ms');
}

// 11b. The timing contract itself, proven WITHOUT process groups so it holds on every
// platform. A stub child with pid=null makes treeAlive fall back to the launcher's own
// state, which the test then controls exactly: ignore SIGTERM, die on SIGKILL.
{
  const { EventEmitter } = await import('events');
  const { terminateTree, KILL_GRACE_MS, KILL_CONFIRM_MS } = await import('../src/proc/exec.ts');

  const stub = (dieOn) => {
    const c = new EventEmitter();
    c.pid = null; c.exitCode = null; c.signalCode = null;
    c.kill = (sig) => { if (sig === dieOn) { c.exitCode = 0; c.emit('close', 0); } };
    return c;
  };

  // Ignores SIGTERM, dies on SIGKILL: the caller must be held until the escalation.
  const resistant = stub('SIGKILL');
  const t0 = Date.now();
  const r1 = await terminateTree(resistant);
  const ms1 = Date.now() - t0;
  ok('terminateTree waits out the grace period for a SIGTERM-ignoring tree',
    ms1 >= KILL_GRACE_MS, ms1 + 'ms');
  ok('and reports the tree confirmed dead once SIGKILL lands', r1.confirmed === true);

  // Survives even SIGKILL: bounded fallback, never a hang, and honest about it.
  const immortal = stub('NEVER');
  const t1 = Date.now();
  const r2 = await terminateTree(immortal);
  const ms2 = Date.now() - t1;
  ok('an unkillable tree falls back within the bound rather than hanging',
    ms2 >= KILL_GRACE_MS + KILL_CONFIRM_MS && ms2 < KILL_GRACE_MS + KILL_CONFIRM_MS + 4000, ms2 + 'ms');
  ok('and is reported UNconfirmed rather than pretended dead', r2.confirmed === false);
}

// 12. A launcher whose DESCENDANT ignores SIGTERM — the case a single-child test misses
// entirely. Only meaningful where process groups exist; on win32 killTree's negative-pid
// send fails ESRCH and the fallback reaches the launcher alone, a pre-existing platform
// limitation rather than anything this escalation controls.
if (process.platform === 'win32') {
  console.log('  skip resistant-descendant tree test (no process groups on win32)');
} else {
  const marker = path.join(WORK, 'descendant-alive');
  const inner = `trap "" TERM; while :; do touch '${marker}'; sleep 0.2; done`;
  const script = `trap "" TERM; sh -c '${inner.replace(/'/g, `'"'"'`)}' & wait`;
  let err = null;
  const t0 = Date.now();
  try {
    await run('sh', ['-c', script], process.cwd(), () => {}, { timeoutMs: 300 });
  } catch (e) { err = e; }
  ok('run() rejects on timeout with a resistant tree', err?.timedOut === true);
  ok('and did not return before the escalation', Date.now() - t0 >= 4000, (Date.now() - t0) + 'ms');
  // The caller is back, so by contract the tree is dead. Removing the marker must stick.
  try { fs.unlinkSync(marker); } catch (_) {}
  await new Promise((r) => setTimeout(r, 900));
  ok('the resistant descendant is dead by the time the caller resumes', !fs.existsSync(marker));
}

// 13. Session rollover must not leak the previous run's diagnostics.
//
// The superseded collector settles asynchronously (its final flush and loop read are
// awaited), so it can still emit after the next run has begun — and statsSSE is shared.
// History writes stay correct either way (each callback closes over its own run id); it
// is the broadcast that would paint the old session onto the new run's wizard. A watcher
// still dying from the previous run must likewise not feed the new collector.
{
  const session = await import('../src/session.ts');
  const history = await import('../src/history.ts');
  const ESC = String.fromCharCode(27);
  const payload = (code) => `${ESC}[91mError: ${ESC}[0m{"code":${code},"message":"x"}
`;

  const broadcasts = [];
  session.statsSSE.broadcast = (obj) => { if (obj?.type === 'diagnostics') broadcasts.push(obj.diagnostics.map((d) => d.kind)); };

  const firstId = session.beginRun({ framework: 'angular', model: 'anthropic/x' });
  const firstSink = session.agentSink();          // bound to run 1's collector
  firstSink.onOutput('stderr', payload(429));
  await new Promise((r) => setTimeout(r, 20));
  ok('run 1 broadcast its own diagnostic', broadcasts.at(-1)?.includes('rate-limited'),
    JSON.stringify(broadcasts));

  broadcasts.length = 0;
  const secondId = session.beginRun({ framework: 'react', model: 'anthropic/x' });
  await new Promise((r) => setTimeout(r, 60));    // let run 1's finish() settle
  ok('the superseded collector does not broadcast into the new run',
    broadcasts.length === 0, JSON.stringify(broadcasts));

  // Run 1's watcher is still dying and still writing.
  firstSink.onOutput('stderr', payload(401));
  await new Promise((r) => setTimeout(r, 20));
  ok('a dying watcher cannot feed the new run', session.getDiagnostics().length === 0,
    JSON.stringify(session.getDiagnostics().map((d) => d.kind)));

  // Each record kept its own findings.
  ok('run 1 kept its diagnostic', (history.get(firstId)?.diagnostics || []).map((d) => d.kind)
    .includes('rate-limited'));
  ok("run 2 has none of run 1s findings", (history.get(secondId)?.diagnostics || []).length === 0);

  // The current run's own sink still works.
  session.agentSink().onOutput('stderr', payload(402));
  await new Promise((r) => setTimeout(r, 20));
  ok("the current runs own sink is still live", session.getDiagnostics().map((d) => d.kind)
    .includes('no-credits'));
}

// 14. run.sh runs under `set -euo pipefail`, where a grep inside a command substitution
// that matches NOTHING exits 1, pipefail propagates it out, and the script dies with no
// output whatsoever. That is how an optional field (apiKeyEnv) silently broke every
// matrix config that omitted it. Guard the whole class, not just the one line.
{
  const sh = fs.readFileSync(new URL('../run.sh', import.meta.url), 'utf8');
  const risky = sh.split(/\r?\n/)
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /=\s*"?\$\(/.test(l) && /\bgrep\b/.test(l) && !/\|\|\s*true/.test(l));
  ok('no grep-in-substitution in run.sh can silently kill it under pipefail',
    risky.length === 0, risky.map(([n]) => 'line ' + n).join(', '));
}

fs.rmSync(WORK, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILED` : '\nall smoke checks passed');
process.exit(fails ? 1 : 0);
