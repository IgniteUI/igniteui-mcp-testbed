#!/usr/bin/env node
// Fixture gate for the run-diagnostics machinery (DIAGNOSTICS-PLAN.md phase 0).
//
// Hand-written inputs, exact expected outputs, non-zero exit on any mismatch. This is
// the thing that fails loudly when someone edits a regex — the corpus replay script is
// observational and cannot serve as a gate.
//
// Control characters are written as <LF> / <CR> / <ESC> tokens and expanded by `t()`.
// Fixtures whose whole point is a control character must not be readable only by
// counting backslashes, and must not be silently mangled by an editor or a diff tool.

import { stripAnsi } from '../src/ansi.ts';
import {
  createLineFramer, classifyAgentLine, classifyNetworkFailure, createDiagnosticsCollector,
  deriveStatus, isToolFailureLabel,
} from '../src/capture/diagnostics.ts';
import { fingerprintInput, detectLoop } from '../src/capture/loop.ts';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const BEL = String.fromCharCode(7);

const t = (s) =>
  s.split('<ESC>').join(ESC).split('<CR>').join(CR).split('<LF>').join(LF).split('<BEL>').join(BEL);

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
}

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

// The real provider failure from sessions/history/run-20260813T113807-b1d9.json,
// verbatim. The colour sequence before `Error` and the reset BETWEEN `Error: ` and the
// `{` are the reason every classifier input must be stripped first: an anchored match
// on the raw line finds nothing.
const REAL_504 =
  t('<ESC>[91m<ESC>[1mError: <ESC>[0m') +
  '{"code":504,"message":"Upstream idle timeout exceeded","metadata":{"error_type":"timeout"}}';

check(
  'stripAnsi: real 504 line',
  stripAnsi(REAL_504),
  'Error: {"code":504,"message":"Upstream idle timeout exceeded","metadata":{"error_type":"timeout"}}',
);

check('stripAnsi: plain SGR colour', stripAnsi(t('<ESC>[31mred<ESC>[0m')), 'red');

// Erase-in-line. An SGR-only strip (/ESC[[0-9;]*m/) leaves this prefix in place, which
// is enough to defeat an anchored `^Error:` match — the detector then goes quiet rather
// than loud. 17 of these appear in the corpus, all from Vite progress output.
check('stripAnsi: erase-in-line', stripAnsi(t('<ESC>[2K<CR>transforming...')), CR + 'transforming...');

