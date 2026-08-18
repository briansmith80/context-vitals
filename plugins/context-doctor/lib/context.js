'use strict';
//
// context.js — shared core for the context-doctor plugin.
//
// Claude Code hooks receive `transcript_path` but NOT token usage, so we
// recover the live context size from the transcript itself: the last
// main-chain assistant message records the exact usage of the request that
// produced it, and input_tokens + cache_creation + cache_read is precisely
// what was sent to the model on that turn.
//
// Everything here is defensive. A throw in a Stop hook would surface as noise
// on every single turn, so callers wrap and exit 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Constants ────────────────────────────────────────────────

// Rough chars-per-token for the estimated breakdown. Real tokenisation varies
// (code is denser than prose); this is only used for *relative* category
// sizing, never for the headline number, which is measured.
const CHARS_PER_TOKEN = 4;

// Claude Code triggers auto-compaction some way below the configured window,
// to leave room for the summarisation request itself. This value is an
// approximation observed in practice, not a documented constant — it only
// affects the "tokens until auto-compact" figure, never the zone verdict.
//
// It is a reasonable model of an EXPLICITLY configured window. With no window
// configured, Claude Code picks a model-tuned trigger point that is lower than
// this, and undiscoverable from a hook — so `firesAtIsUpperBound` is set and
// the report says so rather than implying a precision it does not have.
const AUTOCOMPACT_HEADROOM = 33000;

// The Stop hook reads only this much of the transcript tail, on every turn.
const TAIL_BYTES = 512 * 1024;

// Hard ceiling on the escalated tail read. One transcript line can exceed
// TAIL_BYTES (a single enormous tool result), which would otherwise leave the
// per-turn Stop hook slurping an unbounded file. Escalate, but bounded.
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

// Degradation zones, in ABSOLUTE tokens. Attention dilution is a function of
// how many tokens are in the window, not what fraction of the window they
// occupy — so these thresholds do not scale with window size.
const DEGRADATION_ZONES = [
  { key: 'optimal',  max: 150000,   emoji: '\u{1F7E2}', label: 'OPTIMAL',  headline: 'Precision intact. Work freely.' },
  { key: 'watch',    max: 350000,   emoji: '\u{1F7E1}', label: 'WATCH',    headline: 'Positional bias and distractor effects are measurable. Fine for breadth, unreliable for needle-precision.' },
  { key: 'act',      max: 600000,   emoji: '\u{1F7E0}', label: 'ACT',      headline: 'Attention meaningfully diluted. Expect missed details, re-reads, drift from earlier instructions.' },
  { key: 'degraded', max: 850000,   emoji: '\u{1F534}', label: 'DEGRADED', headline: 'Past every published effective-context measurement. Increased abstention, weaker instruction-following.' },
  { key: 'critical', max: Infinity, emoji: '\u{26D4}',  label: 'CRITICAL', headline: 'Deep into territory no benchmark covers.' },
];

// Pressure zones, as a fraction of the EFFECTIVE window (the point at which
// auto-compaction will actually fire). Purely mechanical: how close you are to
// losing the choice of what gets summarised away.
const PRESSURE_ZONES = [
  { key: 'optimal',  max: 0.50,     emoji: '\u{1F7E2}', label: 'OPTIMAL',  headline: 'Plenty of room before auto-compaction.' },
  { key: 'watch',    max: 0.75,     emoji: '\u{1F7E1}', label: 'WATCH',    headline: 'Over halfway to auto-compaction.' },
  { key: 'act',      max: 0.90,     emoji: '\u{1F7E0}', label: 'ACT',      headline: 'Auto-compaction is close. Compact deliberately now, while you still choose what survives.' },
  { key: 'degraded', max: 1.00,     emoji: '\u{1F534}', label: 'DEGRADED', headline: 'Auto-compaction is imminent.' },
  { key: 'critical', max: Infinity, emoji: '\u{26D4}',  label: 'CRITICAL', headline: 'At or past the auto-compaction point. The choice of what survives is no longer yours.' },
];

const SEVERITY = { optimal: 0, watch: 1, act: 2, degraded: 3, critical: 4 };

// ── Small helpers ────────────────────────────────────────────

