---
name: context-setup
description: Configure the auto-compact window and Context Doctor's own settings. Use when the user asks about /autocompact, wants auto-compaction to fire earlier, or wants to silence or tune the context nudges.
disable-model-invocation: true
---

# Context setup

Two separate things live here. Do only what was asked.

## A — set the auto-compact window

### 1. Read the current state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-report.js" --format json
```

Use `window` (the model's context limit), `autoCompactWindow`, and
`autoCompactSource` from the output.

### 2. Recommend a value

| Detected window | Recommend | Reason |
| :--- | :--- | :--- |
| **1M** | `400k` | Puts the automatic pass at the top of the ACT zone — a safety net *below* the point where quality visibly suffers, leaving room to compact deliberately first. |
| **200K** | `auto` | 200K is already near the top of the WATCH zone. Compacting earlier than the limit just buys extra lossy compactions for no quality gain. Manage this window with `/clear`, not with a lower threshold. |

The point of setting it low is **not** to compact more often. It is to make the
automatic pass a floor you rarely hit, because you compacted deliberately with
a focus before reaching it. Say that explicitly — otherwise the user reads the
recommendation as "compact more", which the evidence says makes things worse.

### 3. Tell them to type it

```
/autocompact 400k
```

**Tell the user to type this themselves.** It is the best option and you cannot
run it: it applies to the current session *and* saves to
`autoCompactWindow` in `~/.claude/settings.json` in one step.

Accepted forms: `400000`, `400k`, `1M`, or a bare `100`–`1000` meaning
thousands. Range is 100K–1M, capped at the model's window.
`/autocompact auto` returns to the model-tuned window.

Only if the user explicitly asks you to write the setting instead: edit
`~/.claude/settings.json` with the `Edit` tool, setting the top-level key
`"autoCompactWindow": 400000`. Show them the diff, and warn that unlike the
slash command it will **not** affect the current session — only new ones.

Precedence, highest first: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var →
`--autocompact` CLI flag → `autoCompactWindow` setting. If
`autoCompactSource` came back as the env var, say that the setting will be
ignored while it is set.

## B — configure Context Doctor itself

Config file: `${CLAUDE_PLUGIN_DATA}/config.json`. Create it if absent.

```json
{
  "quiet": false,
  "contextWindow": null
}
```

| Key | Effect |
| :--- | :--- |
| `quiet` | `true` silences the per-turn Stop nudges entirely. `/context-check` and the PreCompact snapshot still work. |
| `contextWindow` | Override the detected context window when detection is wrong. Accepts `1000000`, `"1M"`, `"400k"`. `null` means auto-detect. |

Set `contextWindow` only if the user reports the window in `/context-check`
disagrees with `/context`. Detection reads the model id from the transcript and
the `model` key in settings; an LLM gateway alias or an unusual model string
can defeat it.

Write the file with the `Write` tool and confirm the path back to the user.
Changes take effect on the next turn — no restart needed.