// Pins the widening itself: the previous SGR-only pattern is kept here purely as the
// counter-example, so a future "simplification" back to it fails rather than going quiet.
const SGR_ONLY = /\x1b\[[0-9;]*m/g;
check(
  'stripAnsi: SGR-only strip would have left the erase-line prefix behind',
  t('<ESC>[2KError: {}').replace(SGR_ONLY, ''),
  t('<ESC>[2KError: {}'),
);
check('stripAnsi: full-CSI strip removes it', stripAnsi(t('<ESC>[2KError: {}')), 'Error: {}');

check('stripAnsi: cursor movement', stripAnsi(t('<ESC>[1G<ESC>[2Adone')), 'done');
check('stripAnsi: OSC title (BEL-terminated)', stripAnsi(t('<ESC>]0;title<BEL>after')), 'after');
check('stripAnsi: OSC (ST-terminated)', stripAnsi(t('<ESC>]8;;http://x<ESC>' + String.fromCharCode(92) + 'link')), 'link');
check('stripAnsi: no escapes is identity', stripAnsi('plain text'), 'plain text');

// ---------------------------------------------------------------------------
// Line framer
// ---------------------------------------------------------------------------

// Drive the framer with a chunk script and collect every delivered [stream, line] pair.
function frame(chunks, { flush = true } = {}) {
  const out = [];
  const f = createLineFramer((stream, line) => out.push([stream, line]));
  for (const [stream, chunk] of chunks) f.push(stream, chunk);
  if (flush) f.flush();
  return out;
}

check(
  'framer: chunk split mid-line',
  frame([['stdout', 'he'], ['stdout', 'llo' + LF]]),
  [['stdout', 'hello']],
);

check(
  'framer: chunk ending exactly on newline emits nothing extra',
  frame([['stdout', t('a<LF>')]], { flush: false }),
  [['stdout', 'a']],
);

check(
  'framer: multi-line chunk',
  frame([['stdout', t('a<LF>b<LF>c<LF>')]]),
  [['stdout', 'a'], ['stdout', 'b'], ['stdout', 'c']],
);

// The case the trimEnd-based approach could not express: a process that dies mid-write
// leaves its last line without a terminator, and that is exactly where a provider error
// lands. Losing it would lose the diagnostic.
check(
  'framer: final partial line flushed at close',
  frame([['stdout', t('a<LF>tail')]]),
  [['stdout', 'a'], ['stdout', 'tail']],
);

check(
  'framer: partial line is NOT delivered before flush',
  frame([['stdout', t('a<LF>tail')]], { flush: false }),
  [['stdout', 'a']],
);

check('framer: flush with empty buffer delivers nothing', frame([['stdout', '']]), []);

check(
  'framer: blank lines are preserved',
  frame([['stdout', t('a<LF><LF>b<LF>')]]),
  [['stdout', 'a'], ['stdout', ''], ['stdout', 'b']],
);

check(
  'framer: CRLF within one chunk',
  frame([['stdout', t('a<CR><LF>b<CR><LF>')]]),
  [['stdout', 'a'], ['stdout', 'b']],
);

// A CR at the end of a chunk cannot yet be told apart from the first half of a CRLF.
// Delivering it eagerly would emit a spurious empty line when the LF arrives next.
check(
  'framer: CRLF split across chunks',
  frame([['stdout', t('a<CR>')], ['stdout', t('<LF>b<CR><LF>')]]),
  [['stdout', 'a'], ['stdout', 'b']],
);

// Vite/opencode rewrite progress in place. Treating CR as a terminator is what stops a
// payload written after a rewrite from carrying the erased progress text as a prefix.
check(
  'framer: lone CR is a line terminator',
  frame([['stdout', t('progress<CR>done<LF>')]]),
  [['stdout', 'progress'], ['stdout', 'done']],
);

check(
  'framer: trailing lone CR flushed without the CR',
  frame([['stdout', t('x<CR>')]]),
  [['stdout', 'x']],
);

check(
  'framer: streams buffer independently',
  frame([
    ['stdout', 'out-'],
    ['stderr', 'err-'],
    ['stdout', 'one' + LF],
    ['stderr', 'two' + LF],
  ]),
  [['stdout', 'out-one'], ['stderr', 'err-two']],
);

// Stripping happens AFTER splitting, so an escape sequence straddling a chunk boundary
// is still intact when it is removed. Stripping per-chunk would leave the tail behind.
check(
  'framer: escape sequence split across chunks is still stripped',
  frame([['stdout', t('<ESC>[')], ['stdout', t('2Khello<LF>')]]),
  [['stdout', 'hello']],
);

// End to end: the real provider error, arriving in two chunks on stderr, comes out as
// one stripped line that an anchored classifier can match.
const ANCHOR = /^\s*Error:\s*(\{.*\})\s*$/;
const framed504 = frame([
  ['stderr', REAL_504.slice(0, 20)],
  ['stderr', REAL_504.slice(20) + LF],
]);
check('framer: real 504 reassembled from two chunks', framed504, [
  ['stderr', 'Error: {"code":504,"message":"Upstream idle timeout exceeded","metadata":{"error_type":"timeout"}}'],
]);
check('framer: reassembled 504 matches the classifier anchor', ANCHOR.test(framed504[0][1]), true);
check(
  'framer: anchor does NOT match the same line unstripped',
  ANCHOR.test(REAL_504),
  false,
);

// A throwing consumer must cost one line, not the buffer. Diagnostics degrade to "no
// diagnostics", never to a desynced framer or a failed run.
{
  const seen = [];
  const errors = [];
  const f = createLineFramer(
    (stream, line) => { if (line === 'boom') throw new Error('classifier exploded'); seen.push(line); },
    (e) => errors.push(e.message),
  );
  f.push('stdout', t('a<LF>boom<LF>b<LF>'));
  check('framer: throwing consumer does not desync the buffer', seen, ['a', 'b']);
  check('framer: throwing consumer is reported once', errors, ['classifier exploded']);
}

// ---------------------------------------------------------------------------
// Detector A: the classifier
// ---------------------------------------------------------------------------

// Compare the fields that decide behaviour. Timestamps are wall-clock and counts start
// at 1, so pinning them would only make the fixtures brittle.
const sig = (d) => (d ? [d.kind, d.severity, d.confidence, d.id] : null);

// Every provider case runs against BOTH streams: confirmed on stderr, null on stdout.
// This asserts that the isolation rule behaves as specified — NOT that reality feeds it
// stderr, which the corpus cannot establish and only the live probes can.
function bothStreams(name, line, expected) {
  check(name + ' [stderr]', sig(classifyAgentLine(line, 'stderr')), expected);
  check(name + ' [stdout]', sig(classifyAgentLine(line, 'stdout')), null);
}

bothStreams('classify: real 504', REAL_504,
  ['provider-down', 'fatal', 'confirmed', 'provider-down:504']);
bothStreams('classify: 429', 'Error: {"code":429,"message":"Too many requests"}',
  ['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']);
bothStreams('classify: 401', 'Error: {"code":401,"message":"Invalid API key"}',
  ['auth', 'fatal', 'confirmed', 'auth:401']);
bothStreams('classify: 403', 'Error: {"code":403,"message":"Forbidden"}',
  ['auth', 'fatal', 'confirmed', 'auth:403']);
bothStreams('classify: 402', 'Error: {"code":402,"message":"Payment required"}',
  ['no-credits', 'fatal', 'confirmed', 'no-credits:402']);
bothStreams('classify: 503', 'Error: {"code":503,"message":"Service unavailable"}',
  ['provider-down', 'fatal', 'confirmed', 'provider-down:503']);

// Code beats message. The two rules genuinely overlap — providers word throttling as
// "quota exceeded" all the time — so without an explicit precedence a 429 would land on
// no-credits and tell the user to top up an account that is perfectly funded.
bothStreams('classify: 429 worded as a quota problem stays rate-limited',
  'Error: {"code":429,"message":"quota exceeded for this model"}',
  ['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']);

// Rule 5 fires only for codes rules 1-4 did not claim.
bothStreams('classify: unknown code with a billing message becomes no-credits',
  'Error: {"code":460,"message":"insufficient credit balance"}',
  ['no-credits', 'fatal', 'confirmed', 'no-credits:460']);

// The catch-all must admit as well as reject, or the shape check is untested in one
// direction and rule 6 is dead code.
bothStreams('classify: valid unknown code', 'Error: {"code":418,"message":"teapot"}',
  ['unknown-provider-error', 'fatal', 'confirmed', 'unknown-provider-error:418']);

// Shape-check boundary. JSON.parse succeeding proves the line was JSON, not that it was
// a provider error — and rule 6 is a catch-all, so without these the classifier would
// turn any Error-shaped JSON the agent prints into a fatal verdict.
for (const [name, line] of [
  ['empty object', 'Error: {}'],
  ['string code', 'Error: {"code":"429","message":"x"}'],
  ['no message', 'Error: {"code":429}'],
  ['empty message', 'Error: {"code":429,"message":"   "}'],
  ['null code', 'Error: {"code":null,"message":"x"}'],
  ['code out of range', 'Error: {"code":999,"message":"x"}'],
  ['code below range', 'Error: {"code":42,"message":"x"}'],
  ['not json', 'Error: {not json}'],
  ['no payload', 'Error: something went wrong'],
]) {
  check('classify: rejects ' + name, sig(classifyAgentLine(line, 'stderr')), null);
}

// The known false-positive class, straight from the corpus: output the agent produced
// or echoed. All rejected on both streams.
for (const [name, line] of [
  ['CSS custom property', '  --ig-error-500: #d32f2f;'],
  ['playwright assertion', 'Error: expect(received).toBe(expected) // 500 !== 200'],
  ['module not found', "Error: Cannot find module 'x' imported from y (ERR_MODULE_NOT_FOUND)"],
  ['grep output', 'src/theme.css:12:  --ig-error-500: red;'],
]) {
  check('classify: ignores ' + name + ' [stderr]', sig(classifyAgentLine(line, 'stderr')), null);
  check('classify: ignores ' + name + ' [stdout]', sig(classifyAgentLine(line, 'stdout')), null);
}

// A failed MCP tool call is labelled on the preceding line. Its Error line is prose
// today, but an HTTP-backed MCP server returning a JSON body with a code would sail
// through the shape check and get the provider blamed for a tool failure.
check('tool-failure label recognised',
  isToolFailureLabel('✗ igniteui-cli_get_api_reference {"component":"IgcInputComponent"} failed'), true);
check('tool-failure label does not match ordinary output',
  isToolFailureLabel('build failed'), false);

{
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', '✗ igniteui-cli_get_api_reference {"member":"igcInput"} failed' + LF);
  c.onOutput('stderr', 'Error: {"code":404,"message":"Member not found"}' + LF);
  check('collector: MCP tool error is not attributed to the provider',
    (await c.finish({ exitCode: 1 })).map(sig), []);
}

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

check('network: ECONNREFUSED tail',
  sig(classifyNetworkFailure(['starting', 'connect ECONNREFUSED 127.0.0.1:9999'])),
  ['network', 'fatal', 'suspected', 'network:ECONNREFUSED']);
check('network: fetch failed',
  sig(classifyNetworkFailure(['TypeError: fetch failed'])),
  ['network', 'fatal', 'suspected', 'network:fetch failed']);
check('network: clean tail yields nothing',
  sig(classifyNetworkFailure(['all good', 'done'])), null);

// ---------------------------------------------------------------------------
// Collector: exit-time behaviour
// ---------------------------------------------------------------------------

const PAYLOAD_429 = 'Error: {"code":429,"message":"Too many requests"}';

{
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', PAYLOAD_429 + LF);
  check('collector: stderr payload is confirmed', (await c.finish({ exitCode: 1 })).map(sig),
    [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
}

{
  // A successful run that merely printed an error-shaped string is not a failure.
  const c = createDiagnosticsCollector();
  c.onOutput('stdout', PAYLOAD_429 + LF);
  check('collector: stdout payload on a clean exit is ignored', (await c.finish({ exitCode: 0 })).map(sig), []);
}

{
  // The run did fail, so the held payload is plausibly its cause — but only plausibly.
  const c = createDiagnosticsCollector();
  c.onOutput('stdout', PAYLOAD_429 + LF);
  check('collector: stdout payload on a failed exit is suspected', (await c.finish({ exitCode: 1 })).map(sig),
    [['rate-limited', 'fatal', 'suspected', 'rate-limited:429']]);
}

{
  // Corroborated by stderr, the confirmed one absorbs it rather than duplicating.
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', PAYLOAD_429 + LF);
  c.onOutput('stdout', PAYLOAD_429 + LF);
  const out = await c.finish({ exitCode: 1 });
  check('collector: corroborated stdout hit stays confirmed', out.map(sig),
    [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
  check('collector: and is deduplicated into one entry with count 2', out[0].count, 2);
}

{
  // Forty 429s are one diagnostic, not forty.
  const c = createDiagnosticsCollector();
  for (let i = 0; i < 40; i++) c.onOutput('stderr', PAYLOAD_429 + LF);
  const out = await c.finish({ exitCode: 1 });
  check('collector: repeats collapse into one entry', out.length, 1);
  check('collector: with a rising count', out[0].count, 40);
}

{
  // Killing opencode's process group manufactures torn-connection stderr, so a cancel
  // must not become a network diagnostic blaming the provider for the user's own button.
  const c = createDiagnosticsCollector({ isCancelled: () => true });
  c.onOutput('stderr', 'connect ECONNREFUSED 127.0.0.1:9999' + LF);
  check('collector: cancel suppresses the transport pass', (await c.finish({ exitCode: 1 })).map(sig), []);
}

{
  // ...but an observation made BEFORE the cancel was real and is kept.
  const c = createDiagnosticsCollector({ isCancelled: () => true });
  c.onOutput('stderr', PAYLOAD_429 + LF);
  check('collector: cancel keeps diagnostics confirmed before it', (await c.finish({ exitCode: 1 })).map(sig),
    [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
}

{
  // A parsed provider error is better evidence than a transport guess; emitting both
  // would be noise, not corroboration.
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', PAYLOAD_429 + LF);
  c.onOutput('stderr', 'connect ECONNREFUSED 127.0.0.1:9999' + LF);
  check('collector: transport pass stays quiet when a provider error was parsed',
    (await c.finish({ exitCode: 1 })).map(sig), [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
}

{
  // The process died mid-write: the payload has no trailing newline and only the
  // framer flush recovers it.
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', PAYLOAD_429);
  check('collector: flush recovers an unterminated final payload',
    (await c.finish({ exitCode: 1 })).map(sig), [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
}

{
  const c = createDiagnosticsCollector();
  const out = await c.finish({ timedOut: true, timeoutMs: 1500000 });
  check('collector: timeout constructs a diagnostic', out.map(sig),
    [['timed-out', 'fatal', 'confirmed', 'timed-out:agent']]);
  check('collector: timeout detail names the cap', out[0].detail.includes('1500000ms'), true);
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

const D = (kind, severity = 'fatal', extra = {}) => ({
  id: kind + ':x', kind, severity, confidence: 'confirmed', title: kind, detail: '', advice: '',
  at: '', count: 1, lastAt: '', ...extra,
});

check('derive: cancel always wins',
  deriveStatus([D('auth')], { cancelled: true, buildFailed: true }), 'cancelled');
check('derive: build-error outranks provider kinds',
  deriveStatus([D('rate-limited')], { buildFailed: true }), 'build-error');
check('derive: auth outranks no-credits',
  deriveStatus([D('auth'), D('no-credits')]), 'auth');
check('derive: no-credits outranks rate-limited',
  deriveStatus([D('no-credits'), D('rate-limited')]), 'no-credits');
check('derive: network collapses into provider-down',
  deriveStatus([D('network')]), 'provider-down');
check('derive: unknown-provider-error collapses into provider-down',
  deriveStatus([D('unknown-provider-error')]), 'provider-down');
check('derive: timed-out is its own status', deriveStatus([D('timed-out')]), 'timed-out');
check('derive: provider failure outranks a test failure',
  deriveStatus([D('rate-limited')], { testsFailed: true }), 'rate-limited');
check('derive: warnings never become a status',
  deriveStatus([D('stalled', 'warning'), D('looping', 'warning')]), 'success');
check('derive: a fatal diagnostic reclassifies a run that exited 0',
  deriveStatus([D('rate-limited')], {}), 'rate-limited');
check('derive: resolved diagnostics are excluded',
  deriveStatus([D('rate-limited', 'fatal', { resolvedAt: 'now' })]), 'success');
check('derive: superseded diagnostics are excluded',
  deriveStatus([D('rate-limited', 'fatal', { supersededAt: 'now', supersededBy: 'timed-out:agent' })]), 'success');
check('derive: clean run with tests failing', deriveStatus([], { testsFailed: true }), 'test-failed');
check('derive: unexplained throw', deriveStatus([], { errored: true }), 'error');
check('derive: nothing wrong', deriveStatus([], {}), 'success');

// ---------------------------------------------------------------------------
// Detector B: stall lifecycle
// ---------------------------------------------------------------------------

{
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  const out = c.list();
  check('stall: raises a warning, not a failure', out.map(sig),
    [['stalled', 'warning', 'confirmed', 'stalled:stall']]);
  check('stall: never becomes a status on its own', deriveStatus(out, {}), 'success');
}

{
  // Ceasing to update a diagnostic is invisible in the UI — a recovery must be MARKED.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.noteResume(342000);
  const d = c.list()[0];
  check('stall: resume sets resolvedAt', !!d.resolvedAt, true);
  check('stall: resume does NOT set supersededAt', !!d.supersededAt, false);
  check('stall: a recovered stall rides along on a green run',
    deriveStatus(c.list(), {}), 'success');
  check('stall: and is retained rather than deleted', c.list().length, 1);
}

{
  // Quiet, back, quiet again is ONE story — the dedup key is the condition, not the
  // episode, so a second stall re-opens the same diagnostic rather than adding another.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.noteResume(310000);
  c.noteStall(400000);
  const out = c.list();
  check('stall: a second episode reuses the same diagnostic', out.length, 1);
  check('stall: re-opening clears resolvedAt', !!out[0].resolvedAt, false);
  check('stall: and bumps the count', out[0].count, 2);
}

{
  // A stall that ran straight into the timeout is the OPPOSITE of a recovery. Collapsing
  // the two would erase the strongest evidence the run has.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  const out = await c.finish({ timedOut: true, timeoutMs: 1500000 });
  const stall = out.find((d) => d.kind === 'stalled');
  const timeout = out.find((d) => d.kind === 'timed-out');
  check('supersede: both diagnostics are kept', out.length, 2);
  check('supersede: the stall is NOT marked resolved', !!stall.resolvedAt, false);
  check('supersede: supersededAt is stamped', !!stall.supersededAt, true);
  check('supersede: supersededBy points at the timeout', stall.supersededBy, timeout.id);
  check('supersede: the timeout detail names the stall', timeout.detail.includes('stalled since'), true);
  // supersededAt is the STATE and supersededBy only the pointer; stamping the pointer
  // alone would leave the stall counting toward derivation.
  check('supersede: superseded stall is excluded from derivation, timeout supplies it',
    deriveStatus(out, { errored: true }), 'timed-out');
}

{
  // A stall that already recovered must not be retro-labelled as overtaken.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.noteResume(310000);
  const out = await c.finish({ timedOut: true, timeoutMs: 1500000 });
  const stall = out.find((d) => d.kind === 'stalled');
  check('supersede: an already-resolved stall stays resolved', !!stall.resolvedAt, true);
  check('supersede: and is not also superseded', !!stall.supersededAt, false);
}

{
  // A run can carry a recovered stall AND a fatal provider error; the fatal one decides.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.noteResume(310000);
  c.onOutput('stderr', PAYLOAD_429 + LF);
  const out = await c.finish({ exitCode: 1 });
  check('stall: a warning coexists with a fatal diagnostic', out.length, 2);
  check('stall: the fatal one decides the status', deriveStatus(out, { errored: true }), 'rate-limited');
}

// ---------------------------------------------------------------------------
// Live propagation channel
// ---------------------------------------------------------------------------

{
  const sets = [];
  const c = createDiagnosticsCollector({ onChange: (ds) => sets.push(ds.map((d) => d.id)) });
  c.noteStall(300000);
  check('live: a new diagnostic propagates immediately', sets.length, 1);
  check('live: and carries the full set, not a delta', sets[0], ['stalled:stall']);
  c.noteResume(310000);
  check('live: a lifecycle change propagates too', sets.length, 2);
  c.onOutput('stderr', PAYLOAD_429 + LF);
  check('live: a second kind arrives with both entries', sets[sets.length - 1],
    ['stalled:stall', 'rate-limited:429']);
  const before = sets.length;
  await c.finish({ exitCode: 1 });
  check('live: finish emits the final set so the two channels agree', sets.length > before, true);
}

{
  // A pathological output loop must not become an SSE flood: count bumps are throttled,
  // while the set itself stays correct.
  const sets = [];
  const c = createDiagnosticsCollector({ onChange: (ds) => sets.push(ds[0].count) });
  for (let i = 0; i < 200; i++) c.onOutput('stderr', PAYLOAD_429 + LF);
  check('live: 200 repeats do not emit 200 events', sets.length < 5, true, 'emits=' + sets.length);
  check('live: the count is still exact', c.list()[0].count, 200);
}

{
  // The collector is closed after finish; a late callback must not resurrect it.
  const c = createDiagnosticsCollector();
  await c.finish({ exitCode: 0 });
  c.noteStall(300000);
  check('live: noteStall after finish is ignored', c.list().length, 0);
}

// ---------------------------------------------------------------------------
// Detector C: fingerprinting
// ---------------------------------------------------------------------------

// Key order must not change the fingerprint, or ordinary re-serialization looks like
// two different calls.
check('fingerprint: key order is irrelevant',
  fingerprintInput({ a: 1, b: 2 }) === fingerprintInput({ b: 2, a: 1 }), true);
check('fingerprint: nested key order is irrelevant',
  fingerprintInput({ x: { a: 1, b: 2 } }) === fingerprintInput({ x: { b: 2, a: 1 } }), true);
check('fingerprint: array order matters',
  fingerprintInput([1, 2]) === fingerprintInput([2, 1]), false);
check('fingerprint: different values differ',
  fingerprintInput({ a: 1 }) === fingerprintInput({ a: 2 }), false);
check('fingerprint: null and undefined input are stable',
  fingerprintInput(null) === fingerprintInput(undefined), true);

// The reason the whole input is hashed and never a truncated one: tool inputs share
// long prefixes constantly — two writes to the same path, two edits starting with the
// same imports. A prefix hash would manufacture a loop out of sequential work, in the
// detector whose entire job is telling repetition from progress.
{
  const a = { path: 'src/app.ts', body: 'import x from "y";\n' + 'A'.repeat(400) };
  const b = { path: 'src/app.ts', body: 'import x from "y";\n' + 'B'.repeat(400) };
  check('fingerprint: long shared prefixes still differ', fingerprintInput(a) === fingerprintInput(b), false);
}

// ---------------------------------------------------------------------------
// Detector C: cycle detection
// ---------------------------------------------------------------------------

const call = (tool, fp) => ({ at: 0, tool, fingerprint: String(fp) });
const seq = (spec) => spec.split(' ').map((tok) => call(tok[0], tok.slice(1) || '1'));
const shape = (h) => (h ? [h.tool, h.shape, h.period, h.reps] : null);

check('loop: five identical calls is a repeat',
  shape(detectLoop(seq('a1 a1 a1 a1 a1'))), ['a', 'repeat', 1, 5]);
check('loop: four identical calls is not (default repeats=5)',
  shape(detectLoop(seq('a1 a1 a1 a1'))), null);
check('loop: same tool, different inputs is progress, not a loop',
  shape(detectLoop(seq('a1 a2 a3 a4 a5'))), null);
check('loop: different tools, same input is not a repeat',
  shape(detectLoop(seq('a1 b1 c1 d1 e1'))), null);

// The suffix anchor: thrashing that STOPPED is working, not stuck. Reporting it as a
// live loop is how a warning gets trained into background noise.
check('loop: a repeat that ended before the newest call is ignored',
  shape(detectLoop(seq('a1 a1 a1 a1 a1 b1'))), null);
check('loop: a repeat running to the newest call is caught',
  shape(detectLoop(seq('b1 a1 a1 a1 a1 a1'))), ['a', 'repeat', 1, 5]);

check('loop: a 2-step cycle three times over',
  shape(detectLoop(seq('a1 b1 a1 b1 a1 b1'))), ['a+b', 'cycle', 2, 3]);
check('loop: a 2-step cycle only twice is not enough',
  shape(detectLoop(seq('x1 a1 b1 a1 b1'))), null);
check('loop: a 3-step cycle three times over',
  shape(detectLoop(seq('a1 b1 c1 a1 b1 c1 a1 b1 c1'))), ['a+b+c', 'cycle', 3, 3]);
check('loop: a cycle that stopped before the newest call is ignored',
  shape(detectLoop(seq('a1 b1 a1 b1 a1 b1 z1'))), null);
check('loop: a 5-step cycle is out of range',
  shape(detectLoop(seq('a1 b1 c1 d1 e1 a1 b1 c1 d1 e1 a1 b1 c1 d1 e1'))), null);
check('loop: reps are counted back as far as the cycle runs',
  detectLoop(seq('a1 b1 a1 b1 a1 b1 a1 b1')).reps, 4);

// A cycle whose block repeats a pair is a straight repeat; admitting it under rule 2
// as well would double-report the same thing.
check('loop: an all-same block is reported as a repeat, not a cycle',
  shape(detectLoop(seq('a1 a1 a1 a1 a1 a1'))), ['a', 'repeat', 1, 6]);

check('loop: empty input', shape(detectLoop([])), null);
check('loop: null input (unreadable store) is not a loop', shape(detectLoop(null)), null);
check('loop: a single call', shape(detectLoop(seq('a1'))), null);

// ---------------------------------------------------------------------------
// Detector C: lifecycle through the collector
// ---------------------------------------------------------------------------

// Drive the collector's poller with a stub store instead of a real SQLite file.
function loopCollector(script) {
  let i = 0;
  const reads = () => (i < script.length ? script[i++] : script[script.length - 1]);
  const c = createDiagnosticsCollector({
    // pollMs is large so only the explicit step() calls drive it — the timer must not
    // race the assertions.
    loop: { dataDir: '/stub', since: 0, repeats: 5, pollMs: 3600000, read: async () => reads() },
  });
  return { c, step: () => c.pollLoop() };
}

{
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1')]);
  await step();
  const out = c.list();
  check('loop lifecycle: raises a warning', out.map(sig),
    [['looping', 'warning', 'confirmed', 'looping:a']]);
  check('loop lifecycle: never fails a run on its own', deriveStatus(out, {}), 'success');
}

{
  // A loop that stops must be MARKED stopped — ceasing to update is invisible in the UI.
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1'), seq('a1 a1 a1 a1 b1')]);
  await step();
  await step();
  const d = c.list()[0];
  check('loop lifecycle: a stopped loop is resolved', !!d.resolvedAt, true);
}

{
  // Loops, recovers, loops again on the same tool: one story, one diagnostic.
  const { c, step } = loopCollector([
    seq('a1 a1 a1 a1 a1'), seq('a1 a1 a1 a1 b1'), seq('a1 a1 a1 a1 a1'),
  ]);
  await step(); await step(); await step();
  const out = c.list();
  check('loop lifecycle: re-looping reuses the same diagnostic', out.length, 1);
  check('loop lifecycle: and clears resolvedAt', !!out[0].resolvedAt, false);
  check('loop lifecycle: and bumps the count', out[0].count, 2);
}

{
  // Still looping when the run ends ⇒ left unresolved; it was looping at the end.
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1')]);
  await step();
  const out = await c.finish({ exitCode: 0 });
  check('loop lifecycle: a loop live at the end stays unresolved', !!out[0].resolvedAt, false);
}

{
  // An unreadable store is "no data", not "no loop" — it must not silently resolve one.
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1'), null]);
  await step();
  await step();
  check('loop lifecycle: an unreadable store does not resolve a live loop',
    !!c.list()[0].resolvedAt, false);
}

{
  // Two different tools looping in sequence are two diagnostics, and the first is
  // resolved once its suffix stops matching.
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1'), seq('b1 b1 b1 b1 b1')]);
  await step(); await step();
  const out = c.list();
  check('loop lifecycle: a different tool gets its own diagnostic', out.length, 2);
  check('loop lifecycle: the previous one is resolved', !!out[0].resolvedAt, true);
  check('loop lifecycle: the new one is live', !!out[1].resolvedAt, false);
}

{
  // Shutdown step 4: the most repetitive stretch is usually the LAST one, and the
  // periodic tick may have missed it entirely.
  const { c } = loopCollector([seq('a1 a1 a1 a1 a1')]);
  const out = await c.finish({ exitCode: 0 });
  check('shutdown: the final awaited read catches a loop no tick saw', out.map(sig),
    [['looping', 'warning', 'confirmed', 'looping:a']]);
}

{
  // Step 5: after close, nothing may append to an entry that has already settled.
  const { c, step } = loopCollector([seq('a1 a1 a1 a1 a1')]);
  await c.finish({ exitCode: 0 });
  const before = c.list().length;
  await step();
  check('shutdown: a read after close is dropped', c.list().length, before);
}

// ---------------------------------------------------------------------------
// The transport pass vs. everything else
//
// Regression cases. The predicate here was originally "any diagnostic that isn't a
// timeout counts as provider evidence", which was wrong in BOTH directions: it let the
// teardown after a timeout be reported as a provider outage, and it let an unrelated
// agent-behaviour warning suppress a real transport failure.
// ---------------------------------------------------------------------------

const NET_LINE = 'connect ECONNREFUSED 127.0.0.1:443';

{
  // AGENT_TIMEOUT_MS is followed by SIGTERM->SIGKILL on opencode's process group, and a
  // killed process's torn connections produce exactly the strings the transport pass
  // looks for. The honest headline is the timeout — that is what was actually observed.
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', NET_LINE + LF);
  const out = await c.finish({ exitCode: null, timedOut: true, timeoutMs: 1500 });
  check('transport: a timeout does not manufacture a network diagnostic',
    out.map((d) => d.kind), ['timed-out']);
  check('transport: and the status stays timed-out',
    deriveStatus(out, { errored: true }), 'timed-out');
}

{
  // A stall is a warning about the AGENT's behaviour. It says nothing about whether the
  // provider was reachable, so it must not stand in for provider evidence.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.onOutput('stderr', NET_LINE + LF);
  const out = await c.finish({ exitCode: 1 });
  check('transport: a stall warning does not suppress a real transport failure',
    out.map((d) => d.kind), ['stalled', 'network']);
  check('transport: and the network failure decides the status',
    deriveStatus(out, { errored: true }), 'provider-down');
}

{
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', NET_LINE + LF);
  const out = await c.finish({ exitCode: 1 });
  check('transport: on a plain failure it still fires', out.map((d) => d.kind), ['network']);
}

{
  // A parsed payload IS provider evidence, so the guess stays quiet.
  const c = createDiagnosticsCollector();
  c.onOutput('stderr', PAYLOAD_429 + LF);
  c.onOutput('stderr', NET_LINE + LF);
  const out = await c.finish({ exitCode: 1 });
  check('transport: an active fatal provider diagnostic suppresses it',
    out.map((d) => d.kind), ['rate-limited']);
}

{
  // ...but only while it is ACTIVE. A resolved or superseded diagnostic is no longer the
  // run's problem and cannot vouch for the provider.
  const c = createDiagnosticsCollector();
  c.noteStall(300000);
  c.noteResume(310000);
  c.onOutput('stderr', NET_LINE + LF);
  const out = await c.finish({ exitCode: 1 });
  check('transport: a resolved warning does not suppress it either',
    out.map((d) => d.kind), ['stalled', 'network']);
}

{
  // A stdout payload is something only the agent can produce — teardown cannot fabricate
  // JSON — so unlike the transport pass it stays enabled on the timeout path.
  const c = createDiagnosticsCollector();
  c.onOutput('stdout', PAYLOAD_429 + LF);
  const out = await c.finish({ exitCode: null, timedOut: true, timeoutMs: 1500 });
  check('transport: stdout payloads are still promoted on a timeout',
    out.map((d) => [d.kind, d.confidence]),
    [['timed-out', 'confirmed'], ['rate-limited', 'suspected']]);
}

// ---------------------------------------------------------------------------
// Flushing across a watcher restart
//
// An interactive session outlives its watcher: /api/model kills opencode and respawns it
// while the collector carries on. Without a flush at that seam the last unterminated line
// of the old process is not merely lost — it stays buffered and fuses with the first chunk
// of the replacement, producing a line neither process ever wrote.
// ---------------------------------------------------------------------------

{
  const c = createDiagnosticsCollector();
  // Old watcher dies mid-write, exactly where a provider error lands.
  c.onOutput('stderr', PAYLOAD_429);
  c.flushOutput();
  check('flush: recovers the dying watcher\'s unterminated line',
    c.list().map(sig), [['rate-limited', 'fatal', 'confirmed', 'rate-limited:429']]);
  check('flush: does NOT close the collector', c.list().length, 1);
  // Replacement watcher starts clean and is still observed.
  c.onOutput('stderr', 'Error: {"code":401,"message":"Invalid API key"}' + LF);
  check('flush: the collector keeps working after the restart',
    c.list().map((d) => d.kind), ['rate-limited', 'auth']);
}

{
  // The fusion this prevents: without a flush, a partial line from the old process and
  // the first chunk of the new one concatenate into one line that neither ever emitted —
  // and the resulting text matches nothing, so BOTH errors are silently lost.
  const fused = createDiagnosticsCollector();
  fused.onOutput('stderr', 'Error: {"code":429,');           // old watcher, cut off
  fused.onOutput('stderr', 'Error: {"code":401,"message":"Invalid API key"}' + LF); // new watcher
  check('flush: without one, the two processes fuse into a line matching nothing',
    fused.list().length, 0);

  const flushed = createDiagnosticsCollector();
  flushed.onOutput('stderr', 'Error: {"code":429,');
  flushed.flushOutput();                                      // the seam
  flushed.onOutput('stderr', 'Error: {"code":401,"message":"Invalid API key"}' + LF);
  check('flush: with one, the replacement\'s error is classified correctly',
    flushed.list().map((d) => d.kind), ['auth']);
}

{
  // After finish() the collector is closed; a late watcher close must not reopen it.
  const c = createDiagnosticsCollector();
  await c.finish({ exitCode: 0 });
  c.onOutput('stderr', PAYLOAD_429);
  c.flushOutput();
  check('flush: is a no-op once the collector is closed', c.list().length, 0);
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`diagnostics fixtures: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`diagnostics fixtures: ${passed} passed`);