// C0 and C1 control characters, minus tab/newline/carriage-return which the
// whitespace collapse below handles. ESC (0x1B) is the one that matters: an
// escape sequence surviving into the report would let transcript content repaint
// the terminal or forge report rows, and the skill instructs the model to relay
// that output verbatim.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Make a transcript-derived string safe to print in the report, to embed in a
 * markdown snapshot, and to relay verbatim inside a fenced code block.
 *
 * Substitutions are length-neutral so column arithmetic done on the result
 * stays correct. Backticks become U+2019 because the report is reproduced
 * inside a ``` fence: a tool input containing three backticks would otherwise
 * close the fence and spill the rest of the report into the conversation as
 * prose (and, with a crafted payload, as instructions).
 */
function safe(value, maxLen) {
  if (value == null) return '';
  let s = String(value)
    .replace(CONTROL_CHARS, ' ')
    .replace(/`/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = typeof maxLen === 'number' ? maxLen : 120;
  if (s.length > cap) s = s.slice(0, Math.max(0, cap - 1)) + '…';
  return s;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** JSON.parse('null') succeeds — callers want an object or nothing. */
function readJsonObject(file) {
  const v = readJson(file);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** Read at most `bytes` from the end of a file, dropping the leading partial line. */
function readTail(file, bytes) {
  let size;
  try { size = fs.statSync(file).size; } catch { return ''; }
  if (size <= bytes) {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    // No newline in the window means one transcript line is longer than the
    // window. Returning '' here would report "no usage data" precisely when the
    // context is largest; the caller escalates instead.
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Read the tail, growing the window until it contains a whole line or we hit
 * MAX_TAIL_BYTES. Bounded so a pathological transcript cannot turn the
 * per-turn Stop hook into a full-file read.
 */
function readTailEscalating(file, bytes) {
  let want = bytes;
  for (;;) {
    const text = readTail(file, want);
    if (text) return text;
    if (want >= MAX_TAIL_BYTES) return '';
    want = Math.min(want * 8, MAX_TAIL_BYTES);
  }
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; /* truncated/partial line */ }
    // Guard the whole pipeline: every consumer does `e.type`, and a bare
    // `null` or a number is valid JSON on its own line.
    if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e);
  }
  return out;
}

/**
 * Parse a window size in any form Claude Code accepts:
 * 400000, "400000", "400k", "1M", or a bare 100-1000 meaning thousands.
 */
function parseWindow(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!isFinite(value) || value <= 0) return null;
    return value >= 100 && value <= 1000 ? Math.round(value * 1000) : Math.round(value);
  }
  const s = String(value).trim().toLowerCase();
  if (!s || s === 'auto') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  if (m[2] === 'k') return Math.round(n * 1000);
  if (m[2] === 'm') return Math.round(n * 1000000);
  return n >= 100 && n <= 1000 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Where the plugin keeps config and state.
 *
 * CLAUDE_PLUGIN_DATA is exported to hook subprocesses but NOT to the Bash tool,
 * so `/context-check` has to be told the path explicitly — `setDataDir` lets
 * context-report.js pass through the value the skill body substitutes. Without
 * that, the hooks and the report would read config from two different files.
 */
let dataDirOverride = null;

function setDataDir(dir) {
  dataDirOverride = dir && String(dir).trim() ? String(dir).trim() : null;
}

function dataDir() {
  if (dataDirOverride) return dataDirOverride;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), '.claude', 'context-doctor');
}

function readPluginConfig() {
  return readJsonObject(path.join(dataDir(), 'config.json')) || {};
}

function userSettings() {
  return readJsonObject(path.join(os.homedir(), '.claude', 'settings.json')) || {};
}

/**
 * Keep the newest `keep` files matching `ext` in `dir`, delete the rest.
 *
 * Both of the plugin's own data directories otherwise grow without bound — one
 * state file per session, one snapshot per compaction, forever. Best-effort:
 * a housekeeping failure must never surface to the user.
 */
function pruneDir(dir, ext, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => {
        const p = path.join(dir, f);
        try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m);

    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(f.p); } catch { /* raced or locked */ }
    }
    return Math.max(0, files.length - keep);
  } catch {
    return 0; // directory absent — nothing to prune
  }
}

// ── Window detection ─────────────────────────────────────────

