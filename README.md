# Context Doctor

A Claude Code plugin that tells you **when to `/clear`, when to `/compact` (and with what focus), and when to just prune** — from a measured reading of your live context window, not a guess.

The operating principle it encodes: *don't manage a full context window — avoid creating one.* Compaction is a repair, not a tonic.

---

## Install

One line:

```
claude plugin marketplace add briansmith80/claude-code-context; claude plugin install context-doctor@context-doctor-marketplace --yes
```

`;` chains commands in bash, zsh, and PowerShell alike, so that line is safe to paste in any of them. Then restart Claude Code or run `/reload-plugins` to activate the hooks.

<details>
<summary>Other ways</summary>

**From inside Claude Code:**

```
/plugin marketplace add briansmith80/claude-code-context
/plugin install context-doctor@context-doctor-marketplace
```

**With a preflight script** — checks for `claude` and a new enough `node`, then runs exactly the two commands above:

```bash
curl -fsSL https://raw.githubusercontent.com/briansmith80/claude-code-context/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/briansmith80/claude-code-context/main/install.ps1 | iex
```

Piping a script into a shell is worth hesitating over for anything that installs event hooks. Both scripts are short and do nothing the one-liner does not — read them first, or skip them.

**From a local clone**, for development:

```
/plugin marketplace add /path/to/your/clone
```

**Without installing at all** — loads for one session only, changes no settings:

```bash
claude --plugin-dir /path/to/your/clone/plugins/context-doctor
```

</details>

Requires Claude Code and `node` 18.13+ on `PATH`. No `npm install` — the plugin has zero dependencies and the tests use Node's built-in runner.

Installing at user scope means the Stop hook runs in **every** session on the machine, not just one project. To undo:

```
claude plugin uninstall context-doctor@context-doctor-marketplace
```

---

## What you get

### `/context-check` — the on-demand verdict

Measures the window, breaks down what is filling it, and gives **one** recommendation — including a ready-to-paste `/compact focus on …` line naming the actual files and open threads of *this* session. That last part is the whole point: Claude is the only participant who knows what your session is about, so it drafts the focus line rather than leaving you to.

```
  CONTEXT DOCTOR   🟠 ACT
  ──────────────────────────────────────────────────────────────

  ████████████████░░░░░░░░░░░░░░░░░░░░░░░░  41.2% of window
  412K of 1M tokens in context

  Degradation  🟠 ACT       (absolute size: 412K)
  Pressure     🟡 WATCH     (58.4% of the way to auto-compaction)

  Attention meaningfully diluted. Expect missed details, re-reads,
  drift from earlier instructions.

  Auto-compact window : 700K  (autoCompactWindow in ~/.claude/settings.json)
  Fires in            : ~255K more tokens
  Detected window     : 1M  (model variant [1m])

  Estimated breakdown
    Tool results                         238K    ████████░░░░░░ 58%
    Baseline + unattributed              94K     ███░░░░░░░░░░░ 23%
    ...

  Largest tool results  (prune candidates, oldest first is safest)
    31K     Read src/legacy/report-builder.ts      22 turns ago
    ...

  Re-read files  (near-duplicate versions compete for attention)
    3×  src/auth.ts
```

### Stop-hook nudges — quiet, and only on crossings

A one-line warning after a turn, the **first time** the session enters each worse zone. Per-session state means at most four nudges ever, not one per turn. Silence it with `quiet` in the config.

```
🟠 Context 412K/1M (41.2%) — ACT
   Attention meaningfully diluted. Expect missed details, re-reads, drift from earlier instructions.
   → Compact deliberately now: /compact focus on <what matters>. Run /context-check for a drafted focus line.
```

### PreCompact snapshots — recovery when it goes lossy

Before any compaction, writes a markdown snapshot of what was in context: size, category breakdown, largest tool results, and which files you read more than once (read those first if the summary loses the thread). When the compaction is **automatic** — the unfocused, lossy case — it says so.

It never blocks a compaction. Blocking an auto-compact would drive the conversation into the model's hard limit, which is strictly worse than a lossy summary.

### `/context-setup` — configure the window

Recommends and explains an auto-compact window for your model, and writes Context Doctor's own config.

---

## The two-zone model

**The plugin deliberately departs from the "% of 1M" table that inspired it.** Degradation is a function of *absolute token count* — 150K tokens dilute attention identically whether your window is 200K or 1M. Auto-compaction pressure is a function of *fraction of the configured window*. These are independent, and either can bind:

- On a **200K** window you can hit auto-compaction while still well inside the green degradation zone.
- On a **1M** window you can be deep into measurable degradation while nowhere near auto-compaction.

So it computes both and reports the worse. `verdict.driver` names the binding constraint: `"degradation"` means quality, `"pressure"` means runway.

| Degradation zone (absolute tokens) | | Pressure zone (% of auto-compact point) |
| :--- | :--- | :--- |
| 🟢 Optimal — 0–150K | | 🟢 under 50% |
| 🟡 Watch — 150–350K | | 🟡 50–75% |
| 🟠 Act — 350–600K | | 🟠 75–90% |
| 🔴 Degraded — 600–850K | | 🔴 90–100% |
| ⛔ Critical — 850K+ | | ⛔ 100%+ |

`/context-check` narrows further by task class, because thresholds depend on the precision the work needs — precise retrieval fails at 50–100K, broad summarisation holds to 350–500K.

The evidence behind every number is in
[`plugins/context-doctor/skills/context-check/reference/thresholds.md`](plugins/context-doctor/skills/context-check/reference/thresholds.md), graded by source quality, with the caveats stated.

---

