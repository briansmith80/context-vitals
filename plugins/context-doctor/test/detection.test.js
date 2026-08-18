'use strict';
//
// Tests for window detection, zone boundaries, sanitisation and tail reading.
//
// detectWindow is the denominator of every percentage the plugin prints, and it
// used to be unexported and completely uncovered: context.test.js pins
// CLAUDE_CODE_MAX_CONTEXT_TOKENS process-wide, which short-circuits the function
// at its second branch, leaving every branch below it dead during that run.
// Five independent mutations survived. This file drives the branches directly.
//
//   node --test plugins/context-doctor/test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect HOME before requiring the lib: userSettings() reads
// ~/.claude/settings.json, and the developer's real `model` key would otherwise
// decide the result of these tests.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

const lib = require('../lib/context');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-data-'));
lib.setDataDir(DATA);

/** Run `fn` with an exact env/config/settings state, then restore. */
function withState(state, fn) {
  const keys = ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(state.env || {})) process.env[k] = v;

  const cfgFile = path.join(DATA, 'config.json');
  const setFile = path.join(HOME, '.claude', 'settings.json');
  try { fs.unlinkSync(cfgFile); } catch { /* absent */ }
  try { fs.unlinkSync(setFile); } catch { /* absent */ }
  if (state.config) fs.writeFileSync(cfgFile, JSON.stringify(state.config));
  if (state.settings) fs.writeFileSync(setFile, JSON.stringify(state.settings));

  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── detectWindow ─────────────────────────────────────────────

test('detectWindow honours precedence: config.json > env > DISABLE_1M > model string', () => {
  const cases = [
    { name: 'config.json wins over everything',
      state: { config: { contextWindow: '400k' }, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } },
      model: 'claude-opus-5', want: 400000, source: /config\.json/, confident: true },
    { name: 'env var wins over the model string',
      state: { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '250000' } },
      model: 'claude-sonnet-5', want: 250000, source: /MAX_CONTEXT_TOKENS/, confident: true },
    { name: 'DISABLE_1M forces 200K',
      state: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } },
      model: 'claude-sonnet-5', want: 200000, source: /DISABLE_1M/, confident: true },
    { name: 'the [1m] variant suffix means 1M',
      state: { settings: { model: 'claude-opus-5[1m]' } },
      model: 'claude-opus-5', want: 1000000, source: /\[1m\]/, confident: true },
    { name: 'a natively-1M model means 1M',
      state: {}, model: 'claude-sonnet-5', want: 1000000, source: /native 1M/, confident: true },
    { name: 'anything else defaults to 200K, and is NOT confident',
      state: {}, model: 'claude-opus-5', want: 200000, source: /model default/, confident: false },
  ];
  for (const c of cases) {
    const got = withState(c.state, () => lib.detectWindow(c.model, 0));
    assert.strictEqual(got.window, c.want, c.name);
    assert.match(got.source, c.source, c.name + ' (source)');
    assert.strictEqual(got.confident, c.confident, c.name + ' (confidence)');
  }
});

test('detectWindow self-corrects upward when observed usage exceeds the guess', () => {
  const got = withState({}, () => lib.detectWindow('claude-opus-5', 260000));
  assert.strictEqual(got.window, 1000000, '260K observed proves the 200K guess wrong');
  assert.match(got.source, /observed usage/);
  assert.strictEqual(got.confident, true);
});

test('detectAutoCompactWindow does not clamp against a window it only guessed', () => {
  // A configured 400K trigger on a session whose window was guessed at 200K:
  // clamping to 200K and then attributing it to the user's setting is wrong in
  // both halves.
  const guessed = withState({ settings: { autoCompactWindow: 400000 } },
    () => lib.detectAutoCompactWindow(200000, false));
  assert.strictEqual(guessed.window, 400000, 'an explicit setting survives an unconfident window');
  assert.ok(!/clamped/.test(guessed.source));

  const known = withState({ settings: { autoCompactWindow: 400000 } },
    () => lib.detectAutoCompactWindow(200000, true));
  assert.strictEqual(known.window, 200000, 'a known window is a real ceiling');
  assert.match(known.source, /clamped/, 'and the clamp is disclosed rather than hidden');
});

// ── Zone boundaries ──────────────────────────────────────────

