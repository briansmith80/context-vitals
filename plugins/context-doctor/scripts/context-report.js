#!/usr/bin/env node
'use strict';
//
// context-report.js — the /context-check data source.
//
// Usage:
//   node context-report.js --session <id>       [--format text|json]
//   node context-report.js --transcript <path>  [--format text|json]
//   node context-report.js                      (falls back to cwd matching)
//   node context-report.js --data-dir <path>    (where config.json lives)
//
// Prints a measured context reading plus an estimated breakdown. Exits 0 even
// when it cannot determine usage, so a caller never has to handle failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../lib/context');
const { report, safe } = lib;

// ── Args ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);

/** Accepts both `--name value` and `--name=value`. */
function arg(name) {
  const flag = '--' + name;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) {
      const v = argv[i + 1];
      // A following flag is not this flag's value.
      return v && !v.startsWith('--') ? v : null;
    }
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1) || null;
  }
  return null;
}

const format = (arg('format') || 'text').toLowerCase();

// CLAUDE_PLUGIN_DATA reaches a plugin skill body by string substitution, not as
// an environment variable in the Bash tool, so the skill passes it through
// explicitly. Without this, the hooks and this report read config from two
// different files. An unsubstituted placeholder is ignored rather than used as a
// literal directory name, which is what happens when the plugin is loaded with
// --plugin-dir instead of installed.
const dataDirArg = arg('data-dir');
if (dataDirArg && !dataDirArg.includes('${')) lib.setDataDir(dataDirArg);

// ── Locate the transcript ────────────────────────────────────
//
// Claude Code stores transcripts under ~/.claude/projects/<slug>/<session>.jsonl
// where <slug> is the cwd with every separator replaced by a dash. Earlier
// versions of this script reconstructed that slug and then, when the guess
// missed, fell back to matching any project directory whose name merely *ended
// with* the current folder's basename. Both were wrong: the reconstruction
// collapsed `C:\` to a single dash so it never matched on Windows, and the
// fallback happily reported an unrelated project's session as though it were
// yours. Nothing is reconstructed now — we match on the session id, or on the
// cwd each transcript records about itself.

function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** The `cwd` a transcript records for itself, from its first entry that has one. */
function recordedCwd(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(32 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e && typeof e === 'object' && e.cwd) return String(e.cwd);
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** Session ids are uuids; anything else is not one, and must not build a path. */
function validSessionId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);
}

function resolveTranscript() {
  const explicit = arg('transcript');
  if (explicit) return { file: explicit, how: 'given with --transcript' };

  const base = projectsDir();
  const dirs = readdirSafe(base);

  // 1. By session id — exact, and independent of any slug convention.
  //    Claude Code exports CLAUDE_CODE_SESSION_ID to the Bash tool, so this is
  //    the path that normally runs.
  const session = arg('session') || process.env.CLAUDE_CODE_SESSION_ID || null;
  if (validSessionId(session)) {
    for (const d of dirs) {
      const p = path.join(base, d, session + '.jsonl');
      if (fs.existsSync(p)) return { file: p, how: 'session ' + session.slice(0, 8) };
    }
  }

  // 2. By the cwd each transcript records about itself — self-validating, so a
  //    basename collision cannot silently select another project.
  const here = path.resolve(process.cwd()).toLowerCase();
  const matches = [];
  for (const d of dirs) {
    for (const f of readdirSafe(path.join(base, d))) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(base, d, f);
      const cwd = recordedCwd(p);
      if (cwd && path.resolve(cwd).toLowerCase() === here) matches.push({ p, m: mtimeOf(p) });
    }
  }
  if (!matches.length) {
    return { file: null, how: null, reason: 'no transcript recorded for this directory' };
  }
  matches.sort((a, b) => b.m - a.m);
  return {
    file: matches[0].p,
    how: matches.length > 1
      ? 'newest of ' + matches.length + ' sessions here — pass --session to pin one'
      : 'only session for this directory',
  };
}

// ── Text measurement ─────────────────────────────────────────
//
// Every column in this report is aligned by arithmetic, and the arithmetic has
// to be done in RENDERED columns, not UTF-16 code units. Zone glyphs are the
// reason: 🟠 is a surrogate pair (String.length 2) that renders 2 columns, but
// ⛔ has String.length 1 and still renders 2 — so a `.length`-based pad puts the
// CRITICAL row one column left of every other row.

