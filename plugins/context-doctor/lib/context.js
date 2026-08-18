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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Read at most `bytes` from the end of a file, dropping the leading partial line. */
function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  if (size <= bytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, size - bytes);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    try { out.push(JSON.parse(line)); } catch { /* truncated/partial line */ }
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

function dataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), '.claude', 'context-doctor');
}

function readPluginConfig() {
  return readJson(path.join(dataDir(), 'config.json')) || {};
}

function userSettings() {
  return readJson(path.join(os.homedir(), '.claude', 'settings.json')) || {};
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
 */
function detectWindow(modelId, observedTokens) {
  const cfg = readPluginConfig();

  const fromConfig = parseWindow(cfg.contextWindow);
  if (fromConfig) return { window: fromConfig, source: 'context-doctor config.json' };

  const fromEnv = parseWindow(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  if (fromEnv) return { window: fromEnv, source: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' };

  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') {
    return { window: 200000, source: 'CLAUDE_CODE_DISABLE_1M_CONTEXT=1' };
  }

  // The transcript records the base model id ("claude-opus-5") without the
  // [1m] variant suffix, so also consult the configured model in settings.
  const settingsModel = String(userSettings().model || '');
  const combined = (String(modelId || '') + ' ' + settingsModel).toLowerCase();

  let win = 200000;
  let source = 'model default (200K)';
  if (combined.includes('[1m]')) {
    win = 1000000; source = 'model variant [1m]';
  } else if (/sonnet-5|sonnet5|fable-5|fable5/.test(combined)) {
    win = 1000000; source = 'model with native 1M window';
  }

  // Self-correcting floor: if we have already used more than the inferred
  // window, the inference was wrong. Trust the measurement.
  if (observedTokens && observedTokens > win) {
    return { window: 1000000, source: 'inferred from observed usage (exceeded 200K)' };
  }
  return { window: win, source };
}

/**
 * The auto-compact window: env > user settings > model window.
 * The --autocompact CLI flag is invisible to hooks and cannot be detected.
 *
 * `configured` distinguishes a window we actually know from the fallback. When
 * unset, Claude Code chooses its own model-tuned trigger below the model limit,
 * so the derived "fires in" figure is an upper bound, not an estimate.
 */
function detectAutoCompactWindow(modelWindow) {
  const fromEnv = parseWindow(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (fromEnv) return { window: Math.min(fromEnv, modelWindow), source: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', configured: true };

  const fromSettings = parseWindow(userSettings().autoCompactWindow);
  if (fromSettings) return { window: Math.min(fromSettings, modelWindow), source: 'autoCompactWindow in ~/.claude/settings.json', configured: true };

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
    return { live: entries, compactions: 0, trigger: null, droppedTokens: 0, postTokens: null };
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
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
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

  let assistantTurns = 0;

  entries.forEach((e, index) => {
    if (e.isSidechain) return;

    if (e.type === 'attachment') {
      cat.attachments += textLength(e.attachment);
      return;
    }

    if (e.type === 'assistant') {
      const id = e.messageId || (e.message && e.message.id) || null;
      if (id && !seenMessages.has(id)) { seenMessages.add(id); assistantTurns++; }
      else if (!id) assistantTurns++;

      for (const b of blocksOf(e)) {
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
          toolUses.set(b.id, { tool: b.name, target, index });
          if (b.name === 'Read' && b.input && b.input.file_path) {
            const p = String(b.input.file_path);
            reads.set(p, (reads.get(p) || 0) + 1);
          }
        }
      }
      return;
    }

    if (e.type === 'user') {
      const blocks = blocksOf(e);
      let sawToolResult = false;
      for (const b of blocks) {
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
  });

  const toTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

  const breakdown = Object.entries(cat)
    .map(([category, chars]) => ({ category, tokensEst: toTokens(chars) }))
    .filter((x) => x.tokensEst > 0)
    .sort((a, b) => b.tokensEst - a.tokensEst);

  const topConsumers = consumers
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 8)
    .map((c) => ({
      tool: c.tool,
      target: c.target,
      tokensEst: toTokens(c.chars),
      turnsAgo: Math.max(0, assistantTurns - countAssistantTurnsBefore(entries, c.index)),
    }));

  const rereads = [...reads.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, count]) => ({ file, count }));

  return { breakdown, topConsumers, rereads, assistantTurns };
}

/** How many distinct assistant turns occurred at or before `index`. */
function countAssistantTurnsBefore(entries, index) {
  const ids = new Set();
  let n = 0;
  for (let i = 0; i <= index && i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const id = e.messageId || (e.message && e.message.id) || null;
    if (id) { if (!ids.has(id)) { ids.add(id); n++; } }
    else n++;
  }
  return n;
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
 * escalates to a full read rather than reporting no data.
 */
function loadEntries(transcriptPath, deep) {
  if (deep) return parseJsonl(fs.readFileSync(transcriptPath, 'utf8'));
  const tail = parseJsonl(readTail(transcriptPath, TAIL_BYTES));
  if (findLatestUsage(tail)) return tail;
  return parseJsonl(fs.readFileSync(transcriptPath, 'utf8'));
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

  const entries = loadEntries(transcriptPath, deep);
  const latest = findLatestUsage(entries);
  if (!latest) return { ok: false, reason: 'no usage data yet (no assistant turn recorded)' };

  const tokens = latest.tokens;
  const win = detectWindow(latest.model, tokens);
  const acw = detectAutoCompactWindow(win.window);

  const firesAt = Math.max(0, acw.window - AUTOCOMPACT_HEADROOM);
  const pressure = firesAt > 0 ? tokens / firesAt : 1;

  const degradationZone = classify(DEGRADATION_ZONES, tokens);
  const pressureZone = classify(PRESSURE_ZONES, pressure);
  const verdict = SEVERITY[degradationZone.key] >= SEVERITY[pressureZone.key] ? degradationZone : pressureZone;
  const driver = SEVERITY[degradationZone.key] >= SEVERITY[pressureZone.key] ? 'degradation' : 'pressure';

  const out = {
    ok: true,
    tokens,
    model: latest.model,
    window: win.window,
    windowSource: win.source,
    autoCompactWindow: acw.window,
    autoCompactSource: acw.source,
    autoCompactConfigured: acw.configured,
    autoCompactFiresAt: firesAt,
    // With no window configured the real trigger sits somewhere below this, so
    // the runway is at most this large. Callers must not present it as exact.
    firesAtIsUpperBound: !acw.configured,
    tokensUntilAutoCompact: firesAt - tokens,
    pctOfWindow: +(100 * tokens / win.window).toFixed(1),
    pctOfAutoCompact: +(100 * pressure).toFixed(1),
    degradationZone: { key: degradationZone.key, label: degradationZone.label, emoji: degradationZone.emoji, headline: degradationZone.headline },
    pressureZone: { key: pressureZone.key, label: pressureZone.label, emoji: pressureZone.emoji, headline: pressureZone.headline },
    verdict: { key: verdict.key, label: verdict.label, emoji: verdict.emoji, headline: verdict.headline, driver },
  };

  if (deep) {
    // Only what is still in context: counting compacted-away entries against a
    // post-compaction measured total is what made this breakdown nonsense.
    const slice = liveSlice(entries);
    const a = analyse(slice.live);
    const accounted = a.breakdown.reduce((s, b) => s + b.tokensEst, 0);
    out.breakdown = a.breakdown;
    out.overheadEst = Math.max(0, tokens - accounted); // system prompt, tools, CLAUDE.md, memory
    out.topConsumers = a.topConsumers;
    out.rereads = a.rereads;
    out.assistantTurns = a.assistantTurns;
    out.compactions = slice.compactions;
    out.lastCompactTrigger = slice.trigger;
    out.droppedTokens = slice.droppedTokens;
  }

  return out;
}

module.exports = {
  report, parseWindow, dataDir, readPluginConfig, userSettings, pruneDir,
  DEGRADATION_ZONES, PRESSURE_ZONES, SEVERITY, AUTOCOMPACT_HEADROOM, TAIL_BYTES,
  // Exported for tests: pure functions over parsed transcript entries.
  liveSlice, analyse, parseJsonl, classify, findLatestUsage, detectAutoCompactWindow,
};