/**
 * Claude Code tells the statusline its context window size, but tells hooks
 * nothing, so we infer it. Order: explicit config > env > model string.
 * A sanity floor at the end corrects any under-estimate against observed usage.
 *
 * `confident` distinguishes a window we were told from one we guessed. The bare
 * 200K model default is a guess: a 1M-variant session whose transcript does not
 * carry the `[1m]` suffix lands there, and treating that guess as fact used to
 * produce a CRITICAL pressure verdict at 180K that flipped to WATCH one token
 * later, when the observed-usage floor fired.
 */
function detectWindow(modelId, observedTokens) {
  const cfg = readPluginConfig();

  const fromConfig = parseWindow(cfg.contextWindow);
  if (fromConfig) return { window: fromConfig, source: 'context-doctor config.json', confident: true };

  const fromEnv = parseWindow(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  if (fromEnv) return { window: fromEnv, source: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', confident: true };

  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') {
    return { window: 200000, source: 'CLAUDE_CODE_DISABLE_1M_CONTEXT=1', confident: true };
  }

  // The transcript records the base model id ("claude-opus-5") without the
  // [1m] variant suffix, so also consult the configured model in settings.
  const settingsModel = String(userSettings().model || '');
  const combined = (String(modelId || '') + ' ' + settingsModel).toLowerCase();

  let win = 200000;
  let source = 'model default (200K)';
  let confident = false;
  if (combined.includes('[1m]')) {
    win = 1000000; source = 'model variant [1m]'; confident = true;
  } else if (/sonnet-5|sonnet5|fable-5|fable5/.test(combined)) {
    win = 1000000; source = 'model with native 1M window'; confident = true;
  }

  // Self-correcting floor: if we have already used more than the inferred
  // window, the inference was wrong. Trust the measurement.
  if (observedTokens && observedTokens > win) {
    return { window: 1000000, source: 'inferred from observed usage (exceeded 200K)', confident: true };
  }
  return { window: win, source, confident };
}

/**
 * The auto-compact window: env > user settings > model window.
 * The --autocompact CLI flag is invisible to hooks and cannot be detected.
 *
 * `configured` distinguishes a window we actually know from the fallback. When
 * unset, Claude Code chooses its own model-tuned trigger below the model limit,
 * so the derived "fires in" figure is an upper bound, not an estimate.
 */
function detectAutoCompactWindow(modelWindow, windowConfident) {
  // Clamp an explicit setting to the model window only when we actually KNOW
  // the model window. Clamping a configured 400K down to a *guessed* 200K and
  // then reporting the result as "autoCompactWindow in settings.json" is wrong
  // in both halves: the number is not what the user set, and the attribution
  // says it is.
  const resolve = (n, src) => {
    if (windowConfident !== false && n > modelWindow) {
      return { window: modelWindow, source: src + ', clamped to the detected window', configured: true };
    }
    return { window: n, source: src, configured: true };
  };

  const fromEnv = parseWindow(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (fromEnv) return resolve(fromEnv, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW');

  const fromSettings = parseWindow(userSettings().autoCompactWindow);
  if (fromSettings) return resolve(fromSettings, 'autoCompactWindow in ~/.claude/settings.json');

  return { window: modelWindow, source: 'unset — Claude Code picks its own trigger below the model limit', configured: false };
}

// ── Transcript analysis ──────────────────────────────────────

function usageTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

/** Find the most recent main-chain assistant usage record. Cheap path. */
function findLatestUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const u = e.message && e.message.usage;
    const t = usageTokens(u);
    if (t > 0) return { tokens: t, output: (u.output_tokens || 0), model: e.message.model || null };
  }
  return null;
}

/** Last model id seen on any main-chain assistant entry, for window detection. */
function findLatestModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const m = e.message && e.message.model;
    if (m) return m;
  }
  return null;
}

/**
 * The subset of a transcript that is still in the model's context.
 *
 * A compaction does not truncate the transcript file. Claude Code appends a
 * `compact_boundary` system entry and carries on writing to the same file, so a
 * naive walk counts every tool result the compaction just discarded against a
 * measured total that no longer includes them — category percentages exceed
 * 100%, the residual clamps to zero, and the "prune candidates" list names
 * results that are already gone. That is worst exactly when someone is most
 * likely to be looking: immediately after a compaction.
 *
 * The boundary records precisely what survived, so no guessing is needed:
 *   - `preservedMessages.allUuids` — pre-boundary messages carried through
 *     verbatim (the tail of the old conversation).
 *   - everything after the boundary, starting with the summary itself, is live
 *     by definition.
 *
 * Only the LAST boundary matters: anything an earlier one preserved but the
 * last one dropped is correctly excluded.
 */
