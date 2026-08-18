#!/usr/bin/env node
'use strict';
//
// stop-nudge.js — Stop hook. Fires when Claude finishes a turn.
//
// Emits a one-line warning ONLY when the session crosses into a worse zone
// than it has already been warned about. Per-session state lives in the
// plugin data dir, so a long session gets at most four nudges, ever.
//
// This runs on every single turn, so it must be fast and it must never fail
// loudly: it reads only the tail of the transcript and always exits 0.

const fs = require('fs');
const path = require('path');

function silent() { process.exit(0); }

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch { silent(); }

let hook;
try { hook = JSON.parse(raw); } catch { silent(); }

// Subagents have their own context windows; nudging about them is noise.
if (hook.agent_id) silent();

let lib;
try { lib = require('../lib/context'); } catch { silent(); }

const cfg = lib.readPluginConfig();
if (cfg.quiet === true) silent();

let r;
try {
  r = lib.report(hook.transcript_path, { deep: false });
} catch { silent(); }
if (!r || !r.ok) silent();

// ── Zone-crossing state ──────────────────────────────────────

const sessionsDir = path.join(lib.dataDir(), 'sessions');
const stateFile = path.join(sessionsDir, `${hook.session_id || 'unknown'}.json`);

let state = null;
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first turn of this session */ }

// First turn of a session is the one cheap moment to do housekeeping: these
// files accumulate one per session forever otherwise.
if (state === null) lib.pruneDir(sessionsDir, '.json', 50);
if (state === null) state = {};

const current = lib.SEVERITY[r.verdict.key];

// Compaction shrinks the context; reset so a later re-entry warns again.
if (r.tokens < (state.lastTokens || 0) * 0.6) {
  state.warnedSeverity = -1;
}

const warned = typeof state.warnedSeverity === 'number' ? state.warnedSeverity : -1;

function persist(sev) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      warnedSeverity: sev,
      lastTokens: r.tokens,
      lastZone: r.verdict.key,
    }));
  } catch { /* state is best-effort */ }
}

// Nothing worth saying: still green, or already warned at this level or worse.
if (current <= 0 || current <= warned) {
  persist(warned);
  process.exit(0);
}

persist(current);

// ── Build the nudge ──────────────────────────────────────────

const fmt = (n) => {
  const v = Math.abs(n);
  if (v >= 1000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (v >= 1000) return Math.round(n / 1000) + 'K';
  return String(Math.round(n));
};

const ACTION = {
  watch: '/clear if you are between tasks. Otherwise carry on.',
  act: 'Compact deliberately now: /compact focus on <what matters>. Run /context-check for a drafted focus line.',
  degraded: '/clear and rebuild from notes if the task allows. Compaction here is salvage, not maintenance.',
  critical: 'Auto-compaction will summarise on its guess, not yours. Act now: /context-check.',
};

// Show the measure that actually drove the verdict. Quoting % of a 1M window
// next to a CRITICAL label reads as a contradiction when the binding
// constraint is a much smaller auto-compact window.
const until = r.tokensUntilAutoCompact;
const headline = r.verdict.driver === 'pressure'
  ? `${r.verdict.emoji} Context ${fmt(r.tokens)} — ${r.verdict.label} · ` +
    (until > 0
      ? `~${fmt(until)} before auto-compaction (${r.pctOfAutoCompact}% of the way)`
      : `auto-compaction imminent (${fmt(r.autoCompactFiresAt)} threshold passed)`)
  : `${r.verdict.emoji} Context ${fmt(r.tokens)}/${fmt(r.window)} (${r.pctOfWindow}%) — ${r.verdict.label}`;

const lines = [
  headline,
  `   ${r.verdict.headline}`,
  `   → ${ACTION[r.verdict.key] || 'Run /context-check.'}`,
];

process.stdout.write(JSON.stringify({
  systemMessage: lines.join('\n'),
  suppressOutput: true,
}));
process.exit(0);
