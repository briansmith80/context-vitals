'use strict';
//
// Tests for lib/context.js.
//
// The whole plugin rests on the shape of Claude Code's transcript JSONL —
// `isSidechain`, `messageId`, `toolUseResult`, `compact_boundary` — none of
// which is documented or stable. These fixtures pin the assumptions so a change
// upstream fails here instead of silently producing a wrong reading.
//
//   node --test plugins/context-vitals/test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the developer's real config: detectWindow reads config.json from
// the plugin data dir, and an override there would make these tests machine-
// dependent. Must be set before the module reads it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-test-'));
process.env.CLAUDE_PLUGIN_DATA = path.join(TMP, 'data');
process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000000';

const lib = require('../lib/context');

// ── Fixture builders ─────────────────────────────────────────

let uid = 0;
const nextUuid = () => `uuid-${++uid}`;

function assistant(opts = {}) {
  const uuid = opts.uuid || nextUuid();
  return {
    type: 'assistant',
    isSidechain: !!opts.isSidechain,
    uuid,
    messageId: opts.messageId || `msg-${uuid}`,
    message: {
      id: opts.messageId || `msg-${uuid}`,
      model: opts.model || 'claude-opus-5',
      content: opts.content || [{ type: 'text', text: opts.text || '' }],
      usage: opts.usage,
    },
  };
}

function toolCall(id, name, input, opts = {}) {
  return assistant({ ...opts, content: [{ type: 'tool_use', id, name, input }] });
}

function toolResult(id, chars, opts = {}) {
  return {
    type: 'user',
    isSidechain: !!opts.isSidechain,
    uuid: opts.uuid || nextUuid(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(chars) }] },
  };
}

function userText(text, opts = {}) {
  return {
    type: 'user',
    isSidechain: false,
    uuid: opts.uuid || nextUuid(),
    message: { content: [{ type: 'text', text }] },
  };
}

function usage(total) {
  return { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: total - 10, output_tokens: 100 };
}

function boundary(preservedUuids, opts = {}) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    isSidechain: false,
    uuid: nextUuid(),
    content: 'Conversation compacted',
    compactMetadata: {
      trigger: opts.trigger || 'auto',
      preTokens: opts.preTokens || 1000000,
      postTokens: opts.postTokens || 20000,
      cumulativeDroppedTokens: opts.dropped || 980000,
      ...(preservedUuids ? { preservedMessages: { allUuids: preservedUuids, uuids: preservedUuids } } : {}),
      ...(opts.segmentHead ? { preservedSegment: { headUuid: opts.segmentHead } } : {}),
    },
  };
}