function liveSlice(entries) {
  let lastBoundary = -1;
  let compactions = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      compactions++;
      lastBoundary = i;
    }
  }

  if (lastBoundary === -1) {
    return { live: entries, compactions: 0, trigger: null, droppedTokens: 0, postTokens: null, boundaryIndex: -1 };
  }

  const meta = entries[lastBoundary].compactMetadata || {};
  const pm = meta.preservedMessages || {};
  const uuids = Array.isArray(pm.allUuids) ? pm.allUuids
    : Array.isArray(pm.uuids) ? pm.uuids
    : null;

  let head;
  if (uuids && uuids.length) {
    const preserved = new Set(uuids);
    head = entries.slice(0, lastBoundary).filter((e) => preserved.has(e.uuid));
  } else {
    // Older transcripts record only the preserved *segment*. Fall back to
    // everything from its head uuid onward, and to nothing if even that is
    // absent — under-counting the residual is far safer than over-counting
    // categories past 100%.
    const headUuid = (meta.preservedSegment || {}).headUuid;
    const from = headUuid ? entries.findIndex((e) => e.uuid === headUuid) : -1;
    head = from >= 0 ? entries.slice(from, lastBoundary) : [];
  }

  return {
    live: head.concat(entries.slice(lastBoundary + 1)),
    compactions,
    trigger: meta.trigger || null,
    droppedTokens: meta.cumulativeDroppedTokens || 0,
    postTokens: typeof meta.postTokens === 'number' ? meta.postTokens : null,
    boundaryIndex: lastBoundary,
  };
}

function blocksOf(entry) {
  const c = entry.message && entry.message.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
}

function textLength(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  try { return JSON.stringify(v).length; } catch { return 0; }
}

/** Short, readable label for what a tool call was aimed at. */
function targetOf(input) {
  if (!input || typeof input !== 'object') return '';
  // `description` first: for Bash it is a human summary, whereas `command` is
  // often a long one-liner that truncates to something unreadable.
  const v = input.file_path || input.path || input.pattern || input.url
    || input.description || input.command || input.prompt || '';
  // Sanitised here, once, at the boundary: every consumer (the text report and
  // the markdown snapshot alike) inherits it.
  return safe(v, 60);
}

/**
 * Walk the whole transcript and build an estimated breakdown by category,
 * plus the re-read and top-consumer lists that drive the pruning advice.
 */
