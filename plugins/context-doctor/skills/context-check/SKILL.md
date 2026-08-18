---
name: context-check
description: Read the live context window and give a verdict on whether to /clear, /compact (with a drafted focus line), prune tool output, or carry on. Use when the user asks about context size, context health, whether to compact or clear, or says the session feels heavy or forgetful.
---

# Context check

Report a **measured** reading of the context window, then give **one** recommendation.

## Step 1 — get the numbers

Run this and use its output as ground truth. Do not estimate context size yourself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-report.js"
```

Then reproduce the script's output to the user inside a code fence, **byte for
byte**. It is generated output, not draft prose: do not reword it, do not
summarise it, do not tighten a line you think reads awkwardly, do not drop rows.
Changing a single word here makes a measurement tool look like it is
guessing. Add your recommendation *below* the fence, never inside it.

If the script reports it cannot read usage, say so and tell the user to run `/context` instead. Do not guess a number.

## Step 2 — pick the verdict

The script gives a generic zone. **You** narrow it, because you know what this session is actually doing and the script does not. Classify the current work and use the threshold for that class:

| Task class | Act at | Why |
| :--- | :--- | :--- |
| **Precise retrieval** — find one fact, config value, or line across many files | **50–100K** | Earliest failure mode. Latent-retrieval accuracy erodes from ~2K and is unreliable by 32K. Use a subagent instead of loading files. |
| **Multi-file refactor / debugging** | **200–350K** | Needs continuity, but near-identical file versions in context act as distractors. |
| **Broad analysis / summarisation** | **350–500K** | Most robust class. No single needle to lose. |
| **Long agentic loop, heavy tool use** | **prune continuously; compact 250–400K** | Tool output dominates and is the most disposable. |
| **Switching to unrelated work** | **`/clear` at any size** | Old conversation is pure cost. |

Then choose exactly one action, in this order of preference:

1. **`/clear`** — if the next work is unrelated to what is in context. Free, instant, nothing is summarised away. Offer to write open threads to a notes file first so clearing is lossless.
2. **Prune tool output** — if the breakdown shows tool results are the bulk. The lightest-touch option; suggest `/rewind` or dropping stale results rather than summarising everything.
3. **`/compact <focus>`** — if the task must continue and earlier decisions still matter. **Always draft the focus line for them.** See below.
4. **Bare `/compact`** — last resort only. Say plainly that it keeps what the summariser guesses, not what they choose.
5. **Nothing** — if green, say so in one line and stop. Do not manufacture work.

## Step 3 — draft the focus line

This is the highest-value thing you do here, because you are the only participant who knows what this session is about.

Write a concrete, ready-to-paste line naming the actual files, decisions, and open threads of *this* conversation:

```
/compact focus on the PostToolUse hook in scripts/stop-nudge.js, the zone-crossing
state format, and the still-unverified Windows path quoting
```

Not `/compact focus on the current task`. Name real things.

## Rules

- **One recommendation, not a menu.** State it, give a one-sentence reason, stop.
- **If the report shows `Compactions so far` is 1 or more**, weight the verdict toward `/clear`. A session that has already been summarised once has lost detail you cannot get back, and each further compaction compounds it — that is the case for restarting from notes, not for compacting again. Note also that the breakdown covers only the post-compaction context, so it will look smaller than the work the session has actually done.
- **Compaction is a repair, not maintenance.** Roughly 40% of compaction events flip at least one previously-correct answer to wrong. Never recommend it as routine hygiene when `/clear` or pruning would do.
- **Prefer prevention.** If the user is about to do a large read, recommend delegating it to a subagent instead of compacting afterwards.
- Do not re-run the script more than once per request.
- Background on the thresholds and the evidence behind them: `${CLAUDE_PLUGIN_ROOT}/skills/context-check/reference/thresholds.md`. Read it only if the user asks *why* a threshold is where it is.
