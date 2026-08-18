#!/usr/bin/env node
'use strict';
//
// context-report.js — the /context-check data source.
//
// Usage:
//   node context-report.js --transcript <path> [--format text|json]
//   node context-report.js --session <id>      [--format text|json]
//   node context-report.js                     (auto-detects newest transcript for cwd)
//
// Prints a measured context reading plus an estimated breakdown. Exits 0 even
// when it cannot determine usage, so a caller never has to handle failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { report } = require('../lib/context');

// ── Args ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const format = (arg('format') || 'text').toLowerCase();

// ── Locate the transcript ────────────────────────────────────

/** Claude Code stores transcripts under ~/.claude/projects/<slugified-cwd>/<session>.jsonl */
function projectDirFor(cwd) {
  const slug = path.resolve(cwd).replace(/[\\/:]+/g, '-').replace(/^-+/, '');
  const base = path.join(os.homedir(), '.claude', 'projects');
  const candidates = [slug, 'C--' + slug];
  for (const c of candidates) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  // Fall back to a fuzzy match on the directory basename.
  try {
    const want = path.basename(path.resolve(cwd)).toLowerCase();
    const hit = fs.readdirSync(base).filter((d) => d.toLowerCase().endsWith(want));
    if (hit.length) return path.join(base, hit[0]);
  } catch { /* no projects dir */ }
  return null;
}

function newestTranscript(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? files[0].f : null;
  } catch { return null; }
}

function resolveTranscript() {
  const explicit = arg('transcript');
  if (explicit) return explicit;

  const dir = projectDirFor(process.cwd());
  if (!dir) return null;

  const session = arg('session');
  if (session) {
    const p = path.join(dir, session + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return newestTranscript(dir);
}

// ── Formatting ───────────────────────────────────────────────

const CATEGORY_LABELS = {
  tool_results: 'Tool results',
  tool_calls: 'Tool calls',
  assistant_text: 'Assistant text',
  thinking: 'Thinking',
  user_prompts: 'Your prompts',
  attachments: 'Attachments',
};

function fmtTokens(n) {
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (v >= 1000000) return sign + (v / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (v >= 1000) return sign + Math.round(v / 1000) + 'K';
  return sign + String(v);
}

function bar(fraction, width) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function renderText(r) {
  const L = [];
  const v = r.verdict;

  L.push('');
  L.push(`  CONTEXT DOCTOR   ${v.emoji} ${v.label}`);
  L.push('  ' + '─'.repeat(62));
  L.push('');
  L.push(`  ${bar(r.tokens / r.window, 40)}  ${r.pctOfWindow}% of window`);
  L.push(`  ${fmtTokens(r.tokens)} of ${fmtTokens(r.window)} tokens in context`);
  L.push('');

  // The two independent readings.
  L.push(`  Degradation  ${r.degradationZone.emoji} ${pad(r.degradationZone.label, 9)} (absolute size: ${fmtTokens(r.tokens)})`);
  L.push(`  Pressure     ${r.pressureZone.emoji} ${pad(r.pressureZone.label, 9)} (${r.pctOfAutoCompact}% of the way to auto-compaction)`);
  L.push('');
  L.push(`  ${v.headline}`);
  L.push('');

  // Auto-compaction status.
  const until = r.tokensUntilAutoCompact;
  L.push(`  Auto-compact window : ${fmtTokens(r.autoCompactWindow)}  (${r.autoCompactSource})`);
  if (until > 0) {
    // Without a configured window the true trigger is model-tuned and lower
    // than this, so say "at most" rather than implying a measured figure.
    L.push(r.firesAtIsUpperBound
      ? `  Fires in            : at most ~${fmtTokens(until)} more tokens (trigger not configured)`
      : `  Fires in            : ~${fmtTokens(until)} more tokens`);
  } else {
    L.push(`  Fires in            : IMMINENT OR PASSED (~${fmtTokens(-until)} over)`);
  }
  L.push(`  Detected window     : ${fmtTokens(r.window)}  (${r.windowSource})`);

  if (r.compactions > 0) {
    const n = r.compactions;
    const trigger = r.lastCompactTrigger ? `, last was ${r.lastCompactTrigger}` : '';
    L.push(`  Compactions so far  : ${n}${trigger}`);
    L.push(`                        everything below covers the post-compaction`);
    L.push(`                        context only${r.droppedTokens ? `; ~${fmtTokens(r.droppedTokens)} already dropped` : ''}`);
  }

  if (r.breakdown && r.breakdown.length) {
    L.push('');
    L.push('  Estimated breakdown');
    const rows = r.breakdown.slice();
    if (r.overheadEst > 0) {
      rows.push({ category: 'overhead', tokensEst: r.overheadEst });
    }
    rows.sort((a, b) => b.tokensEst - a.tokensEst);
    for (const row of rows) {
      const label = row.category === 'overhead'
        ? 'Baseline + unattributed'
        : (CATEGORY_LABELS[row.category] || row.category);
      const pct = Math.round(100 * row.tokensEst / r.tokens);
      L.push(`    ${pad(label, 36)} ${pad(fmtTokens(row.tokensEst), 7)} ${bar(row.tokensEst / r.tokens, 14)} ${pct}%`);
    }
    L.push('    Baseline + unattributed = system prompt, tool schemas, CLAUDE.md,');
    L.push('    memory, and anything the transcript stores redacted.');
    L.push('    (character-derived estimates; the headline figure above is measured)');
  }

  if (r.topConsumers && r.topConsumers.length) {
    L.push('');
    L.push('  Largest tool results  (prune candidates, oldest first is safest)');
    for (const c of r.topConsumers.slice(0, 6)) {
      const where = c.target ? ` ${c.target}` : '';
      const ago = `${c.turnsAgo} turn${c.turnsAgo === 1 ? '' : 's'} ago`;
      L.push(`    ${pad(fmtTokens(c.tokensEst), 7)} ${pad(c.tool + where, 46)} ${ago}`);
    }
  }

  if (r.rereads && r.rereads.length) {
    L.push('');
    L.push('  Re-read files  (near-duplicate versions compete for attention)');
    for (const x of r.rereads.slice(0, 6)) L.push(`    ${x.count}×  ${x.file}`);
  }

  L.push('');
  return L.join('\n');
}

// ── Main ─────────────────────────────────────────────────────

let r;
try {
  const t = resolveTranscript();
  r = report(t, { deep: true });
  if (r.ok) r.transcript = t;
} catch (err) {
  r = { ok: false, reason: String((err && err.message) || err) };
}

if (format === 'json') {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
} else if (!r.ok) {
  process.stdout.write(`\n  CONTEXT DOCTOR — could not read usage: ${r.reason}\n` +
    `  Run /context for Claude Code's own built-in breakdown.\n\n`);
} else {
  process.stdout.write(renderText(r) + '\n');
}
process.exit(0);
