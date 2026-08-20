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
// Job 2 cannot be done from here. Claude Code discards a PreCompact hook's
// `systemMessage`, so anything this file prints for the user is dropped on the
// floor — which meant the auto-compaction warning and the snapshot path were
// never shown to anyone. The announcement is queued into the session state file
// instead, and stop-nudge.js delivers it on the next turn, because Stop's
// `systemMessage` *is* shown.
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
if (!hook || typeof hook !== 'object' || Array.isArray(hook)) silent();

let lib;
try { lib = require('../lib/context'); } catch { silent(); }

let r = null;
try { r = lib.report(hook.transcript_path, { deep: true }); } catch { /* snapshot is best-effort */ }

// Verified against the shipped CLI, which builds the payload as
// `hook_event_name:"PreCompact", trigger:t.trigger, custom_instructions:…`.
// The alternates are belt-and-braces against a future rename, since a wrong
// answer here silently mislabels every snapshot.
const trigger = lib.safe(hook.trigger || hook.compaction_reason || hook.compactTrigger || '', 20) || 'unknown';
const isAuto = trigger === 'auto';

const fmt = lib.fmt;

/** Inline-code spans in the snapshot must survive a path containing a backtick. */
const code = (s) => '`' + lib.safe(s, 200).replace(/`/g, '’') + '`';

// ── Recovery snapshot ────────────────────────────────────────

let snapshotPath = null;
try {
  const dir = path.join(lib.dataDir(), 'compactions');
  fs.mkdirSync(dir, { recursive: true });

  // Snapshots are a recovery aid for the compaction that just happened, not an
  // archive. Keep a useful history, discard the rest.
  lib.pruneDir(dir, '.md', 30);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  snapshotPath = path.join(dir, `${stamp}-${lib.sessionKey(hook.session_id)}.md`);

  const L = [];
  L.push('# Pre-compaction snapshot');
  L.push('');
  L.push(`- When: ${new Date().toISOString()}`);
  L.push(`- Trigger: **${trigger}**${isAuto ? ' (unfocused — the summariser chose what survived)' : ' (you chose the focus)'}`);
  L.push(`- Session: ${code(hook.session_id || 'unknown')}`);
  L.push(`- Working dir: ${code(hook.cwd || process.cwd())}`);
  if (r && r.ok) {
    L.push(`- Context at compaction: **${fmt(r.tokens)}** of ${fmt(r.window)} (${r.pctOfWindow}%)`);
    L.push(`- Zone: ${r.verdict.label} (degradation ${r.degradationZone.label}`
      + (r.pressureZone ? ` / pressure ${r.pressureZone.label}` : ' / pressure not applicable') + ')');
    if (r.compactions > 0) {
      L.push(`- Earlier compactions this session: ${r.compactions}`
        + (r.droppedTokens ? ` (~${fmt(r.droppedTokens)} dropped before this one)` : ''));
    }
  } else {
    L.push('- Context at compaction: not readable (no usage record in the transcript)');
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
    if (r.overAttributedEst > 0) {
      L.push(`These are character-derived estimates and they over-attribute by ~${fmt(r.overAttributedEst)}`);
      L.push('against the measured total, so read them as relative sizes only.');
      L.push('');
    }
  }

  if (r && r.ok && r.rereads && r.rereads.length) {
    L.push('## Files read more than once');
    L.push('');
    L.push('These were central enough to revisit. Re-read them first if the summary loses the thread.');
    L.push('');
    for (const x of r.rereads) L.push(`- ${code(x.file)} (${x.count}×)`);
    L.push('');
  }

  if (r && r.ok && r.topConsumers && r.topConsumers.length) {
    L.push('## Largest tool results discarded');
    L.push('');
    for (const c of r.topConsumers) {
      L.push(`- ${fmt(c.tokensEst)} — ${code(c.tool)}${c.target ? ' ' + code(c.target) : ''}`
        + ` (${c.turnsAgo} turns before compaction)`);
    }
    L.push('');
  }

  fs.writeFileSync(snapshotPath, L.join('\n'), 'utf8');
} catch { snapshotPath = null; }

// ── Queue the announcement for the next Stop hook ────────────

const lines = [];
if (isAuto) {
  lines.push('⚠ AUTO-compaction ran — unfocused.');
  lines.push('   The summariser kept what it guessed mattered, not what you would have chosen.');
  if (r && r.ok) lines.push(`   Context was ${fmt(r.tokens)} of ${fmt(r.window)} (${r.pctOfWindow}%).`);
  if (snapshotPath) lines.push(`   Recovery snapshot: ${snapshotPath}`);
  lines.push('   To avoid this next time: /context-setup, then compact deliberately in the ACT zone.');
} else if (snapshotPath) {
  lines.push(`📋 Pre-compaction snapshot written: ${snapshotPath}`);
}

if (lines.length) {
  // Merge rather than overwrite: this must not clobber the zone-crossing
  // bookkeeping stop-nudge.js keeps in the same object. Both files address the
  // state through lib, so they cannot disagree about which file it is — they
  // used to sanitise the session id into a filename separately, and differently.
  const state = lib.readSessionState(hook.session_id) || {};
  state.pending = lib.pendingOf(state).concat([lines.join('\n')]).slice(-4);
  lib.writeSessionState(hook.session_id, state); // best-effort; the snapshot is still on disk
}

process.exit(0);
