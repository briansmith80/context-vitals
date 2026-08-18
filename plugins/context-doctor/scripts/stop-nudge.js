#!/usr/bin/env node
'use strict';
//
// stop-nudge.js — Stop hook. Fires when Claude finishes a turn.
//
// Emits a one-line warning ONLY when the session crosses into a worse zone
// than it has already been warned about. Per-session state lives in the
// plugin data dir, so one climb through the zones costs at most four nudges.
//
// It is also the plugin's only user-facing channel. Claude Code discards a
// PreCompact hook's systemMessage, so pre-compact.js cannot speak for itself;
// it leaves its announcement in the session state file and this hook delivers
// it on the next turn.
//
// This runs on every single turn, so it must be fast and it must never fail
// loudly: it reads only the tail of the transcript and always exits 0.

const fs = require('fs');

function silent() { process.exit(0); }

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch { silent(); }

let hook;
try { hook = JSON.parse(raw); } catch { silent(); }
// JSON.parse('null') succeeds, and `null.agent_id` throws — which surfaced as a
// stack trace on every turn rather than the silent exit this file promises.
if (!hook || typeof hook !== 'object' || Array.isArray(hook)) silent();

// Subagents have their own context windows; nudging about them is noise.
if (hook.agent_id) silent();

let lib;
try { lib = require('../lib/context'); } catch { silent(); }

const cfg = lib.readPluginConfig();

// ── Session state ────────────────────────────────────────────
//
// The file layout, the key sanitising and the pending queue all live in
// lib/context.js, because pre-compact.js writes into the same file and the two
// have to agree on which file that is.

let state = lib.readSessionState(hook.session_id);

const firstTurn = state === null;
// First turn of a session is the one cheap moment to do housekeeping: these
// files accumulate one per session forever otherwise.
if (firstTurn) lib.pruneDir(lib.sessionsDir(), '.json', 50);
if (firstTurn) state = {};

// A compaction announcement left behind by pre-compact.js, which has no channel
// of its own. Delivered even when `quiet` silences the zone nudges: the user
// asked for less noise about context size, not to be kept unaware that an
// unfocused compaction discarded their context.
const pending = lib.pendingOf(state);

function persist(extra) {
  lib.writeSessionState(hook.session_id, Object.assign({
    warnedSeverity: state.warnedSeverity,
    lastTokens: state.lastTokens,
    lastZone: state.lastZone,
    pending: [],
  }, extra));
}

function emit(lines) {
  if (!lines.length) return;
  process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
}

// ── Reading ──────────────────────────────────────────────────

let r;
try {
  r = lib.report(hook.transcript_path, { deep: false });
} catch { r = null; }

if (!r || !r.ok) {
  // Still hand over anything pre-compact.js left, then clear it.
  if (pending.length) { persist({}); emit(pending); }
  process.exit(0);
}

const fmt = lib.fmt;

const current = lib.SEVERITY[r.verdict.key];

// Compaction shrinks the context; reset so a later re-entry warns again.
if (r.tokens < (state.lastTokens || 0) * 0.6) state.warnedSeverity = -1;

const warned = typeof state.warnedSeverity === 'number' ? state.warnedSeverity : -1;
const quiet = cfg.quiet === true;

// A floor for the nudges, so "only tell me at ACT and above" is expressible
// without going fully silent.
const minKey = typeof cfg.minZone === 'string' ? cfg.minZone.toLowerCase() : null;
const floor = Object.prototype.hasOwnProperty.call(lib.SEVERITY, minKey) ? lib.SEVERITY[minKey] : 1;

const shouldNudge = !quiet && current >= floor && current > warned;

state.lastTokens = r.tokens;
state.lastZone = r.verdict.key;
persist({
  warnedSeverity: shouldNudge ? current : warned,
  lastTokens: r.tokens,
  lastZone: r.verdict.key,
});

if (!shouldNudge) {
  emit(pending);
  process.exit(0);
}

// ── Build the nudge ──────────────────────────────────────────

// Advice has to match the ladder that actually bound the verdict. The
// degradation ladder is about quality at an absolute size; the pressure ladder
// is about losing the choice of what survives. "Rebuild from notes" is right
// for the first and wrong for the second.
const ACTION_DEGRADATION = {
  watch: '/clear if you are between tasks. Otherwise carry on.',
  act: 'Compact deliberately now: /compact focus on <what matters>. Run /context-check for a drafted focus line.',
  degraded: '/clear and rebuild from notes if the task allows. Compaction here is salvage, not maintenance.',
  critical: 'Past every published measurement. /clear and rebuild from notes — run /context-check first if you need the open threads.',
};

const ACTION_PRESSURE = {
  watch: 'Over halfway to auto-compaction. Nothing to do yet.',
  act: 'Compact deliberately now, while the choice of what survives is still yours: /compact focus on <what matters>. /context-check drafts it.',
  degraded: 'Auto-compaction is imminent. Compact with a focus now, or it will summarise on its guess instead of yours.',
  critical: 'Auto-compaction will summarise on its guess, not yours. Act now: /context-check.',
};

const action = (r.verdict.driver === 'pressure' ? ACTION_PRESSURE : ACTION_DEGRADATION)[r.verdict.key];

// The name goes in the message because it cannot go in the prefix: Claude Code
// labels hook output by event, so this surfaces as "Stop says: ...", and no
// documented field in hooks.json or the hook's own output changes that. A user
// with several Stop hooks otherwise has no way to tell whose message this is.
// Show the measure that actually drove the verdict. Quoting % of a 1M window
// next to a CRITICAL label reads as a contradiction when the binding
// constraint is a much smaller auto-compact window.
const until = r.tokensUntilAutoCompact;
let headline;
if (r.verdict.driver === 'pressure') {
  const runway = until > 0
    // firesAt is an upper bound when no trigger is configured, so the runway is
    // "at most" this — context-report.js says so and this used to state it flat.
    ? (r.firesAtIsUpperBound
      ? `at most ~${fmt(until)} before auto-compaction`
      : `~${fmt(until)} before auto-compaction (${r.pctOfAutoCompact}% of the way)`)
    : `auto-compaction imminent (${fmt(r.autoCompactFiresAt)} threshold passed)`;
  headline = `${r.verdict.emoji} Context Doctor · ${fmt(r.tokens)} — ${r.verdict.label} · ${runway}`;
} else {
  headline = `${r.verdict.emoji} Context Doctor · ${fmt(r.tokens)}/${fmt(r.window)} (${r.pctOfWindow}%) — ${r.verdict.label}`;
}

emit(pending.concat([
  headline,
  `   ${r.verdict.headline}`,
  `   → ${action || 'Run /context-check.'}`,
]));
process.exit(0);