## Should you set `/autocompact 400k`?

**On a 1M window, yes.** It puts the automatic pass at the top of the ACT zone — a safety net *below* the point where quality visibly suffers, leaving room to compact deliberately first.

The point is **not** to compact more often. Compacting on a timer barely beats never compacting (41.4% vs 38.9% in one agent study); compacting *selectively, at the right moment* is what wins (52.9%). Setting the window low makes the automatic pass a floor you rarely hit — because you compacted with a focus before reaching it.

**On a 200K window, leave it on `auto`.** 200K is already near the top of the WATCH zone; compacting earlier just buys extra lossy compactions for no quality gain. Manage that window with `/clear`.

```
/autocompact 400k
```

Type it yourself — it applies to the current session *and* saves to `autoCompactWindow` in `~/.claude/settings.json` in one step. Precedence, highest first: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var → `--autocompact` flag → the setting.

---

## Configuration

`~/.claude/context-doctor/config.json` (or `$CLAUDE_PLUGIN_DATA/config.json` when set):

```json
{
  "quiet": false,
  "contextWindow": null
}
```

| Key | Effect |
| :--- | :--- |
| `quiet` | `true` silences the Stop-hook nudges. `/context-check` and snapshots still work. |
| `contextWindow` | Override window detection. Accepts `1000000`, `"1M"`, `"400k"`. `null` = auto-detect. |

---

## How it measures

Claude Code hands hooks a `transcript_path` but **not** token usage — only the statusline receives that. So the plugin recovers the number from the transcript: the last main-chain assistant message records the usage of the request that produced it, and `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` is exactly what was sent to the model on that turn. That headline figure is measured, not estimated.

The Stop hook reads only the last 512KB of the transcript, so it stays cheap on every turn. `/context-check` reads the whole file.

### Known limits

- **The category breakdown is an estimate**, derived from character counts at ~4 chars/token. It is for relative sizing — which bucket dominates — not for exact accounting. The headline total is measured.
- **Thinking is often stored redacted** (empty text, encrypted signature only). The plugin counts the signature, which is what actually gets replayed to the API, but this is approximate.
- **"Baseline + unattributed"** is the residual: system prompt, tool schemas, `CLAUDE.md`, memory, and anything the transcript does not store in plaintext. It is computed as measured-total minus everything attributed, so all estimation error lands here.
- **Window detection is inferred.** The transcript records the base model id (`claude-opus-5`) without the `[1m]` variant suffix, so the plugin also reads `model` from `~/.claude/settings.json`, and self-corrects upward if observed usage exceeds the inferred window. Set `contextWindow` if it still gets it wrong.
- **`--autocompact` on the command line is invisible to hooks** and cannot be detected. The env var and the setting can.
- **The auto-compact trigger point** is reported as the configured window minus ~33K of headroom for the summarisation request. That headroom is an approximation observed in practice, not a documented constant. It affects only the "fires in" figure, never the zone verdict. With **no** window configured, Claude Code picks its own model-tuned trigger *below* the model limit, which a hook cannot discover — so the figure is labelled `at most` and treated as an upper bound rather than an estimate.
- **Some attachments are ephemeral.** System reminders injected for one turn are counted in the `Attachments` bucket as though they persist, so that row can overstate slightly. It does not affect the measured headline.

### Compaction

A compaction does not truncate the transcript — Claude Code appends a `compact_boundary` entry and carries on in the same file. So the plugin restricts its analysis to what is **still in context**: the boundary's `preservedMessages.allUuids` names the pre-boundary messages carried through verbatim, and everything after the boundary is live by definition. Only the last boundary counts.

Without this, the breakdown counts every tool result the compaction just discarded against a measured total that no longer includes them — category percentages run past 100%, the residual clamps to zero, and "prune candidates" names results that are already gone. That is worst exactly when you are most likely to look. Two regression tests hold the line.

`/context-check` reports how many compactions a session has been through and says the reading covers the post-compaction context only. On older transcripts that record just a preserved *segment*, it falls back to that; if even the metadata is missing it counts only post-boundary entries, deliberately under-counting rather than over-counting.

---

## Layout

```
.claude-plugin/marketplace.json          local marketplace
plugins/context-doctor/
├─ .claude-plugin/plugin.json
├─ hooks/hooks.json                      Stop + PreCompact
├─ lib/context.js                        transcript parsing, zones, detection
├─ scripts/
│  ├─ context-report.js                  /context-check data source
│  ├─ stop-nudge.js                      Stop hook
│  └─ pre-compact.js                     PreCompact hook
├─ skills/
│  ├─ context-check/SKILL.md             + reference/thresholds.md
│  └─ context-setup/SKILL.md
└─ test/context.test.js                  33 tests, no dependencies
```

Run the report standalone at any time:

```bash
node plugins/context-doctor/scripts/context-report.js --format json
```

---

## Tests

```bash
npm test        # node --test, built in — no dependencies, Node 18.13+
```

The suite pins the transcript-shape assumptions the whole plugin rests on — `isSidechain`, `messageId`, `toolUseResult`, `compact_boundary` — none of which is documented or stable. If Claude Code changes one, a test fails instead of the reading silently going wrong.

Data it touches is confined to a temp dir, and `CLAUDE_PLUGIN_DATA` is redirected there so your real config cannot affect the results.

---

## Housekeeping

Both data directories are pruned automatically, so neither grows without bound:

| Directory | Kept |
| :--- | :--- |
| `sessions/` | newest 50 state files, pruned on the first turn of a new session |
| `compactions/` | newest 30 snapshots, pruned before writing a new one |

## License

MIT