test('zone thresholds are exact at the boundary value', () => {
  const z = (t) => lib.classify(lib.DEGRADATION_ZONES, t).key;
  assert.strictEqual(z(149999), 'optimal');
  assert.strictEqual(z(150000), 'watch', '150000 belongs to the zone it opens, not the one it closes');
  assert.strictEqual(z(349999), 'watch');
  assert.strictEqual(z(350000), 'act');
  assert.strictEqual(z(599999), 'act');
  assert.strictEqual(z(600000), 'degraded');
  assert.strictEqual(z(849999), 'degraded');
  assert.strictEqual(z(850000), 'critical');

  const p = (f) => lib.classify(lib.PRESSURE_ZONES, f).key;
  assert.strictEqual(p(0.4999), 'optimal');
  assert.strictEqual(p(0.50), 'watch');
  assert.strictEqual(p(0.75), 'act');
  assert.strictEqual(p(0.90), 'degraded');
  assert.strictEqual(p(1.00), 'critical');
});

test('the pressure ladder is suppressed when both of its inputs are guesses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-pl-'));
  const f = path.join(dir, 't.jsonl');
  // 180K on a session whose window was guessed at 200K with no configured
  // trigger: 180000/167000 > 1 used to read CRITICAL, then flip to WATCH one
  // token later when the observed-usage floor fired.
  fs.writeFileSync(f, JSON.stringify({
    type: 'assistant', uuid: 'a', messageId: 'm',
    message: { id: 'm', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 180000, output_tokens: 1 } },
  }) + '\n');

  const r = withState({}, () => lib.report(f, { deep: false }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pressureMeaningful, false, 'a guessed window plus no trigger is not a runway reading');
  assert.strictEqual(r.pressureZone, null);
  assert.strictEqual(r.verdict.driver, 'degradation');
  assert.strictEqual(r.verdict.key, 'watch', '180K is WATCH on the only ladder that means anything here');
});

test('a window at or below the summarisation headroom yields no runway reading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-hr-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, JSON.stringify({
    type: 'assistant', uuid: 'a', messageId: 'm',
    message: { id: 'm', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 9000, output_tokens: 1 } },
  }) + '\n');

  const r = withState({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '30000' } },
    () => lib.report(f, { deep: false }));
  assert.strictEqual(r.autoCompactFiresAt, 0);
  assert.strictEqual(r.pressureMeaningful, false, 'tokens/0 must not become a hardcoded 1.0');
  assert.strictEqual(r.verdict.key, 'optimal', '9K is green; the old code pinned this to CRITICAL');
});

// ── safe() ───────────────────────────────────────────────────

test('safe() strips control characters and neutralises fence-breaking backticks', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const NUL = String.fromCharCode(0);
  const out = lib.safe(ESC + '[31mred' + BEL + NUL + '   spaced\n\nlines   ```fence```');
  assert.ok(!out.includes(ESC), 'ESC enables terminal repainting and forged rows');
  assert.ok(!out.includes(BEL));
  assert.ok(!out.includes(NUL));
  assert.ok(!out.includes('`'), 'backticks are replaced, not merely escaped');
  assert.ok(!out.includes('\n'), 'a newline would let transcript text forge its own report row');
  assert.strictEqual(out.includes('  '), false, 'runs of whitespace collapse');
});

test('safe() caps length and is applied to tool targets at the boundary', () => {
  assert.strictEqual(lib.safe('y'.repeat(300), 40).length, 40);
  assert.ok(lib.safe('y'.repeat(300), 40).endsWith('…'), 'truncation is visible');
  // safe() swaps each backtick for U+2019, length-neutrally, so three backticks
  // can never close the fence the skill reproduces the report inside.
  const RSQ = String.fromCharCode(0x2019);
  assert.strictEqual(lib.targetOf({ command: 'grep ```x``` .' }),
    'grep ' + RSQ.repeat(3) + 'x' + RSQ.repeat(3) + ' .');
  assert.strictEqual(lib.targetOf(null), '');
  assert.strictEqual(lib.targetOf('not an object'), '');
});

// ── Tail reading ─────────────────────────────────────────────

test('readTail returns nothing on a line longer than its window; escalation recovers it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-tail-'));
  const f = path.join(dir, 'big.jsonl');
  // The usage record, then a single tool result far larger than the tail window.
  // This is the shape that blinds the Stop hook: the newest line is bigger than
  // the window, so the window contains no newline at all.
  const withUsage = JSON.stringify({ type: 'assistant', uuid: 'a', messageId: 'm',
    message: { id: 'm', model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 4242, output_tokens: 1 } } });
  const huge = JSON.stringify({ type: 'user', uuid: 'h',
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'z'.repeat(700 * 1024) }] } });
  fs.writeFileSync(f, withUsage + '\n' + huge + '\n');

  // A window landing entirely inside the oversized last line finds no newline.
  assert.strictEqual(lib.readTail(f, 1024).length, 0, 'no newline in the window means no usable tail');
  assert.strictEqual(lib.readTail(f, 512 * 1024).length, 0, 'the real 512KB window is blinded too');
  assert.ok(lib.readTailEscalating(f, 1024).length > 0, 'escalation must recover rather than go blind');

  const r = lib.report(f, { deep: false });
  assert.strictEqual(r.ok, true, 'the per-turn hook must not go blind on an oversized entry');
  assert.strictEqual(r.tokens, 4242, 'and it must still find the measured headline');
});