function analyse(entries) {
  const cat = {
    tool_results: 0, tool_calls: 0, assistant_text: 0,
    thinking: 0, user_prompts: 0, attachments: 0,
  };
  const toolUses = new Map();  // tool_use_id -> {tool, target, index}
  const consumers = [];        // {tool, target, chars, index}
  const reads = new Map();     // file path -> count
  const seenMessages = new Set();

  // turnsAt[i] = distinct assistant turns at or before entry i. Precomputed so
  // the per-consumer lookup below is O(1) instead of a fresh O(n) walk each.
  const turnsAt = new Array(entries.length);
  let assistantTurns = 0;

  entries.forEach((e, index) => {
    if (e.isSidechain) { turnsAt[index] = assistantTurns; return; }

    if (e.type === 'attachment') {
      cat.attachments += textLength(e.attachment);
      turnsAt[index] = assistantTurns;
      return;
    }

    if (e.type === 'assistant') {
      const id = e.messageId || (e.message && e.message.id) || null;
      if (id && !seenMessages.has(id)) { seenMessages.add(id); assistantTurns++; }
      else if (!id) assistantTurns++;

      for (const b of blocksOf(e)) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') cat.assistant_text += textLength(b.text);
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // Claude Code often stores thinking redacted: `thinking` is empty and
          // only the encrypted `signature` remains. The signature is what is
          // actually replayed to the API, so counting it recovers most of the
          // cost that would otherwise vanish into the residual bucket.
          cat.thinking += textLength(b.thinking) + textLength(b.signature) + textLength(b.data);
        }
        else if (b.type === 'tool_use') {
          cat.tool_calls += textLength(b.input) + 40;
          const target = targetOf(b.input);
          toolUses.set(b.id, { tool: safe(b.name, 40), target, index });
          if (b.name === 'Read' && b.input && b.input.file_path) {
            const p = safe(b.input.file_path, 100);
            if (p) reads.set(p, (reads.get(p) || 0) + 1);
          }
        }
      }
      turnsAt[index] = assistantTurns;
      return;
    }

    if (e.type === 'user') {
      const blocks = blocksOf(e);
      let sawToolResult = false;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_result') {
          sawToolResult = true;
          const chars = textLength(b.content);
          cat.tool_results += chars;
          const meta = toolUses.get(b.tool_use_id) || { tool: 'unknown', target: '' };
          consumers.push({ tool: meta.tool, target: meta.target, chars, index });
        } else if (b.type === 'text') {
          cat.user_prompts += textLength(b.text);
        }
      }
      // toolUseResult carries structured results that the content block may summarise.
      if (!sawToolResult && e.toolUseResult) cat.tool_results += textLength(e.toolUseResult);
    }

    turnsAt[index] = assistantTurns;
  });

  const toTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

  const breakdown = Object.entries(cat)
    .map(([category, chars]) => ({ category, tokensEst: toTokens(chars) }))
    .filter((x) => x.tokensEst > 0)
    .sort((a, b) => b.tokensEst - a.tokensEst);

  const ranked = consumers.slice().sort((a, b) => b.chars - a.chars);
  const topConsumers = ranked
    .slice(0, 8)
    .map((c) => ({
      tool: c.tool,
      target: c.target,
      tokensEst: toTokens(c.chars),
      turnsAgo: Math.max(0, assistantTurns - (turnsAt[c.index] || 0)),
    }));

  const rereads = [...reads.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, count]) => ({ file, count }));

  return { breakdown, topConsumers, rereads, assistantTurns, consumerCount: consumers.length };
}

// ── Zone classification ──────────────────────────────────────

function classify(zones, value) {
  for (const z of zones) if (value < z.max) return z;
  return zones[zones.length - 1];
}

/**
 * Load the entries a report needs. The shallow path reads only the tail, which
 * is enough on almost every turn and keeps the per-turn Stop hook cheap — but
 * one oversized tool result can push the last usage record out of the tail, and
 * going blind precisely when the context is largest is the wrong failure. So it
 * escalates (bounded) rather than reporting no data.
 */
function loadEntries(transcriptPath, deep) {
  if (deep) {
    try {
      return parseJsonl(fs.readFileSync(transcriptPath, 'utf8'));
    } catch {
      // Too big for one string, or unreadable mid-read. A tail-scoped reading
      // beats no reading at all; the caller flags it.
      return parseJsonl(readTailEscalating(transcriptPath, TAIL_BYTES));
    }
  }
  const tail = parseJsonl(readTailEscalating(transcriptPath, TAIL_BYTES));
  if (findLatestUsage(tail)) return tail;
  try {
    return parseJsonl(fs.readFileSync(transcriptPath, 'utf8'));
  } catch {
    return tail;
  }
}

/**
 * Build the full report. `deep: false` reads only the tail of the transcript
 * and skips the breakdown — used by the per-turn Stop hook so it stays cheap.
 */
