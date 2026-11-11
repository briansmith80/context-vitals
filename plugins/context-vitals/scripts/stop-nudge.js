#!/usr/bin/env node
'use strict';
//
// stop-nudge.js — Stop hook. Fires when Claude finishes a turn.
//
// Emits a one-line warning ONLY when the session crosses into a worse zone
// than it has already been warned about. Per-session state lives in the
// plugin data dir, so one climb through the zones costs at most four nudges.
//
// Two gentler prompts sit beside the zones, each given at most once a session:
// an early "between tasks? /clear" well below the first zone, and a tip that
// Opus is being spent on execution. Never more than one message a turn: a zone
// nudge outranks the early one, which outranks the tip, and the loser waits.
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
  return lib.writeSessionState(hook.session_id, Object.assign({
    warnedSeverity: state.warnedSeverity,
    lastTokens: state.lastTokens,
    lastZone: state.lastZone,
    // Carried on every write, including the no-reading one below: this object
    // replaces the file, so a flag left out here is a nudge given twice.
    earlyNudged: state.earlyNudged === true,
    modelTipped: state.modelTipped === true,
    pending: [],
  }, extra));
}

function emit(lines) {
  if (!lines.length) return;
  process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
}

const quiet = cfg.quiet === true;

// Whether the model tip is still owed. Settled before the reading so the tool
// tally is only taken while it can still matter: after the tip has been given,
// or with it switched off, the hook does exactly the work it did before.
// Plan mode is where Opus is meant to be, so nothing is said there.
const tipWanted = !quiet && lib.modelTipOn(cfg) && state.modelTipped !== true
  && hook.permission_mode !== 'plan';

// ── Reading ──────────────────────────────────────────────────

let r;
try {
  r = lib.report(hook.transcript_path, { deep: false, activity: tipWanted });
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

// A floor for the nudges, so "only tell me at ACT and above" is expressible
// without going fully silent.
const minKey = typeof cfg.minZone === 'string' ? cfg.minZone.toLowerCase() : null;
const floor = Object.prototype.hasOwnProperty.call(lib.SEVERITY, minKey) ? lib.SEVERITY[minKey] : 1;

const shouldNudge = !quiet && current >= floor && current > warned;

// The early nudge speaks only while the verdict is still OPTIMAL, so it can
// never contradict or double up a zone nudge. A raised `minZone` silences it
// too: someone who asked to hear nothing below ACT did not ask for a prompt
// below WATCH. A zone nudge spends it, because every zone's advice is stronger
// than "between tasks?" and a gentler line after a compaction would be noise.
const earlyAt = lib.earlyNudgeAt(cfg);
const shouldEarly = !shouldNudge && !quiet && floor <= lib.SEVERITY.watch
  && earlyAt !== null && state.earlyNudged !== true
  && current === lib.SEVERITY.optimal && r.tokens >= earlyAt;

const activity = r.activity;
const shouldTip = !shouldNudge && !shouldEarly && tipWanted
  && !!activity && /opus/i.test(String(activity.model || ''))
  && lib.isMostlyExecution(activity);

state.lastTokens = r.tokens;
state.lastZone = r.verdict.key;
const saved = persist({
  warnedSeverity: shouldNudge ? current : warned,
  lastTokens: r.tokens,
  lastZone: r.verdict.key,
  earlyNudged: state.earlyNudged === true || shouldNudge || shouldEarly,
  modelTipped: state.modelTipped === true || shouldTip,
});

// Once a session is a promise, and the state file is the only thing keeping it.
// If the write failed, the flag is not there next turn and the same line would
// come back on every turn after it, so these two say nothing unless it landed.
// The zone nudges keep their older trade: a lost write costs one extra warning.
if (shouldEarly && saved) {
  emit(pending.concat([
    `${r.verdict.emoji} Context Vitals · ${fmt(r.tokens)} in context · ${r.verdict.label}, past the ${fmt(earlyAt)} early mark`,
    '   → Between tasks? /clear. Mid-task, carry on.',
  ]));
  process.exit(0);
}

if (shouldTip && saved) {
  // Only counts reach the message. The model id is transcript text and is
  // matched, never printed: "Opus" here is this file's word, not the file's.
  emit(pending.concat([
    '\u{1F4A1} Context Vitals · model tip',
    `   ${activity.edits + activity.shell} of the last ${activity.calls} tool calls on Opus were edits or shell commands.`,
    '   → Plan done? Try /model opusplan, or /model sonnet.',
  ]));
  process.exit(0);
}

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
  headline = `${r.verdict.emoji} Context Vitals · ${fmt(r.tokens)} — ${r.verdict.label} · ${runway}`;
} else {
  headline = `${r.verdict.emoji} Context Vitals · ${fmt(r.tokens)}/${fmt(r.window)} (${r.pctOfWindow}%) — ${r.verdict.label}`;
}

emit(pending.concat([
  headline,
  `   ${r.verdict.headline}`,
  `   → ${action || 'Run /context-check.'}`,
]));
process.exit(0);