test('readTail fails soft on a missing or unreadable path', () => {
  assert.strictEqual(lib.readTail(path.join(os.tmpdir(), 'definitely-absent-' + Date.now()), 1024), '');
  assert.strictEqual(lib.readTailEscalating(path.join(os.tmpdir(), 'absent-too-' + Date.now()), 1024), '');
});

// ── Transcript-shape assumptions the README claims are pinned ──

test('assistant-turn dedup works from messageId alone AND from message.id alone', () => {
  // The shared fixture builder in context.test.js sets both fields to the same
  // value, so a rename of either would still pass there. These drive them
  // independently, which is what "pinned" has to mean.
  const only = (field) => {
    const mk = (n) => {
      const e = { type: 'assistant', uuid: 'u' + n, message: { model: 'm', content: [{ type: 'text', text: 'xxxx' }] } };
      if (field === 'messageId') e.messageId = 'same';
      else e.message.id = 'same';
      return e;
    };
    return lib.analyse([mk(1), mk(2), mk(3)]).assistantTurns;
  };
  assert.strictEqual(only('messageId'), 1, 'three fragments of one message are one turn (messageId)');
  assert.strictEqual(only('message.id'), 1, 'three fragments of one message are one turn (message.id)');

  const noId = { type: 'assistant', uuid: 'x', message: { model: 'm', content: [{ type: 'text', text: 'xxxx' }] } };
  assert.strictEqual(lib.analyse([noId, noId]).assistantTurns, 2, 'with no id at all, each entry counts');
});

test('turnsAgo counts assistant turns between the result and now', () => {
  const asst = (n, content) => ({ type: 'assistant', uuid: 'a' + n, messageId: 'm' + n,
    message: { id: 'm' + n, model: 'x', content } });
  const entries = [
    asst(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]),
    { type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } },
    asst(2, [{ type: 'text', text: 'x' }]),
    asst(3, [{ type: 'text', text: 'x' }]),
    asst(4, [{ type: 'text', text: 'x' }]),
  ];
  const a = lib.analyse(entries);
  assert.strictEqual(a.assistantTurns, 4);
  assert.strictEqual(a.topConsumers[0].turnsAgo, 3, 'the result landed after turn 1 of 4');
  assert.strictEqual(a.topConsumers[0].tool, 'Read');
  assert.strictEqual(a.topConsumers[0].target, 'a.ts');
});

test('parseJsonl rejects valid-JSON-but-not-an-object lines', () => {
  const got = lib.parseJsonl('null\n7\n[]\n"s"\n{"type":"user"}\ntrue\n');
  assert.strictEqual(got.length, 1, 'only the object survives');
  assert.strictEqual(got[0].type, 'user');
});

// ── Config validation ────────────────────────────────────────
//
// Every setting fails closed, which is correct and used to be silent: the user
// was left believing a setting was in force. configIssues() is what the report
// prints instead, so these pin the exact wording -- a message that says
// "ignored" without naming the fallback does not tell the user what IS in force.

test('configIssues stays silent when there is nothing to report', () => {
  withState({}, () => {
    assert.deepStrictEqual(lib.configIssues(), [], 'no config file at all');
  });
  withState({ config: { quiet: true, minZone: 'act', contextWindow: '400k' } }, () => {
    assert.deepStrictEqual(lib.configIssues(), [], 'a fully valid config');
  });
  withState({ config: { quiet: false, minZone: null, contextWindow: null } }, () => {
    assert.deepStrictEqual(lib.configIssues(), [], 'null means auto-detect, not a mistake');
  });
});

test('configIssues names the key, the rejected value and the fallback', () => {
  withState({ config: { quiet: 'true', minZone: 'aact', contextWindow: 'four hundred k' } }, () => {
    const got = lib.configIssues();
    assert.strictEqual(got.length, 3, got.join(' | '));
    assert.match(got[0], /^quiet: "true" ignored.*nudges are still on$/);
    assert.match(got[1], /^minZone: "aact" ignored.*floor is watch$/);
    assert.match(got[2], /^contextWindow: "four hundred k" ignored.*being detected$/);
  });
});