function report(transcriptPath, opts) {
  const deep = !(opts && opts.deep === false);

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { ok: false, reason: 'transcript not found' };
  }
  try {
    if (fs.statSync(transcriptPath).isDirectory()) {
      return { ok: false, reason: 'transcript path is a directory' };
    }
  } catch {
    return { ok: false, reason: 'transcript not readable' };
  }

  const entries = loadEntries(transcriptPath, deep);

  // Slice FIRST, then measure. A compaction leaves the pre-compaction usage
  // record as the last one in the file until Claude next replies, so measuring
  // over the whole transcript reports the old, larger total — the very error
  // liveSlice exists to prevent, and at the one moment the Stop hook fires.
  const slice = liveSlice(entries);

  let latest = findLatestUsage(slice.live);
  let measuredFrom = 'live assistant turn';

  if (!latest && slice.boundaryIndex >= 0 && slice.postTokens !== null) {
    // No assistant turn since the boundary. The boundary itself records the
    // post-compaction size, which is the honest number for right now.
    latest = { tokens: slice.postTokens, output: 0, model: findLatestModel(entries) };
    measuredFrom = 'compaction boundary (postTokens)';
  }

  if (!latest) {
    return { ok: false, reason: 'no usage data yet (no assistant turn recorded)' };
  }

  const tokens = latest.tokens;
  const win = detectWindow(latest.model || findLatestModel(entries), tokens);
  const acw = detectAutoCompactWindow(win.window, win.confident);

  const firesAt = Math.max(0, acw.window - AUTOCOMPACT_HEADROOM);

  // The pressure ladder is only meaningful when both of its inputs mean
  // something. Two cases where it does not:
  //   - firesAt <= 0: the configured window is at or below the headroom, so
  //     tokens/firesAt would pin the verdict to CRITICAL at every size.
  //   - the model window was guessed AND no trigger is configured: both the
  //     numerator's denominator and the trigger are inventions, and the old
  //     code turned that into a confident CRITICAL at 180K that flipped to
  //     WATCH one token later when the observed-usage floor fired.
  const pressureMeaningful = firesAt > 0 && (acw.configured || win.confident !== false);
  const pressure = pressureMeaningful ? tokens / firesAt : null;

  const degradationZone = classify(DEGRADATION_ZONES, tokens);
  const pressureZone = pressureMeaningful ? classify(PRESSURE_ZONES, pressure) : null;

  const useDegradation = !pressureZone || SEVERITY[degradationZone.key] >= SEVERITY[pressureZone.key];
  const verdict = useDegradation ? degradationZone : pressureZone;
  const driver = useDegradation ? 'degradation' : 'pressure';

  const out = {
    ok: true,
    tokens,
    measuredFrom,
    model: latest.model,
    window: win.window,
    windowSource: win.source,
    windowConfident: win.confident !== false,
    autoCompactWindow: acw.window,
    autoCompactSource: acw.source,
    autoCompactConfigured: acw.configured,
    autoCompactFiresAt: firesAt,
    // With no window configured the real trigger sits somewhere below this, so
    // the runway is at most this large. Callers must not present it as exact.
    firesAtIsUpperBound: !acw.configured,
    tokensUntilAutoCompact: firesAt - tokens,
    pctOfWindow: +(100 * tokens / win.window).toFixed(1),
    pressureMeaningful,
    pctOfAutoCompact: pressureMeaningful ? +(100 * pressure).toFixed(1) : null,
    degradationZone: zoneOut(degradationZone),
    pressureZone: pressureZone ? zoneOut(pressureZone) : null,
    verdict: Object.assign(zoneOut(verdict), { driver }),
    // Both readings agree when there is no second reading to disagree with.
    zonesAgree: !pressureZone || degradationZone.key === pressureZone.key,
  };

  if (deep) {
    // Only what is still in context: counting compacted-away entries against a
    // post-compaction measured total is what made this breakdown nonsense.
    const a = analyse(slice.live);
    const accounted = a.breakdown.reduce((s, b) => s + b.tokensEst, 0);
    const residual = tokens - accounted;

    out.breakdown = a.breakdown;
    out.overheadEst = Math.max(0, residual); // system prompt, tools, CLAUDE.md, memory
    // When the 4-chars/token estimate overshoots the measured total the old
    // code clamped the residual to 0 and silently printed a breakdown summing
    // past 100%. Keep the sign so the renderer can say so.
    out.overAttributedEst = residual < 0 ? -residual : 0;
    out.topConsumers = a.topConsumers;
    out.consumerCount = a.consumerCount;
    out.rereads = a.rereads;
    out.assistantTurns = a.assistantTurns;
    out.compactions = slice.compactions;
    out.lastCompactTrigger = slice.trigger;
    out.droppedTokens = slice.droppedTokens;
  }

  return out;
}

function zoneOut(z) {
  return { key: z.key, label: z.label, emoji: z.emoji, headline: z.headline };
}

module.exports = {
  report, parseWindow, dataDir, setDataDir, readPluginConfig, userSettings, pruneDir, safe,
  DEGRADATION_ZONES, PRESSURE_ZONES, SEVERITY, AUTOCOMPACT_HEADROOM, TAIL_BYTES, MAX_TAIL_BYTES,
  // Exported for tests: pure functions over parsed transcript entries.
  liveSlice, analyse, parseJsonl, classify, findLatestUsage, findLatestModel,
  detectWindow, detectAutoCompactWindow, readTail, readTailEscalating, targetOf,
};