function isWide(c) {
  return (c >= 0x1100 && c <= 0x115f)
    || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f)
    || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f)
    || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x1f000 && c <= 0x1f0ff)
    || (c >= 0x1f300 && c <= 0x1faff)   // includes 1F7E0-1F7E2, the zone circles
    || c === 0x231a || c === 0x231b
    || (c >= 0x23e9 && c <= 0x23ec) || c === 0x23f0 || c === 0x23f3
    || (c >= 0x25fd && c <= 0x25fe)
    || (c >= 0x2614 && c <= 0x2615)
    || (c >= 0x2648 && c <= 0x2653)
    || c === 0x267f || c === 0x2693 || c === 0x26a1
    || (c >= 0x26aa && c <= 0x26ab)
    || (c >= 0x26bd && c <= 0x26be)
    || (c >= 0x26c4 && c <= 0x26c5) || c === 0x26ce
    || c === 0x26d4                     // ⛔ CRITICAL — length 1, width 2
    || c === 0x26ea
    || (c >= 0x26f2 && c <= 0x26f3) || c === 0x26f5 || c === 0x26fa || c === 0x26fd
    || c === 0x2705 || (c >= 0x270a && c <= 0x270b) || c === 0x2728
    || c === 0x274c || c === 0x274e
    || (c >= 0x2753 && c <= 0x2755) || c === 0x2757
    || (c >= 0x2795 && c <= 0x2797) || c === 0x27b0 || c === 0x27bf
    || (c >= 0x2b1b && c <= 0x2b1c) || c === 0x2b50 || c === 0x2b55;
}

function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0xfe0f || c === 0x200d) continue; // variation selector, ZWJ
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

/** Left-align to `n` rendered columns. */
function pad(s, n) {
  const w = width(s);
  return w >= n ? String(s) : String(s) + ' '.repeat(n - w);
}

/** Right-align to `n` rendered columns. */
function rpad(s, n) {
  const w = width(s);
  return w >= n ? String(s) : ' '.repeat(n - w) + String(s);
}

/**
 * Truncate to `n` rendered columns. `safe()` caps by String.length, which is
 * the same thing for ASCII and wrong for anything wide — a CJK path would fit
 * its length budget and still overflow the line.
 */