test('configIssues flags a key that has no effect at all', () => {
  // The likeliest real typo: JSON keys are case-sensitive and `minzone` is not
  // `minZone`, so the setting reads as absent and the user never finds out.
  withState({ config: { minzone: 'act' } }, () => {
    const got = lib.configIssues();
    assert.strictEqual(got.length, 1, got.join(' | '));
    assert.match(got[0], /unknown key "minzone"/);
  });
});

test('configIssues reports a config file that is not a usable object', () => {
  // A missing comma reverts all three settings at once, which is the worst of
  // the silent cases because nothing in the file looks wrong.
  withState({}, () => {
    fs.writeFileSync(path.join(DATA, 'config.json'), '{ "quiet": true,\n }');
    const got = lib.configIssues();
    assert.strictEqual(got.length, 1);
    assert.match(got[0], /not a usable JSON object/);
    fs.writeFileSync(path.join(DATA, 'config.json'), 'null');
    assert.match(lib.configIssues()[0], /not a usable JSON object/, 'valid JSON, still unusable');
    fs.unlinkSync(path.join(DATA, 'config.json'));
  });
});

test('a rejected config value cannot inject escapes or break the code fence', () => {
  // config.json is user-controlled text that reaches a report the skill relays
  // verbatim inside a fence, so it goes through the same sanitiser as the
  // transcript rather than being trusted for being local.
  const hostile = 'a' + String.fromCharCode(27) + '[31m```red';
  withState({ config: { minZone: hostile } }, () => {
    const got = lib.configIssues().join('\n');
    assert.ok(!got.includes(String.fromCharCode(27)), 'no escape survives');
    assert.ok(!got.includes('`'), 'no backtick survives: ' + got);
  });
});

test('configIssues describes a non-scalar without dumping it', () => {
  withState({ config: { quiet: { nested: true }, minZone: ['act'] } }, () => {
    const got = lib.configIssues();
    assert.match(got[0], /quiet: an object ignored/);
    assert.match(got[1], /minZone: a list ignored/);
  });
});

// ── Session state ────────────────────────────────────────────
//
// One implementation, because both hooks address the same file: stop-nudge.js
// keeps the zone bookkeeping and pre-compact.js queues an announcement into it.
// They used to sanitise the session id into a filename separately, and
// differently, so the two could address different files.

test('a session id can never escape the sessions directory', () => {
  const BS = String.fromCharCode(92); // a literal backslash, without one in this file
  for (const id of ['../../evil', '..', '.', '', null, undefined, 'a/b', 'a' + BS + 'b', 'C:' + BS + 'x']) {
    const file = lib.sessionStateFile(id);
    assert.strictEqual(path.dirname(file), lib.sessionsDir(),
      JSON.stringify(id) + ' escaped to ' + file);
  }
  assert.strictEqual(lib.sessionKey('abc-123_X.9'), 'abc-123_X.9', 'a real uuid survives intact');
  assert.strictEqual(lib.sessionKey('..'), 'unknown');
  assert.strictEqual(lib.sessionKey('.'), 'unknown');
  assert.strictEqual(lib.sessionKey(''), 'unknown');
});

test('session state round-trips, and an absent file reads as null', () => {
  const id = 'roundtrip-session';
  assert.strictEqual(lib.readSessionState(id), null, 'null is the first-turn signal');
  assert.strictEqual(lib.writeSessionState(id, { warnedSeverity: 2, pending: ['x'] }), true);
  const got = lib.readSessionState(id);
  assert.strictEqual(got.warnedSeverity, 2);
  assert.deepStrictEqual(lib.pendingOf(got), ['x']);
});

test('pendingOf tolerates every shape a hand-edited state file can hold', () => {
  assert.deepStrictEqual(lib.pendingOf(null), []);
  assert.deepStrictEqual(lib.pendingOf({}), []);
  assert.deepStrictEqual(lib.pendingOf({ pending: 'nope' }), []);
  assert.deepStrictEqual(lib.pendingOf({ pending: ['a', 7, null, {}, 'b'] }), ['a', 'b']);
});

test('fmt is one implementation, and both hooks use it', () => {
  assert.strictEqual(lib.fmt(368), '368');
  assert.strictEqual(lib.fmt(412300), '412K');
  assert.strictEqual(lib.fmt(1000000), '1M');
  assert.strictEqual(lib.fmt(1200000), '1.2M');
  const src = ['stop-nudge.js', 'pre-compact.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8'));
  for (const s of src) {
    assert.ok(s.includes('lib.fmt'), 'hook must use the shared formatter');
    assert.ok(!/const fmt = \(n\) =>/.test(s), 'hook must not carry its own copy');
  }
});
