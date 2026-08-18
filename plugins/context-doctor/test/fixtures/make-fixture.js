#!/usr/bin/env node
'use strict';
//
// make-fixture.js — regenerate the committed showcase transcript.
//
// The README's sample /context-check block must be a real capture, not prose
// edited by hand: a hand-written sample drifts from the renderer and then
// misrepresents a measurement tool. Run:
//
//   node plugins/context-doctor/test/fixtures/make-fixture.js
//   CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000 \
//     node plugins/context-doctor/scripts/context-report.js \
//     --transcript plugins/context-doctor/test/fixtures/showcase.jsonl
//
// The scenario is chosen to exercise every branch worth showing: a
// degradation-driven verdict on a 1M window, a configured auto-compact trigger
// that is NOT the binding constraint, one prior manual compaction, and a
// breakdown whose largest bucket is disposable tool output.

const fs = require('fs');
const path = require('path');

const T = (n) => 'x'.repeat(n * 4); // n estimated tokens, at 4 chars/token

let uuidN = 0;
const uuid = () => 'f'.repeat(8) + '-0000-4000-8000-' + String(++uuidN).padStart(12, '0');

const lines = [];
const CWD = 'C:\\\\example\\\\project';
const push = (o) => lines.push(JSON.stringify(o));

let msgN = 0;
const assistant = (blocks, usage) => {
  const id = 'msg_' + String(++msgN).padStart(4, '0');
  push({
    type: 'assistant', uuid: uuid(), cwd: CWD, messageId: id,
    message: Object.assign({ id, role: 'assistant', model: 'claude-opus-5', content: blocks },
      usage ? { usage } : {}),
  });
};
const user = (blocks) => push({ type: 'user', uuid: uuid(), cwd: CWD, message: { role: 'user', content: blocks } });

// ── Pre-compaction: discarded by the boundary below ──────────
user([{ type: 'text', text: 'Start the migration.' }]);
assistant([{ type: 'text', text: 'Working on it.' }], {
  input_tokens: 180000, cache_creation_input_tokens: 0, cache_read_input_tokens: 400000, output_tokens: 900,
});

push({
  type: 'system', subtype: 'compact_boundary', uuid: uuid(), cwd: CWD,
  compactMetadata: {
    trigger: 'manual',
    postTokens: 96000,
    cumulativeDroppedTokens: 180000,
    preservedMessages: { allUuids: [] },
  },
});

// ── Post-compaction: this is what the report describes ───────
user([{ type: 'text', text: 'Summary of prior work: the migration is half done. ' + T(4000) }]);

// The three results that dominate, oldest first so turnsAgo is large.
const mkResult = (id, tool, input, tokens) => {
  assistant([{ type: 'tool_use', id, name: tool, input }]);
  user([{ type: 'tool_result', tool_use_id: id, content: T(tokens) }]);
};

mkResult('tu_grep', 'Grep', { pattern: 'createUser\\(' }, 12000);
for (let i = 0; i < 8; i++) assistant([{ type: 'text', text: T(400) }, { type: 'thinking', thinking: '', signature: T(1200) }]);

mkResult('tu_read', 'Read', { file_path: 'src/legacy/report-builder.ts' }, 31000);
for (let i = 0; i < 12; i++) assistant([{ type: 'text', text: T(400) }, { type: 'thinking', thinking: '', signature: T(1200) }]);

mkResult('tu_bash', 'Bash', { description: 'run the full integration suite', command: 'npm run test:integration -- --coverage' }, 18000);

// Re-reads: near-duplicate versions competing for attention.
mkResult('tu_r1', 'Read', { file_path: 'src/auth.ts' }, 9000);
mkResult('tu_r2', 'Read', { file_path: 'src/auth.ts' }, 9000);
mkResult('tu_r3', 'Read', { file_path: 'src/auth.ts' }, 9000);
mkResult('tu_r4', 'Read', { file_path: 'src/legacy/report-builder.ts' }, 8000);

// Bulk of the remaining tool output, spread over ordinary turns.
for (let i = 0; i < 14; i++) {
  mkResult('tu_bulk' + i, i % 2 ? 'Bash' : 'Read',
    i % 2 ? { description: 'check migration step ' + i } : { file_path: 'src/module-' + i + '.ts' }, 9000);
}

// An injected system reminder, counted in the attachments bucket.
push({ type: 'attachment', uuid: uuid(), cwd: CWD, attachment: { type: 'system_reminder', text: T(2000) } });

// A few more thinking-heavy turns to reach the thinking budget.
for (let i = 0; i < 8; i++) assistant([{ type: 'text', text: T(300) }, { type: 'thinking', thinking: '', signature: T(1400) }]);

user([{ type: 'text', text: 'Now finish the report renderer. ' + T(500) }]);

// The final turn carries the measured headline. 412,300 tokens in context.
assistant([{ type: 'text', text: 'Here is the plan.' }], {
  input_tokens: 12300, cache_creation_input_tokens: 100000, cache_read_input_tokens: 300000, output_tokens: 1400,
});

const out = path.join(__dirname, 'showcase.jsonl');
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log('wrote ' + out + ' (' + lines.length + ' entries)');