function clip(s, n) {
  const str = String(s);
  if (width(str) <= n) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = width(ch);
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function wrap(text, cols) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (width(line) + 1 + width(word) <= cols) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

// ── Number formatting ────────────────────────────────────────

/** Compact: 1M, 700K, 238K, 368. */
function fmtT(n) {
  const v = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  if (v >= 1000000) return sign + trimZeros((v / 1000000).toFixed(2)) + 'M';
  if (v >= 1000) return sign + Math.round(v / 1000) + 'K';
  return sign + String(v);
}

/** One decimal, for the two numbers the reader is meant to trust: 412.3K. */
function fmtTP(n) {
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (v >= 1000000) return sign + trimZeros((v / 1000000).toFixed(2)) + 'M';
  if (v >= 1000) return sign + (v / 1000).toFixed(1) + 'K';
  return sign + String(Math.round(v));
}

function trimZeros(s) {
  return s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
}

/** A non-zero share that rounds to 0% reads as broken. Say `<1%` instead. */
function fmtPct(part, whole) {
  if (!whole) return '—';
  const p = 100 * part / whole;
  if (p > 0 && p < 0.5) return '<1%';
  if (p < 100 && p > 99.5) return '>99%';
  return Math.round(p) + '%';
}

// ── Glyphs ───────────────────────────────────────────────────

const EIGHTHS = ['\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589'];
const FULL = '\u2588';
const EMPTY = '\u2591';
const TICK_UP = '\u257B';   // ╻ marker hanging below a label, above the axis
const TICK_DOWN = '\u2575'; // ╵ marker rising above a label, below the axis

const W = 72;   // hard maximum rendered width of any line
const IND = 2;
const GIND = 6; // gauge / table indent
const AXIS = 64;

/** Sub-cell-precise bar. `frac` is clamped to [0,1]. */
function bar(frac, cells) {
  const f = Math.max(0, Math.min(1, isFinite(frac) ? frac : 0));
  const exact = f * cells;
  let full = Math.floor(exact);
  let eighth = Math.round((exact - full) * 8);
  if (eighth === 8) { full += 1; eighth = 0; }
  if (full > cells) { full = cells; eighth = 0; }
  const partial = eighth > 0 && full < cells ? EIGHTHS[eighth - 1] : '';
  const used = full + (partial ? 1 : 0);
  return FULL.repeat(full) + partial + EMPTY.repeat(Math.max(0, cells - used));
}

const CATEGORY_LABELS = {
  tool_results: 'tool results',
  tool_calls: 'tool calls',
  assistant_text: 'assistant text',
  thinking: 'thinking',
  user_prompts: 'your prompts',
  attachments: 'attachments',
  overhead: 'baseline & unattributed',
};

/** `mcp__outlook__email_search` is 90% prefix. Keep the part that identifies it. */
function shortTool(name) {
  const s = safe(name, 40);
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(s);
  return m ? m[1] : s;
}

// ── Gauge ────────────────────────────────────────────────────
//
// One axis carrying both ladders: the fill is absolute size, the tick above is
// where auto-compaction fires, the ticks below are the degradation thresholds
// either side of you. Seeing 412K sitting inside ACT while the trigger is still
// out at 667K *is* the argument for a degradation-driven verdict.

function gauge(r) {
  const lines = [];
  const scale = Math.max(r.window, r.tokens, 1);
  const col = (v) => Math.max(0, Math.min(AXIS - 1, Math.round((v / scale) * AXIS)));

  // Above the axis: the auto-compaction trigger.
  if (r.autoCompactFiresAt > 0 && r.autoCompactFiresAt <= scale) {
    const label = (r.firesAtIsUpperBound ? '\u2264' : '') + fmtT(r.autoCompactFiresAt) + ' auto-compact';
    const at = col(r.autoCompactFiresAt);
    let line;
    if (at + 1 + width(label) <= AXIS) {
      line = ' '.repeat(GIND + at) + TICK_UP + label;
    } else {
      // No room to the right — hang the label to the left of the marker.
      const start = Math.max(0, at - width(label));
      line = ' '.repeat(GIND + start) + label + TICK_UP;
    }
    lines.push(line);
  }

  lines.push(' '.repeat(GIND) + bar(r.tokens / scale, AXIS));

  // Below the axis: the threshold you crossed to get here, and the next one.
  const zones = lib.DEGRADATION_ZONES;
  const idx = zones.findIndex((z) => z.key === r.degradationZone.key);
  const marks = [];
  if (idx > 0) {
    const entry = zones[idx - 1].max;
    if (entry > 0 && entry <= scale) marks.push({ v: entry, label: fmtT(entry) + ' ' + zones[idx].label });
  }
  if (idx >= 0 && idx < zones.length - 1) {
    const next = zones[idx].max;
    if (isFinite(next) && next <= scale) marks.push({ v: next, label: fmtT(next) + ' ' + zones[idx + 1].label });
  }

  if (marks.length) {
    let line = '';
    for (const m of marks) {
      const at = GIND + col(m.v);
      if (at + 1 + width(m.label) <= GIND + AXIS) {
        if (at < line.length) continue; // would overlap the previous label
        line += ' '.repeat(at - line.length) + TICK_DOWN + m.label;
      } else {
        // No room to the right of the marker — hang the label to its left
        // rather than dropping the threshold entirely, which is exactly what
        // used to happen in the CRITICAL zone where it matters most.
        const start = at - width(m.label);
        if (start < line.length) continue;
        line += ' '.repeat(start - line.length) + m.label + TICK_DOWN;
      }
    }
    if (line.trim()) lines.push(line);
  }

  return lines;
}

// ── Render ───────────────────────────────────────────────────

function renderText(r, source) {
  const L = [];
  const v = r.verdict;
  const push = (s) => L.push(s === '' ? '' : s);

  // ── Masthead: the measured number, and the word `measured` touching it.
  const readout = fmtTP(r.tokens) + ' / ' + fmtT(r.window) + ' measured \u00B7 '
    + r.pctOfWindow.toFixed(1) + '%';
  const title = 'CONTEXT DOCTOR';
  const gap = Math.max(1, (W - IND) - width(title) - width(readout));
  push(' '.repeat(IND) + title + ' '.repeat(gap) + readout);
  push(' '.repeat(IND) + '\u2550'.repeat(W - IND));
  push('');

  // ── Verdict: the label, and which of the two ladders bound it.
  const because = r.pressureZone === null
    ? 'no runway reading available'
    : r.zonesAgree
      ? 'both readings agree'
      : v.driver === 'degradation'
        ? 'absolute size binds, not runway'
        : 'runway binds, not absolute size';
  push(' '.repeat(IND) + v.emoji + '  ' + v.label + ' \u2014 ' + because + '.');
  for (const line of wrap(v.headline, W - GIND)) push(' '.repeat(GIND) + line);
  push('');

  for (const line of gauge(r)) push(line);
  push('');

  // ── Vitals: the two ladders side by side, with the binding one marked.
  const rows = [
    {
      bind: v.driver === 'degradation' && !r.zonesAgree,
      label: 'absolute size',
      reading: fmtTP(r.tokens),
      normal: 'under ' + fmtT(lib.DEGRADATION_ZONES[0].max),
      zone: r.degradationZone,
    },
  ];
  if (r.pressureZone) {
    rows.push({
      bind: v.driver === 'pressure' && !r.zonesAgree,
      label: 'window pressure',
      // firesAt is an upper bound when the trigger is unconfigured, so the
      // fraction of it is a LOWER bound. Say so in the value, not a footnote.
      reading: (r.firesAtIsUpperBound ? '\u2265' : '') + r.pctOfAutoCompact + '%',
      normal: 'under ' + Math.round(lib.PRESSURE_ZONES[0].max * 100) + '%',
      zone: r.pressureZone,
    });
  }

  const wLabel = Math.max(width('VITALS'), ...rows.map((x) => width(x.label)));
  const wRead = Math.max(width('READING'), ...rows.map((x) => width(x.reading)));
  const wNorm = Math.max(width('NORMAL'), ...rows.map((x) => width(x.normal)));
  const wZone = Math.max(width('ZONE'), ...rows.map((x) => width(x.zone.label)));

  push(' '.repeat(GIND) + pad('VITALS', wLabel + 2) + rpad('READING', wRead)
    + '  ' + pad('NORMAL', wNorm + 2) + 'ZONE');
  for (const x of rows) {
    push(' '.repeat(GIND - 2) + (x.bind ? '> ' : '  ')
      + pad(x.label, wLabel + 2) + rpad(x.reading, wRead)
      + '  ' + pad(x.normal, wNorm + 2) + pad(x.zone.label, wZone) + ' ' + x.zone.emoji);
  }

  // ── Evidence
  push('');
  const head = ' '.repeat(IND) + '\u2500\u2500 EVIDENCE ';
  push(head + '\u2500'.repeat(Math.max(0, W - width(head))));
  push('');

  section(push, 'COMPOSITION', r.breakdown && r.breakdown.length
    ? 'estimated from characters \u00B7 not measured'
    : 'not available \u2014 no per-category read');

  if (r.breakdown && r.breakdown.length) {
    const comp = r.breakdown.map((b) => ({ label: CATEGORY_LABELS[b.category] || b.category, t: b.tokensEst }));
    if (r.overheadEst > 0) comp.push({ label: CATEGORY_LABELS.overhead, t: r.overheadEst });
    comp.sort((a, b) => b.t - a.t);

    // Percentages are a share of what is displayed, so they always sum to 100.
    // When the char estimate over-attributes, that total exceeds the measured
    // figure — which is a fact about the estimate, stated below, not a licence
    // to print a bar past full.
    const denom = comp.reduce((s, x) => s + x.t, 0) || 1;
    const wCat = Math.max(...comp.map((x) => width(x.label)));
    const wTok = Math.max(...comp.map((x) => width(fmtT(x.t))));
    const cells = Math.max(10, (W - 8) - wCat - 2 - wTok - 2 - 5);
    for (const x of comp) {
      push('        ' + pad(x.label, wCat + 2) + rpad(fmtT(x.t), wTok) + '  '
        + bar(x.t / denom, cells) + ' ' + rpad(fmtPct(x.t, denom), 4));
    }
    if (r.overheadEst > 0) {
      push('        baseline = system prompt, tool schemas, CLAUDE.md, memory');
    }
    if (r.overAttributedEst > 0) {
      for (const line of wrap('the character estimate over-attributes by ~'
        + fmtT(r.overAttributedEst) + ' against the measured total, so treat these as '
        + 'relative sizes only', W - 8)) push('        ' + line);
    }
  }

  if (r.topConsumers && r.topConsumers.length) {
    push('');
    section(push, 'LARGEST TOOL RESULTS', 'prune the oldest first \u2014 safest cut');
    const shown = r.topConsumers.slice(0, 6);
    const wTok = Math.max(...shown.map((c) => width(fmtT(c.tokensEst))));
    const agos = shown.map((c) => c.turnsAgo + ' turn' + (c.turnsAgo === 1 ? '' : 's') + ' ago');
    const wAgo = Math.max(...agos.map(width));
    // A Read/Bash/Grep session gets a 4-wide tool column and spends the rest on
    // the path; an MCP session gets 12 and renders `browser_take…` rather than
    // the useless shared `mcp__pla…` prefix.
    const wTool = Math.min(12, Math.max(4, ...shown.map((c) => width(shortTool(c.tool)))));
    const room = Math.max(6, (W - 8) - wTok - 2 - wTool - 1 - 2 - wAgo);
    shown.forEach((c, i) => {
      push('        ' + rpad(fmtT(c.tokensEst), wTok) + '  '
        + pad(clip(shortTool(c.tool), wTool), wTool) + ' '
        + pad(clip(c.target, room), room) + '  ' + rpad(agos[i], wAgo));
    });
    const hidden = (r.consumerCount || 0) - shown.length;
    if (hidden > 0) {
      push('        ' + hidden + ' smaller not shown \u00B7 --format json has all');
    }
  }

  if (r.rereads && r.rereads.length) {
    push('');
    section(push, 'RE-READ FILES', 'near-duplicate versions compete');
    for (const x of r.rereads.slice(0, 6)) {
      push('        ' + rpad(x.count + '\u00D7', 3) + '  ' + clip(x.file, W - 13));
    }
  }

  // ── Method: provenance. Every number above is only as good as these.
  push('');
  section(push, 'METHOD', 'window, trigger, compaction history');

  const method = [];
  method.push(['window', fmtT(r.window), r.windowSource]);
  method.push(['auto-compact', fmtT(r.autoCompactWindow), r.autoCompactSource]);

  const until = r.tokensUntilAutoCompact;
  if (r.autoCompactFiresAt > 0) {
    const at = (r.firesAtIsUpperBound ? '\u2264' : '') + fmtT(r.autoCompactFiresAt);
    const note = until > 0
      ? (r.firesAtIsUpperBound
        ? 'at most ~' + fmtT(until) + ' of runway \u2014 the real trigger is lower'
        : '~' + fmtT(until) + ' of runway left')
      : 'imminent or passed \u2014 ~' + fmtT(-until) + ' over';
    method.push(['fires at', at, note]);
  } else {
    method.push(['fires at', '\u2014', 'window at or below the ' + fmtT(lib.AUTOCOMPACT_HEADROOM)
      + ' summarisation headroom, so no runway reading']);
  }

  if (r.compactions > 0) {
    method.push(['compactions', String(r.compactions),
      (r.lastCompactTrigger ? 'last was ' + safe(r.lastCompactTrigger, 20) : 'trigger unrecorded')
      + (r.droppedTokens ? ' \u00B7 ~' + fmtT(r.droppedTokens) + ' already dropped' : '')
      + ' \u00B7 everything above covers the post-compaction context only']);
  }
  if (r.measuredFrom && r.measuredFrom !== 'live assistant turn') {
    method.push(['measured from', '', r.measuredFrom
      + ' \u2014 no assistant turn since the boundary yet']);
  }
  if (source && source.how) method.push(['transcript', '', safe(source.how, 60)]);

  const wKey = Math.max(...method.map((m) => width(m[0])));
  const wVal = Math.max(...method.map((m) => width(m[1])));
  for (const [k, val, note] of method) {
    const prefix = '        ' + pad(k, wKey + 1) + pad(val, wVal + (wVal ? 2 : 0));
    const noteCols = W - width(prefix);
    const wrapped = wrap(note, noteCols);
    push(prefix + (wrapped[0] || ''));
    for (const cont of wrapped.slice(1)) push(' '.repeat(width(prefix)) + cont);
  }

  push('');
  // Trailing whitespace is invisible in a terminal but survives into the code
  // fence the skill reproduces, where it reads as sloppiness in a tool whose
  // whole claim is precision.
  return L.map((s) => s.replace(/[ \t]+$/, '')).join('\n');
}

function section(push, title, caption) {
  push(' '.repeat(GIND) + pad(title, Math.max(22, width(title) + 2)) + caption);
}

// ── Main ─────────────────────────────────────────────────────

let r;
let source = null;
try {
  source = resolveTranscript();
  if (!source.file) {
    r = { ok: false, reason: source.reason || 'could not locate a transcript' };
  } else {
    r = report(source.file, { deep: true });
    if (r.ok) {
      r.transcript = source.file;
      r.transcriptHow = source.how;
    }
  }
} catch (err) {
  r = { ok: false, reason: String((err && err.message) || err) };
}

if (format === 'json') {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
} else if (!r.ok) {
  const msg = ['', '  CONTEXT DOCTOR \u2014 no reading available'];
  for (const line of wrap(r.reason, W - 4)) msg.push('  ' + line);
  msg.push('');
  for (const line of wrap('Run /context for Claude Code\u2019s own built-in breakdown.', W - 4)) {
    msg.push('  ' + line);
  }
  msg.push('', '');
  process.stdout.write(msg.join('\n'));
} else {
  process.stdout.write(renderText(r, source) + '\n');
}
process.exit(0);
