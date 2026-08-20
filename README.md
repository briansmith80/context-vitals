# Context Vitals

[![test](https://github.com/briansmith80/context-vitals/actions/workflows/test.yml/badge.svg)](https://github.com/briansmith80/context-vitals/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/briansmith80/context-vitals?sort=semver&display_name=release&label=release)](https://github.com/briansmith80/context-vitals/releases)
[![node](https://img.shields.io/badge/node-20%2B-blue)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)

A Claude Code plugin that tells you **when to `/clear`, when to `/compact` (and
with what focus), and when to just prune** — from a measured reading of your live
context window.

The principle it encodes: *don't manage a full context window — avoid creating
one.* Compaction is a repair, not a tonic.

## What it looks like

Run `/context-check` in any session. It reports **two readings**, because two
different things can go wrong:

- **absolute size** — how many tokens are in the window, which is what dilutes attention
- **window pressure** — how close you are to the point where auto-compaction fires

Whichever is worse **binds** the verdict, and the header line says which.
**Runway** is how many tokens you have left before auto-compaction.

```text
  CONTEXT VITALS                            412.3K / 1M measured · 41.2%
  ══════════════════════════════════════════════════════════════════════

  🟠  ACT — absolute size binds, not runway.
      Attention meaningfully diluted. Expect missed details, re-reads,
      drift from earlier instructions.

                                                 ╻667K auto-compact
      ██████████████████████████▍░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                            ╵350K ACT       ╵600K DEGRADED

      MEASURE          READING  NORMAL      ZONE
    > absolute size     412.3K  under 150K  ACT   🟠
      window pressure    61.8%  under 50%   WATCH 🟡

  ── EVIDENCE ──────────────────────────────────────────────────────────

      COMPOSITION           estimated from characters · not measured
        tool results             222K  ███████████████▏░░░░░░░░░░░░  54%
        baseline & unattributed  138K  █████████▍░░░░░░░░░░░░░░░░░░  33%
        thinking                  35K  ██▍░░░░░░░░░░░░░░░░░░░░░░░░░   9%
        assistant text            10K  ▊░░░░░░░░░░░░░░░░░░░░░░░░░░░   3%
        your prompts               5K  ▎░░░░░░░░░░░░░░░░░░░░░░░░░░░   1%
        attachments                2K  ▏░░░░░░░░░░░░░░░░░░░░░░░░░░░  <1%
        tool calls                409  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░  <1%
        baseline = system prompt, tool schemas, CLAUDE.md, memory

      LARGEST TOOL RESULTS  prune the oldest first — safest cut
        31K  Read src/legacy/report-builder.ts              40 turns ago
        18K  Bash run the full integration suite            27 turns ago
        12K  Grep createUser\(                              49 turns ago
         9K  Read src/auth.ts                               26 turns ago
         9K  Read src/auth.ts                               25 turns ago
         9K  Read src/auth.ts                               24 turns ago
        15 smaller not shown · --format json has all

      RE-READ FILES         near-duplicate versions compete
         3×  src/auth.ts
         2×  src/legacy/report-builder.ts

      METHOD                window, trigger, compaction history
        window       1M    CLAUDE_CODE_MAX_CONTEXT_TOKENS
        auto-compact 700K  CLAUDE_CODE_AUTO_COMPACT_WINDOW
        fires at     667K  ~255K of runway left
        compactions  1     last was manual · ~180K already dropped ·
                           everything above covers the post-compaction
                           context only
        transcript         given with --transcript
```

A real capture from a committed fixture; CI regenerates it and diffs it.

| Absolute size | Window pressure |
| :------------ | :-------------- |
| 🟢 Optimal — 0–150K | 🟢 under 50% |
| 🟡 Watch — 150–350K | 🟡 50–75% |
| 🟠 Act — 350–600K | 🟠 75–90% |
| 🔴 Degraded — 600–850K | 🔴 90–100% |
| ⛔ Critical — 850K+ | ⛔ 100%+ |

Those are the defaults. `/context-check` moves them by task class, because
thresholds depend on the precision the work needs — precise retrieval fails at
50–100K, broad summarisation holds to 350–500K. The evidence behind every number,
graded by source quality, is in
[`thresholds.md`](plugins/context-vitals/skills/context-check/reference/thresholds.md).

## Install

```bash
claude plugin marketplace add https://github.com/briansmith80/context-vitals; claude plugin install context-vitals@context-vitals-marketplace --yes
```

Restart Claude Code, or run `/reload-plugins`, to activate the hooks. Needs
Claude Code and `node` 20+ on `PATH`. No `npm install`.

To update later:

```bash
claude plugin update context-vitals@context-vitals-marketplace
```

Or turn on auto-update for the marketplace in `/plugin`.

<details>
<summary><strong>Other ways to install</strong></summary>

From inside Claude Code:

```text
/plugin marketplace add https://github.com/briansmith80/context-vitals
/plugin install context-vitals@context-vitals-marketplace
```

With a preflight script that checks `claude` and `node` first, then updates in
place if the plugin is already there:

```bash
curl -fsSL https://raw.githubusercontent.com/briansmith80/context-vitals/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/briansmith80/context-vitals/main/install.ps1 | iex
```

Both scripts are short and do nothing the one-liner does not. Read them before
you pipe them into a shell.

Use the full `https://` URL rather than the `briansmith80/context-vitals`
shorthand — the shorthand clones over SSH, which fails on an HTTPS-only setup.
And `;` chains in bash, zsh and PowerShell alike where `&&` is a parser error in
Windows PowerShell 5.1, so if you see two errors, fix the first one.

</details>

<details>
<summary><strong>Why re-running the install command does nothing</strong></summary>

The install one-liner is not an update path: `claude plugin install` prints
`already installed` and changes nothing. Use `claude plugin update`.

Updates are keyed on the `version` in `plugin.json`, and the cache keeps one
directory per version:

```text
~/.claude/plugins/cache/context-vitals-marketplace/context-vitals/<version>/
```

So if `claude plugin update` says *already at the latest version* when you
expected a change, the published version number has not moved — commits alone do
not make an update visible. `claude plugin list` shows what you are running.

</details>

## What you get

### `/context-check` — the on-demand verdict

Measures the window, breaks down what is filling it, and gives **one**
recommendation — including a ready-to-paste `/compact focus on …` line naming the
real files and open threads of *this* session. Claude will also run it
unprompted if you just ask whether your context is getting heavy.

One axis carries both readings: the fill is absolute size, the tick above is
where auto-compaction fires, the ticks below are the thresholds either side of
you.

**Pruning** means getting stale tool output out of context. Claude Code has no
per-result delete, so in practice that is `/rewind` to before a large read, or
`/clear` once you have noted what matters. The report names the biggest and
oldest results so you know whether it is worth it.

### Stop-hook nudges — quiet, and only on crossings

A one-line warning after a turn, the **first time** the session enters each worse
zone — at most four per climb, one per zone, rather than one per turn. Any
reading that comes back more than 40% smaller than the last resets the counter,
so a session that compacts can nudge again on the next climb. Silence it with
`quiet`, or raise the floor with `minZone`.

```text
Stop says: 🟠 Context Vitals · 412K/1M (41.2%) — ACT
   Attention meaningfully diluted. Expect missed details, re-reads, drift from earlier instructions.
   → Compact deliberately now: /compact focus on <what matters>. Run /context-check for a drafted focus line.
```

`Stop says:` is Claude Code's own label, so the plugin names itself in the line —
that is how you tell it from your other Stop hooks. The advice follows whichever
reading bound the verdict: rebuild from notes for absolute size, compact while
the choice is still yours for pressure.

### PreCompact snapshots — recovery when it goes lossy

Before any compaction, writes a markdown snapshot of what was in context: size,
category breakdown, largest tool results, and which files you read more than once
(read those first if the summary loses the thread). When the compaction is
**automatic** — the unfocused, lossy case — it says so.

Snapshots land in `compactions/` inside the plugin data directory. It never
blocks a compaction: blocking one would drive the conversation into the model's
hard limit, which is worse than a lossy summary.

## Why two readings, not one

Degradation is a function of *absolute token count* — 150K tokens dilute
attention identically whether your window is 200K or 1M. Auto-compaction pressure
is a function of *fraction of the configured window*. Either can bind:

- On a **200K** window you can hit auto-compaction while still well inside the green zone.
- On a **1M** window you can be deep into measurable degradation while nowhere near auto-compaction.

So it computes both and reports the worse.

## Should you set `/autocompact 400k`?

**On a 1M window, yes.** It puts the automatic pass at the top of the ACT zone — a
safety net *below* the point where quality visibly suffers, leaving room to
compact deliberately first.

```text
/autocompact 400k
```

Type it yourself: it applies to the current session *and* saves to
`autoCompactWindow` in `~/.claude/settings.json` in one step.

**On a 200K window, leave it on `auto`.** 200K is already near the top of the
WATCH zone, so compacting earlier just buys extra lossy compactions for no
quality gain. Manage that window with `/clear`.

The point is **not** to compact more often — *timing* beats *frequency*. In one
agent study, compacting on a timer barely beat never compacting (41.4% vs 38.9%),
while an oracle that skipped unnecessary compactions scored 52.9% — an upper
bound, not a workflow. A low window is a floor you rarely reach, because you
compacted with a focus first.

## Configuration

`/context-setup` writes this for you, and also recommends an auto-compact window
for your model. For an installed plugin the file is:

```text
~/.claude/plugins/data/context-vitals-context-vitals-marketplace/config.json
```

Running uninstalled via `claude --plugin-dir` gives no plugin data directory, so
the fallback is `~/.claude/context-vitals/config.json`. The `METHOD` block in
`/context-check` tells you which one is in play.

```json
{
  "quiet": false,
  "minZone": "watch",
  "contextWindow": null
}
```

| Key | Effect |
| :-- | :----- |
| `quiet` | `true` silences the Stop-hook zone nudges. `/context-check`, snapshots and post-compaction announcements still work. |
| `minZone` | Lowest zone allowed to nudge: `watch` (default), `act`, `degraded`, `critical`. `act` means "only when there is something to do". |
| `contextWindow` | Override window detection. Accepts `1000000`, `"1M"`, `"400k"`. `null` auto-detects. |

Every key fails closed, and **`/context-check` names anything it had to ignore** —
a quoted `"true"`, a misspelled zone, or a missing comma reverts to the defaults
rather than silently half-applying.

To remove the plugin entirely — note that at user scope the hooks run in **every**
session on the machine, not just one project:

```bash
claude plugin uninstall context-vitals@context-vitals-marketplace
```

Nothing grows without bound: `sessions/` keeps the newest 50 state files, pruned
on the first turn of a new session, and `compactions/` the newest 30 snapshots,
pruned before writing a new one.

<details>
<summary><strong>If it isn't working</strong></summary>

- **Nothing appeared after a turn.** Restart Claude Code or run `/reload-plugins`; hooks load at session start. Check `quiet` and `minZone` too — below `minZone` there is deliberately no output.
- **`/context-check` says "no reading available".** It could not find your transcript, or no assistant turn has happened yet. Pass `--session <id>` or `--transcript <path>` to pin it. A broken `config.json` is the next likeliest cause, and the `METHOD` block names what it rejected.
- **`claude plugin update` says "already at the latest version".** The published version has not moved. `claude plugin list` shows what you are running.
- **The window number looks wrong.** Detection is inferred; set `contextWindow` to override it.

</details>

## Under the hood

<details>
<summary><strong>How the number is measured</strong></summary>

Claude Code hands hooks a `transcript_path` but **not** token usage — only the
statusline gets that. So the plugin recovers the number from the transcript: the
last main-chain assistant message records the usage of the request that produced
it, and `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` is
exactly what was sent to the model on that turn. That headline figure is measured,
not estimated.

The Stop hook reads only the last 512KB of the transcript, so it stays cheap on
every turn. `/context-check` reads the whole file.

A compaction is applied **before** measuring, not after: Claude Code leaves the
pre-compaction usage record as the newest one in the file until it next replies,
so measuring over the whole transcript would report the old, larger total at
precisely the moment the Stop hook fires.

</details>

<details>
<summary><strong>Known limits</strong></summary>

- **The category breakdown is an estimate**, derived from character counts at ~4 chars/token. It is for relative sizing — which bucket dominates — not exact accounting. The headline total is measured.
- **Thinking is often stored redacted** (empty text, encrypted signature only). The plugin counts the signature, which is what actually gets replayed to the API, but this is approximate.
- **"Baseline + unattributed"** is the residual: system prompt, tool schemas, `CLAUDE.md`, memory, and anything the transcript does not store in plaintext. All estimation error lands here.
- **Window detection is inferred** from the model id and `~/.claude/settings.json`, and self-corrects upward if usage exceeds it. Set `contextWindow` if it still gets it wrong.
- **`--autocompact` on the command line is invisible to hooks** and cannot be detected. The env var and the setting can.
- **The auto-compact trigger point** is the configured window minus ~33K of headroom, observed in practice rather than documented. It affects only the "fires at" figure, never the verdict. With **no** window configured, Claude Code picks a model-tuned trigger a hook cannot discover — so the figure is labelled `at most` and treated as an upper bound.
- **Some attachments are ephemeral.** System reminders injected for one turn are counted as though they persist, so that row can overstate slightly. It does not affect the measured headline.
- **The estimate can over-attribute.** Dense JSON tool output tokenises well below 4 chars/token, so the attributed total sometimes exceeds the measured one. When that happens the report says so, and the percentages become shares of the estimate.
- **The transcript is chosen, not handed over.** `/context-check` has to find it, and reports no reading rather than guessing if it cannot. Pass `--session` or `--transcript` to pin it.
- **Subagent context is not counted.** Sidechains have their own windows. What a subagent *returns* lands in the parent transcript as an ordinary tool result and is counted there.
- **Readings after a compaction cover the post-compaction context only.** Claude Code appends a `compact_boundary` rather than truncating, so the plugin counts only what is still live — otherwise percentages run past 100% and "prune candidates" names results already gone. `/context-check` says how many compactions a session has been through.

</details>

## Contributing

```bash
npm test        # node --test, built in — no dependencies, Node 20+
```

Releasing, and what each CI invariant protects: see
[CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><strong>Layout</strong></summary>

```text
.claude-plugin/marketplace.json          local marketplace
plugins/context-vitals/
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
└─ test/
   ├─ context.test.js                    transcript parsing, zones, compaction
   ├─ detection.test.js                  window detection, boundaries, sanitising
   ├─ scripts.test.js                    end-to-end, spawns all three scripts
   └─ fixtures/make-fixture.js           regenerates the README sample output
```

Run the report standalone at any time:

```bash
node plugins/context-vitals/scripts/context-report.js --format json
```

</details>

## License

MIT