/** Write entries to a temp .jsonl and return its path. */
function transcript(entries) {
  const p = path.join(TMP, `t-${++uid}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return p;
}

// ── parseWindow ──────────────────────────────────────────────

test('parseWindow accepts every form Claude Code accepts', () => {
  assert.equal(lib.parseWindow(400000), 400000);
  assert.equal(lib.parseWindow('400000'), 400000);
  assert.equal(lib.parseWindow('400k'), 400000);
  assert.equal(lib.parseWindow('400K'), 400000);
  assert.equal(lib.parseWindow('1M'), 1000000);
  assert.equal(lib.parseWindow('1m'), 1000000);
  assert.equal(lib.parseWindow('1.5M'), 1500000);
  assert.equal(lib.parseWindow(' 400k '), 400000);
});

test('parseWindow treats a bare 100-1000 as thousands', () => {
  assert.equal(lib.parseWindow(400), 400000);
  assert.equal(lib.parseWindow('400'), 400000);
  assert.equal(lib.parseWindow(1000), 1000000);
  // Outside that range it is a literal token count.
  assert.equal(lib.parseWindow(99), 99);
  assert.equal(lib.parseWindow(200000), 200000);
});

test('parseWindow rejects junk rather than guessing', () => {
  for (const bad of [null, undefined, '', 'auto', 'AUTO', 'lots', '-5', 0, -1, NaN, Infinity, '4 0 0 k', {}]) {
    assert.equal(lib.parseWindow(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ── Usage measurement ────────────────────────────────────────

test('findLatestUsage sums the three input components', () => {
  const e = [assistant({ usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 9 } })];
  const got = lib.findLatestUsage(e);
  assert.equal(got.tokens, 600, 'cache reads and creations are part of what was sent');
  assert.equal(got.output, 9);
});

test('findLatestUsage ignores sidechains: subagents have their own windows', () => {
  const e = [
    assistant({ usage: usage(50000) }),
    assistant({ isSidechain: true, usage: usage(900000) }),
  ];
  assert.equal(lib.findLatestUsage(e).tokens, 50000);
});

test('findLatestUsage takes the most recent record, and tolerates missing usage', () => {
  const e = [assistant({ usage: usage(10000) }), assistant({ usage: undefined }), assistant({ usage: usage(30000) })];
  assert.equal(lib.findLatestUsage(e).tokens, 30000);
  assert.equal(lib.findLatestUsage([assistant({})]), null);
  assert.equal(lib.findLatestUsage([]), null);
});

// ── Zone classification ──────────────────────────────────────

test('degradation zones classify on absolute tokens', () => {
  const z = (n) => lib.classify(lib.DEGRADATION_ZONES, n).key;
  assert.equal(z(0), 'optimal');
  assert.equal(z(149999), 'optimal');
  assert.equal(z(150000), 'watch', 'boundary is inclusive-lower');
  assert.equal(z(349999), 'watch');
  assert.equal(z(350000), 'act');
  assert.equal(z(600000), 'degraded');
  assert.equal(z(850000), 'critical');
  assert.equal(z(5000000), 'critical');
});

test('pressure zones classify on fraction of the trigger point', () => {
  const z = (f) => lib.classify(lib.PRESSURE_ZONES, f).key;
  assert.equal(z(0), 'optimal');
  assert.equal(z(0.5), 'watch');
  assert.equal(z(0.75), 'act');
  assert.equal(z(0.9), 'degraded');
  assert.equal(z(1.0), 'critical');
  assert.equal(z(1.4), 'critical');
});

test('severity ordering is what makes "report the worse zone" work', () => {
  const s = lib.SEVERITY;
  assert.ok(s.optimal < s.watch && s.watch < s.act && s.act < s.degraded && s.degraded < s.critical);
});

// ── liveSlice: the compaction fix ─────────────────────────────

test('liveSlice is a no-op on a transcript with no compaction', () => {
  const e = [userText('hi'), assistant({ usage: usage(1000) })];
  const s = lib.liveSlice(e);
  assert.equal(s.live.length, 2);
  assert.equal(s.compactions, 0);
  assert.equal(s.trigger, null);
});

test('liveSlice keeps preserved pre-boundary messages and everything after', () => {
  const keep = userText('still in context', { uuid: 'keep-me' });
  const e = [
    userText('dropped'),
    toolCall('t1', 'Read', { file_path: '/gone.ts' }),
    toolResult('t1', 400000),
    keep,
    boundary(['keep-me'], { trigger: 'manual', dropped: 123456 }),
    assistant({ usage: usage(20000), text: 'after' }),
  ];
  const s = lib.liveSlice(e);
  assert.equal(s.compactions, 1);
  assert.equal(s.trigger, 'manual');
  assert.equal(s.droppedTokens, 123456);
  assert.equal(s.live.length, 2, 'the preserved message plus the post-boundary turn');
  assert.equal(s.live[0].uuid, 'keep-me');
  assert.equal(s.live[1].message.content[0].text, 'after');
});

test('liveSlice honours only the LAST boundary', () => {
  const e = [
    userText('gen 1'),
    userText('preserved by first boundary only', { uuid: 'gen1-keep' }),
    boundary(['gen1-keep']),
    userText('gen 2', { uuid: 'gen2-keep' }),
    boundary(['gen2-keep']),
    assistant({ usage: usage(5000) }),
  ];
  const s = lib.liveSlice(e);
  assert.equal(s.compactions, 2);
  assert.deepEqual(s.live.map((x) => x.uuid).slice(0, 1), ['gen2-keep']);
  assert.ok(!s.live.some((x) => x.uuid === 'gen1-keep'), 'dropped by the second compaction');
});

test('liveSlice falls back to preservedSegment.headUuid on older transcripts', () => {
  const e = [
    userText('dropped'),
    userText('segment head', { uuid: 'head' }),
    userText('in segment'),
    boundary(null, { segmentHead: 'head' }),
    assistant({ usage: usage(9000) }),
  ];
  const s = lib.liveSlice(e);
  assert.equal(s.live.length, 3, 'head + rest of segment + post-boundary turn');
  assert.equal(s.live[0].uuid, 'head');
});

test('liveSlice under-counts rather than over-counts when metadata is absent', () => {
  const e = [userText('dropped'), boundary(null), assistant({ usage: usage(9000) })];
  const s = lib.liveSlice(e);
  assert.equal(s.live.length, 1, 'only the post-boundary turn: better than counting dropped entries');
  assert.equal(s.compactions, 1);
});

// ── analyse ──────────────────────────────────────────────────

test('analyse attributes each block type to its own category', () => {
  const e = [
    userText('y'.repeat(400)),
    toolCall('t1', 'Read', { file_path: '/a.ts' }),
    toolResult('t1', 4000),
    assistant({ content: [{ type: 'text', text: 'z'.repeat(800) }] }),
  ];
  const cats = {};
  for (const b of lib.analyse(e).breakdown) cats[b.category] = b.tokensEst;
  assert.equal(cats.tool_results, 1000, '4000 chars at ~4 chars/token');
  assert.equal(cats.user_prompts, 100);
  assert.equal(cats.assistant_text, 200);
  assert.ok(cats.tool_calls > 0);
});

test('analyse counts redacted thinking via its signature', () => {
  // Claude Code usually stores thinking with empty text and only the encrypted
  // signature, which is what actually gets replayed to the API.
  const e = [assistant({ content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(4000) }] })];
  const cats = Object.fromEntries(lib.analyse(e).breakdown.map((b) => [b.category, b.tokensEst]));
  assert.equal(cats.thinking, 1000);
});

test('analyse excludes sidechain traffic', () => {
  const e = [
    toolCall('t1', 'Read', { file_path: '/a.ts' }, { isSidechain: true }),
    toolResult('t1', 400000, { isSidechain: true }),
  ];
  assert.deepEqual(lib.analyse(e).breakdown, []);
});

test('analyse flags re-read files and ranks the largest results', () => {
  const e = [
    toolCall('t1', 'Read', { file_path: '/a.ts' }), toolResult('t1', 1000),
    toolCall('t2', 'Read', { file_path: '/big.ts' }), toolResult('t2', 90000),
    toolCall('t3', 'Read', { file_path: '/a.ts' }), toolResult('t3', 1000),
    toolCall('t4', 'Read', { file_path: '/a.ts' }), toolResult('t4', 1000),
  ];
  const a = lib.analyse(e);
  assert.deepEqual(a.rereads, [{ file: '/a.ts', count: 3 }], 'only files read more than once');
  assert.equal(a.topConsumers[0].target, '/big.ts');
  assert.equal(a.topConsumers[0].tokensEst, 22500);
});

test('analyse does not double-count toolUseResult alongside a tool_result block', () => {
  const withBoth = { ...toolResult('t1', 4000), toolUseResult: 'x'.repeat(400000) };
  const e = [toolCall('t1', 'Read', { file_path: '/a.ts' }), withBoth];
  const cats = Object.fromEntries(lib.analyse(e).breakdown.map((b) => [b.category, b.tokensEst]));
  assert.equal(cats.tool_results, 1000, 'the content block wins; toolUseResult is a fallback');
});

test('analyse counts toolUseResult when there is no tool_result block', () => {
  const e = [{ type: 'user', uuid: 'u', message: { content: [] }, toolUseResult: 'x'.repeat(4000) }];
  const cats = Object.fromEntries(lib.analyse(e).breakdown.map((b) => [b.category, b.tokensEst]));
  assert.equal(cats.tool_results, 1000);
});

test('analyse counts distinct assistant turns, not streamed fragments', () => {
  const e = [
    assistant({ messageId: 'm1' }), assistant({ messageId: 'm1' }),
    assistant({ messageId: 'm2' }),
  ];
  assert.equal(lib.analyse(e).assistantTurns, 2);
});

// ── report: the regression this suite exists for ──────────────

test('report: breakdown never exceeds the measured total after a compaction', () => {
  // 400K chars of tool result ≈ 100K estimated tokens, all of it compacted
  // away. The measured context afterwards is 20K. Counting the dropped result
  // is what made percentages exceed 100% and clamped the residual to zero.
  const keep = userText('carried through', { uuid: 'kept' });
  const p = transcript([
    toolCall('t1', 'Read', { file_path: '/legacy/huge.ts' }),
    toolResult('t1', 400000),
    keep,
    boundary(['kept'], { trigger: 'auto', dropped: 980000 }),
    assistant({ usage: usage(20000), text: 'post-compaction turn' }),
  ]);

  const r = lib.report(p, { deep: true });
  assert.ok(r.ok, r.reason);
  assert.equal(r.tokens, 20000);

  const accounted = r.breakdown.reduce((s, b) => s + b.tokensEst, 0);
  assert.ok(accounted <= r.tokens, `attributed ${accounted} must not exceed measured ${r.tokens}`);
  assert.ok(r.overheadEst > 0, 'residual must stay positive: the baseline is always in context');
  assert.equal(r.compactions, 1);
  assert.equal(r.lastCompactTrigger, 'auto');
  assert.equal(r.droppedTokens, 980000);

  assert.ok(
    !r.topConsumers.some((c) => c.target.includes('huge.ts')),
    'a discarded result is not a prune candidate: it is already gone',
  );
});

test('report: every category percentage stays within bounds after compaction', () => {
  const p = transcript([
    toolCall('t1', 'Read', { file_path: '/a.ts' }), toolResult('t1', 800000),
    boundary(['none']),
    assistant({ usage: usage(30000) }),
  ]);
  const r = lib.report(p, { deep: true });
  for (const b of r.breakdown) {
    assert.ok(b.tokensEst <= r.tokens, `${b.category} (${b.tokensEst}) exceeds total ${r.tokens}`);
  }
});

test('report: an uncompacted transcript still attributes its tool results', () => {
  const p = transcript([
    toolCall('t1', 'Read', { file_path: '/a.ts' }), toolResult('t1', 40000),
    assistant({ usage: usage(60000) }),
  ]);
  const r = lib.report(p, { deep: true });
  const cats = Object.fromEntries(r.breakdown.map((b) => [b.category, b.tokensEst]));
  assert.equal(cats.tool_results, 10000);
  assert.equal(r.compactions, 0);
  assert.ok(r.topConsumers[0].target.includes('a.ts'));
});

test('report: shallow mode escalates past the tail to find usage', () => {
  // One oversized tool result pushes the usage record out of the 512KB tail.
  // Going blind here — at maximum context — is the failure worth avoiding.
  const p = transcript([
    assistant({ usage: usage(700000) }),
    toolCall('t1', 'Read', { file_path: '/enormous.ts' }),
    toolResult('t1', lib.TAIL_BYTES + 100000),
  ]);
  assert.ok(fs.statSync(p).size > lib.TAIL_BYTES);

  const r = lib.report(p, { deep: false });
  assert.ok(r.ok, 'must escalate to a full read rather than report no data');
  assert.equal(r.tokens, 700000);
  assert.equal(r.degradationZone.key, 'degraded');
});

test('report: verdict takes the worse of the two zones and names the driver', () => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
  const p = transcript([assistant({ usage: usage(400000) })]);
  const deg = lib.report(p, { deep: true });
  assert.equal(deg.degradationZone.key, 'act');
  assert.equal(deg.pressureZone.key, 'optimal');
  assert.equal(deg.verdict.key, 'act');
  assert.equal(deg.verdict.driver, 'degradation', 'quality is binding on a wide window');

  // Same context, a low trigger: now runway binds instead.
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000';
  const pres = lib.report(p, { deep: true });
  assert.equal(pres.verdict.key, 'critical');
  assert.equal(pres.verdict.driver, 'pressure');
  assert.ok(pres.tokensUntilAutoCompact < 0, 'already past the trigger');
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
});

test('report fails soft on a missing or contentless transcript', () => {
  assert.equal(lib.report(path.join(TMP, 'nope.jsonl'), { deep: true }).ok, false);
  assert.equal(lib.report(null, { deep: true }).ok, false);
  assert.equal(lib.report(transcript([userText('no assistant turn yet')]), { deep: true }).ok, false);
});

// ── Auto-compact window detection ────────────────────────────

test('detectAutoCompactWindow prefers the env var and marks it configured', () => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '400k';
  const got = lib.detectAutoCompactWindow(1000000);
  assert.equal(got.window, 400000);
  assert.equal(got.configured, true);
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
});

test('detectAutoCompactWindow never exceeds the model window', () => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1M';
  assert.equal(lib.detectAutoCompactWindow(200000).window, 200000);
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
});

test('an unconfigured trigger point is reported as an upper bound', () => {
  const p = transcript([assistant({ usage: usage(100000) })]);
  const r = lib.report(p, { deep: true });
  // configured === false only when neither env nor settings supplies a window;
  // assert the invariant that ties the two fields together either way.
  assert.equal(r.firesAtIsUpperBound, !r.autoCompactConfigured);
});

// ── parseJsonl ───────────────────────────────────────────────

test('parseJsonl skips blanks, prose and truncated lines', () => {
  const got = lib.parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n{"c":tru');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});

// ── pruneDir ─────────────────────────────────────────────────

test('pruneDir keeps the newest N and leaves other extensions alone', () => {
  const dir = path.join(TMP, 'prune');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `s${i}.json`);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
  }
  fs.writeFileSync(path.join(dir, 'keep.md'), 'x');

  assert.equal(lib.pruneDir(dir, '.json', 2), 4, 'reports how many it removed');
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['keep.md', 's4.json', 's5.json']);
});

test('pruneDir is a no-op on a missing directory', () => {
  assert.equal(lib.pruneDir(path.join(TMP, 'absent'), '.json', 5), 0);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
