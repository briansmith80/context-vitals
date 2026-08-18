#!/usr/bin/env node
'use strict';
//
// pre-compact.js — PreCompact hook. Fires immediately before compaction.
//
// Two jobs:
//   1. Write a recovery snapshot of what was in context (files read, tool
//      surface, size). After compaction that detail is gone; the snapshot is
//      what lets you rehydrate deliberately instead of re-deriving.
//   2. Tell the user when the compaction is AUTOMATIC — i.e. unfocused, the
//      lossy case, where the summariser keeps what it guesses matters.
//
// It never blocks. Blocking an auto-compaction would drive the conversation
// into the model's hard limit, which is strictly worse than a lossy summary.

const fs = require('fs');
const path = require('path');

function silent() { process.exit(0); }

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { silent(); }

let hook;
try { hook = JSON.parse(raw); } catch { silent(); }

let lib;
try { lib = require('../lib/context'); } catch { silent(); }

let r = null;
try { r = lib.report(hook.transcript_path, { deep: true }); } catch { /* snapshot is best-effort */ }

const isAuto = hook.trigger === 'auto';
const fmt = (n) => {
  const v = Math.abs(n);
  if (v >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (v >= 1000) return Math.round(n / 1000) + 'K';
  return String(Math.round(n));
};

// ── Recovery snapshot ────────────────────────────────────────

let snapshotPath = null;
try {
  const dir = path.join(lib.dataDir(), 'compactions');
  fs.mkdirSync(dir, { recursive: true });

  // Snapshots are a recovery aid for the compaction that just happened, not an
  // archive. Keep a useful history, discard the rest.
  lib.pruneDir(dir, '.md', 30);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  snapshotPath = path.join(dir, `${stamp}-${hook.session_id || 'session'}.md`);

  const L = [];
  L.push(`# Pre-compaction snapshot`);
  L.push('');
  L.push(`- When: ${new Date().toISOString()}`);
  L.push(`- Trigger: **${hook.trigger || 'unknown'}**${isAuto ? ' (unfocused — summariser chose what survived)' : ' (you chose the focus)'}`);
  L.push(`- Session: \`${hook.session_id || 'unknown'}\``);
  L.push(`- Working dir: \`${hook.cwd || process.cwd()}\``);
  if (r && r.ok) {
    L.push(`- Context at compaction: **${fmt(r.tokens)}** of ${fmt(r.window)} (${r.pctOfWindow}%)`);
    L.push(`- Zone: ${r.verdict.label} (degradation ${r.degradationZone.label} / pressure ${r.pressureZone.label})`);
    if (r.compactions > 0) {
      L.push(`- Earlier compactions this session: ${r.compactions}` +
        (r.droppedTokens ? ` (~${fmt(r.droppedTokens)} dropped before this one)` : ''));
    }
  }
  L.push('');

  if (r && r.ok && r.breakdown && r.breakdown.length) {
    L.push('## What was in context (estimated)');
    L.push('');
    L.push('| Category | Tokens |');
    L.push('| :-- | --: |');
    for (const b of r.breakdown) L.push(`| ${b.category} | ${fmt(b.tokensEst)} |`);
    if (r.overheadEst > 0) L.push(`| baseline (system, tools, CLAUDE.md) | ${fmt(r.overheadEst)} |`);
    L.push('');
  }

  if (r && r.ok && r.rereads && r.rereads.length) {
    L.push('## Files read more than once');
    L.push('');
    L.push('These were central enough to revisit. Re-read them first if the summary loses the thread.');
    L.push('');
    for (const x of r.rereads) L.push(`- \`${x.file}\` (${x.count}×)`);
    L.push('');
  }

  if (r && r.ok && r.topConsumers && r.topConsumers.length) {
    L.push('## Largest tool results discarded');
    L.push('');
    for (const c of r.topConsumers) {
      L.push(`- ${fmt(c.tokensEst)} — \`${c.tool}\`${c.target ? ' ' + c.target : ''} (${c.turnsAgo} turns before compaction)`);
    }
    L.push('');
  }

  fs.writeFileSync(snapshotPath, L.join('\n'), 'utf8');
} catch { snapshotPath = null; }

// ── User-facing message ──────────────────────────────────────

const out = {};

if (isAuto) {
  const lines = [
    `⚠ AUTO-compaction running — unfocused.`,
    `   The summariser keeps what it guesses matters, not what you would have chosen.`,
  ];
  if (r && r.ok) lines.push(`   Context was ${fmt(r.tokens)} of ${fmt(r.window)} (${r.pctOfWindow}%).`);
  if (snapshotPath) lines.push(`   Recovery snapshot: ${snapshotPath}`);
  lines.push(`   To avoid this next time: /context-setup, then compact deliberately in the ACT zone.`);
  out.systemMessage = lines.join('\n');
} else if (snapshotPath) {
  out.systemMessage = `\u{1F4CB} Pre-compaction snapshot written: ${snapshotPath}`;
}

if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
process.exit(0);
