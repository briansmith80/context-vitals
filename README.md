# Context Doctor

A Claude Code plugin that tells you **when to `/clear`, when to `/compact` (and with what focus), and when to just prune** — from a measured reading of your live context window, not a guess.

The operating principle it encodes: *don't manage a full context window — avoid creating one.* Compaction is a repair, not a tonic.

---

## Install

One line:

```
claude plugin marketplace add https://github.com/briansmith80/context-doctor; claude plugin install context-doctor@context-doctor-marketplace --yes
```

Then restart Claude Code or run `/reload-plugins` to activate the hooks.

Two notes on that line. It uses the full `https://` URL rather than the
`briansmith80/context-doctor` shorthand, because Claude Code clones the shorthand
**over SSH** by default and suppresses the interactive host-key and passphrase
prompts — so an HTTPS-only GitHub setup fails with `Permission denied (publickey)`
on a public repo that needs no credentials at all. And `;` chains commands in
bash, zsh and PowerShell alike, which is why it is used instead of `&&`
(a parser error in Windows PowerShell 5.1) — but it also means the second command
runs even if the first fails. If you see two errors, fix the first one.

<details>
<summary>Other ways</summary>

**From inside Claude Code:**

```
/plugin marketplace add https://github.com/briansmith80/context-doctor
/plugin install context-doctor@context-doctor-marketplace
```

**With a preflight script** — checks for `claude` and a new enough `node`, then runs the two commands above, or updates in place if the plugin is already installed:

```bash
curl -fsSL https://raw.githubusercontent.com/briansmith80/context-doctor/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/briansmith80/context-doctor/main/install.ps1 | iex
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

Requires Claude Code and `node` 20+ on `PATH`. No `npm install` — the plugin has zero dependencies and the tests use Node's built-in runner.

Installing at user scope means the Stop hook runs in **every** session on the machine, not just one project. To undo:

```
claude plugin uninstall context-doctor@context-doctor-marketplace
```

## Updating

```
claude plugin update context-doctor@context-doctor-marketplace
```

Then restart Claude Code, or run `/reload-plugins`. From inside a session,
`/plugin` does the same thing with a menu.

Re-running either installer works too — both detect an existing install and
update it rather than reinstalling.

To stop doing this by hand, turn on auto-update for this marketplace in
`/plugin`. That is a switch on your machine, per marketplace; nothing this repo
publishes can set it for you.

<details>
<summary>Why reinstalling does nothing, and what "already at the latest version" means</summary>

`claude plugin install` is a no-op once the plugin is present: it prints
`already installed` and exits 0. So the install one-liner is not an update path
— it reports success and changes nothing, which is worse than an error, because
a tick invites no investigation. That is the whole reason the installers branch
on what is already there. `claude plugin marketplace add` short-circuits the
same way once its clone exists (`already on disk` — it fetches nothing), which
is why the update path runs `claude plugin marketplace update` first rather than
trusting `add` to refresh it.

Updates are keyed on the `version` in `plugin.json`, and the cache keeps one
directory per version:

```
~/.claude/plugins/cache/context-doctor-marketplace/context-doctor/1.1.0/
```

So if `claude plugin update` reports *already at the latest version* when you
were expecting a change, the published version number has not moved — commits
alone do not make an update visible. `claude plugin list` shows what you are
actually running.

</details>

---

## What you get

### `/context-check` — the on-demand verdict

Measures the window, breaks down what is filling it, and gives **one** recommendation — including a ready-to-paste `/compact focus on …` line naming the actual files and open threads of *this* session. That last part is the whole point: Claude is the only participant who knows what your session is about, so it drafts the focus line rather than leaving you to.

One axis carries both readings: the fill is absolute size, the tick above is
where auto-compaction fires, the ticks below are the degradation thresholds
either side of you. Seeing 412K sitting inside ACT while the trigger is still out
at 667K *is* the argument for the verdict.

```
  CONTEXT DOCTOR                            412.3K / 1M measured · 41.2%
  ══════════════════════════════════════════════════════════════════════

  🟠  ACT — absolute size binds, not runway.
      Attention meaningfully diluted. Expect missed details, re-reads,
      drift from earlier instructions.

                                                 ╻667K auto-compact
      ██████████████████████████▍░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
                            ╵350K ACT       ╵600K DEGRADED

      VITALS           READING  NORMAL      ZONE
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

That block is a real capture, not an illustration — regenerate it with:

```bash
node plugins/context-doctor/test/fixtures/make-fixture.js
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000 \
  node plugins/context-doctor/scripts/context-report.js \
  --transcript plugins/context-doctor/test/fixtures/showcase.jsonl
```

Design constraints worth knowing, because they are load-bearing: no ANSI colour
(the report is reproduced inside a markdown fence, where escapes render as
literal garbage), so every colour is an emoji glyph; nothing exceeds 72 rendered
columns; and a `≤` or `≥` on a value marks it as a **bound**, not a measurement.
Column arithmetic is done in rendered columns rather than `String.length`,
because `⛔` has length 1 and renders two columns wide.

### Stop-hook nudges — quiet, and only on crossings

A one-line warning after a turn, the **first time** the session enters each worse
zone — at most four per climb, one per zone, rather than one per turn. A
compaction that drops the context by 40% or more resets the counter, so a session
that compacts repeatedly can nudge again on each new climb. Silence it entirely
with `quiet`, or raise the floor with `minZone`.

The advice tracks whichever ladder bound the verdict: "rebuild from notes" for a
degradation-driven warning, "compact while the choice is still yours" for a
pressure-driven one.

```
Stop says: 🟠 Context Doctor · 412K/1M (41.2%) — ACT
   Attention meaningfully diluted. Expect missed details, re-reads, drift from earlier instructions.
   → Compact deliberately now: /compact focus on <what matters>. Run /context-check for a drafted focus line.
```

`Stop says:` is Claude Code’s own label — it names hook output by event, and no
field in `hooks.json` or the hook’s output changes it — so the plugin puts its
name in the line it does control. With several Stop hooks installed you would
otherwise have no way to tell whose message you are reading.

### PreCompact snapshots — recovery when it goes lossy

Before any compaction, writes a markdown snapshot of what was in context: size, category breakdown, largest tool results, and which files you read more than once (read those first if the summary loses the thread). When the compaction is **automatic** — the unfocused, lossy case — it says so.

Snapshots land in `compactions/` inside the plugin data directory (see
[Configuration](#configuration)), newest 30 kept.

The announcement is delivered on the **next turn**, by the Stop hook, not by the
PreCompact hook that produced it: Claude Code discards a PreCompact hook's
`systemMessage`, so a warning printed there would reach nobody. PreCompact queues
the message into the session state file and the Stop hook — whose `systemMessage`
*is* shown — hands it over. That announcement is delivered even when `quiet` is
set, because silencing size warnings is not the same as consenting to lose
context unannounced.

It never blocks a compaction. Blocking an auto-compact would drive the conversation into the model's hard limit, which is strictly worse than a lossy summary.

### `/context-setup` — configure the window

Recommends and explains an auto-compact window for your model, and writes Context Doctor's own config.

---

## The two-zone model

**The plugin deliberately departs from the "% of 1M" table that inspired it.** Degradation is a function of *absolute token count* — 150K tokens dilute attention identically whether your window is 200K or 1M. Auto-compaction pressure is a function of *fraction of the configured window*. These are independent, and either can bind:

- On a **200K** window you can hit auto-compaction while still well inside the green degradation zone.
- On a **1M** window you can be deep into measurable degradation while nowhere near auto-compaction.

So it computes both and reports the worse. `verdict.driver` names the binding constraint: `"degradation"` means quality, `"pressure"` means runway — and the report's header line says which in words.

The pressure ladder is **suppressed** rather than guessed when both of its inputs
are inventions: no configured trigger *and* a window that was only inferred from
the model string. Reporting it anyway used to produce a confident `CRITICAL` at
180K that flipped to `WATCH` one token later, when the self-correcting window
floor fired.

| Degradation zone (absolute tokens) |  | Pressure zone (% of auto-compact point) |
| :--------------------------------- | :- | :-------------------------------------- |
| 🟢 Optimal — 0–150K              |  | 🟢 under 50%                            |
| 🟡 Watch — 150–350K              |  | 🟡 50–75%                              |
| 🟠 Act — 350–600K                |  | 🟠 75–90%                              |
| 🔴 Degraded — 600–850K           |  | 🔴 90–100%                             |
| ⛔ Critical — 850K+               |  | ⛔ 100%+                                |

`/context-check` narrows further by task class, because thresholds depend on the precision the work needs — precise retrieval fails at 50–100K, broad summarisation holds to 350–500K.

The evidence behind every number is in
[`plugins/context-doctor/skills/context-check/reference/thresholds.md`](plugins/context-doctor/skills/context-check/reference/thresholds.md), graded by source quality, with the caveats stated.

---

## Should you set `/autocompact 400k`?

**On a 1M window, yes.** It puts the automatic pass at the top of the ACT zone — a safety net *below* the point where quality visibly suffers, leaving room to compact deliberately first.

The point is **not** to compact more often. In one agent study (a 4B model on one
maths benchmark), compacting on a timer barely beat never compacting — 41.4% vs
38.9% — while an **oracle** that skips compaction whenever the answer is already
correct scored 52.9%. That oracle consults the correct answer, so it is an upper
bound rather than a workflow anyone can run; what it shows is that *timing*
matters more than *frequency*. Setting the window low makes the automatic pass a
floor you rarely hit — because you compacted with a focus before reaching it.

**On a 200K window, leave it on `auto`.** 200K is already near the top of the WATCH zone; compacting earlier just buys extra lossy compactions for no quality gain. Manage that window with `/clear`.

```
/autocompact 400k
```

Type it yourself — it applies to the current session *and* saves to `autoCompactWindow` in `~/.claude/settings.json` in one step. Precedence, highest first: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var → `--autocompact` flag → the setting.

---

## Configuration

Config lives in the plugin's own data directory. For an **installed** plugin that
is `$CLAUDE_PLUGIN_DATA`, which Claude Code creates per plugin:

```
~/.claude/plugins/data/context-doctor-context-doctor-marketplace/config.json
```

`~/.claude/context-doctor/config.json` is the fallback, used only when the plugin
is loaded without being installed (`claude --plugin-dir …`) and so has no data
directory of its own. `/context-setup` writes the right file for you; the
`transcript`/`METHOD` rows in `/context-check` tell you which one is in play.

```json
{
  "quiet": false,
  "minZone": "watch",
  "contextWindow": null
}
```

| Key               | Effect                                                                                                                                                        |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quiet`         | `true` silences the Stop-hook zone nudges. `/context-check`, snapshots, and post-compaction announcements still work.                                     |
| `minZone`       | Lowest zone allowed to nudge:`watch` (default), `act`, `degraded`, `critical`. `act` means "only when there is something to do".                    |
| `contextWindow` | Override window detection. Accepts`1000000`, `"1M"`, `"400k"`. `null` = auto-detect. Set this if `windowConfident` is `false` in the JSON output. |

Every key here fails closed, and **`/context-check` names anything it had to
ignore**. A quoted `"quiet": "true"` is not a boolean and silences nothing; a
misspelled `minZone` falls back to `watch`; an unparseable `contextWindow` falls
through to detection; a missing comma reverts all three at once. Each of those
used to be silent, which left you believing a setting was in force. Now the
`METHOD` block leads with a `config` row saying what was rejected and what is in
force instead — including on the no-reading path, where a broken config file is
the likeliest reason there is nothing to show.

---

## How it measures

Claude Code hands hooks a `transcript_path` but **not** token usage — only the statusline receives that. So the plugin recovers the number from the transcript: the last main-chain assistant message records the usage of the request that produced it, and `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` is exactly what was sent to the model on that turn. That headline figure is measured, not estimated.

The Stop hook reads only the last 512KB of the transcript, so it stays cheap on every turn. `/context-check` reads the whole file.

Two details in that cheap path. A compaction is applied **before** measuring, not
after: Claude Code leaves the pre-compaction usage record as the newest one in the
file until it next replies, so measuring over the whole transcript would report
the old, larger total at precisely the moment the Stop hook fires. When no
assistant turn has happened since the boundary, the boundary's own `postTokens`
is the honest figure, and the report says that is where the number came from. And
when a single transcript line is larger than the 512KB window — one enormous tool
result — that window contains no newline at all, so the read escalates in bounded
steps rather than going blind exactly when the context is biggest.

### Known limits

- **The category breakdown is an estimate**, derived from character counts at ~4 chars/token. It is for relative sizing — which bucket dominates — not for exact accounting. The headline total is measured.
- **Thinking is often stored redacted** (empty text, encrypted signature only). The plugin counts the signature, which is what actually gets replayed to the API, but this is approximate.
- **"Baseline + unattributed"** is the residual: system prompt, tool schemas, `CLAUDE.md`, memory, and anything the transcript does not store in plaintext. It is computed as measured-total minus everything attributed, so all estimation error lands here.
- **Window detection is inferred.** The transcript records the base model id (`claude-opus-5`) without the `[1m]` variant suffix, so the plugin also reads `model` from `~/.claude/settings.json`, and self-corrects upward if observed usage exceeds the inferred window. Set `contextWindow` if it still gets it wrong.
- **`--autocompact` on the command line is invisible to hooks** and cannot be detected. The env var and the setting can.
- **The auto-compact trigger point** is reported as the configured window minus ~33K of headroom for the summarisation request. That headroom is an approximation observed in practice, not a documented constant. It affects only the "fires in" figure, never the zone verdict. With **no** window configured, Claude Code picks its own model-tuned trigger *below* the model limit, which a hook cannot discover — so the figure is labelled `at most` and treated as an upper bound rather than an estimate.
- **Some attachments are ephemeral.** System reminders injected for one turn are counted in the `attachments` bucket as though they persist, so that row can overstate slightly. It does not affect the measured headline.
- **The estimate can over-attribute.** Dense JSON tool output tokenises well below 4 chars/token, so the attributed total sometimes exceeds the measured one. When that happens the report says so and the category percentages become shares of the estimate rather than of the measurement — use them to see which bucket dominates, nothing more.
- **The transcript is chosen, not handed over.** Hooks get `transcript_path` directly, but `/context-check` has to find it: it matches on `CLAUDE_CODE_SESSION_ID`, and failing that on the `cwd` each transcript records about itself. If neither matches it reports no reading rather than guessing. Pass `--session <id>` or `--transcript <path>` to pin it. (Earlier versions reconstructed the project-directory slug and, when that missed, matched any project folder whose name merely *ended with* the current folder's basename — which could report an unrelated project's session as though it were yours.)
- **Subagent context is not counted.** Sidechain traffic is excluded, because subagents have their own windows. What a subagent *returns* lands in the parent transcript as an ordinary tool result and is counted there.

### Compaction

A compaction does not truncate the transcript — Claude Code appends a `compact_boundary` entry and carries on in the same file. So the plugin restricts its analysis to what is **still in context**: the boundary's `preservedMessages.allUuids` names the pre-boundary messages carried through verbatim, and everything after the boundary is live by definition. Only the last boundary counts.

Without this, the breakdown counts every tool result the compaction just discarded against a measured total that no longer includes them — category percentages run past 100%, the residual clamps to zero, and "prune candidates" names results that are already gone. That is worst exactly when you are most likely to look. Regression tests hold the line, including one that asserts a post-compaction transcript reports the post-compaction size rather than the stale pre-compaction total.

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
└─ test/
   ├─ context.test.js                    transcript parsing, zones, compaction
   ├─ detection.test.js                  window detection, boundaries, sanitising
   ├─ scripts.test.js                    end-to-end, spawns all three scripts
   └─ fixtures/make-fixture.js           regenerates the README's sample output
```

Run the report standalone at any time:

```bash
node plugins/context-doctor/scripts/context-report.js --format json
```

---

## Tests

```bash
npm test        # node --test, built in — no dependencies, Node 20+
```

82 tests, no dependencies. Three files, by what they protect:

- **`context.test.js`** pins the transcript-shape assumptions the whole plugin rests on — `isSidechain`, `messageId` / `message.id` (driven independently, so renaming either fails a test), `toolUseResult`, `compact_boundary`. None of these is documented or stable.
- **`detection.test.js`** drives window detection, which is the denominator of every percentage, plus exact zone-boundary values, the sanitiser, and tail reading. It redirects `HOME` as well as `CLAUDE_PLUGIN_DATA`, because `detectWindow` reads `~/.claude/settings.json` and your real `model` key would otherwise decide the result.
- **`scripts.test.js`** spawns the three scripts for real, with real stdin, each child given an empty `HOME` so your own `autoCompactWindow` cannot move the zone boundaries the fixtures are pinned to. This is where the risk lives: every failure path in the hooks is a deliberate `exit 0`, so without these a totally broken hook produces no signal at all. It asserts exit codes and empty stderr for malformed stdin (`''`, `null`, `123`, `[]`, prose), that the report never exceeds 72 rendered columns in any zone, and that a hostile transcript cannot inject an escape sequence or a fence-breaking backtick.

Data the suite touches is confined to a temp dir, so your real config cannot affect the results — or be affected by them.

The fixes in this suite were mutation-checked: each bug was deliberately
re-introduced to confirm a test caught it. One deliberately is not caught —
bounding the escalated tail read is a cost guard, not a behaviour change, since
`loadEntries` falls back to a full read either way.

## Releasing

Two facts shape this. Users install from the default branch — the marketplace
clone Claude Code keeps is a shallow clone of `main`, with no tags in it — so
**pushing to `main` is what ships**. And installed plugins are cached per version
at `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, with `claude
plugin update` comparing version strings, so **a push that does not move the
version reaches nobody**: every installed copy stays where it is while the update
command reports *already at the latest version* and exits 0.

A release is therefore a bump, then a push, then a tag recording what went out:

```bash
# 1. Bump. Writes both manifests and opens a CHANGELOG entry to fill in.
npm run bump 1.2.0

# 2. Fill in the changelog entry, then check the invariant the lint job checks:
#    the manifests agree and this version is documented.
npm run release:check

# 3. Commit and push. This is the step that actually ships.
git push

# 4. Record it: validates plugin.json against the marketplace entry, refuses on
#    a dirty working tree, and creates context-doctor--v<version>.
claude plugin tag --push plugins/context-doctor
```

Step 1 exists because a release is gated on one string in three files, and the CI
jobs that catch a half-done bump only run after the push. Step 2 is not optional
politeness: `claude plugin update` hands someone new event hooks, and
[`CHANGELOG.md`](CHANGELOG.md) is the only record of what they just got, so the
**lint** job fails the build when the shipping version has no entry.

Rehearse the last step with `claude plugin tag --dry-run plugins/context-doctor`,
which prints the exact `git tag` and `git push` it would run. It has to be given
the plugin directory rather than the repo root: `plugin.json` lives under
`plugins/context-doctor` while `marketplace.json` is at the top, and the command
looks for the former.

The tags deliver nothing — no install path reads them. They exist so that
`git diff context-doctor--v1.1.0 HEAD -- plugins/` can answer *what has changed
since the last release*, which is exactly what the **version** CI job asks on
every push: if the version in `plugin.json` is already tagged and `plugins/` has
moved since, the build fails and says to bump. Before the first tag exists it is
a no-op, and edits to the README or the installers never trip it, because neither
is served from the plugin cache — those come from `raw.githubusercontent.com` at
install time, so they are live on `main` the moment they land.

---

## Housekeeping

Both data directories are pruned automatically, so neither grows without bound:

| Directory        | Kept                                                             |
| :--------------- | :--------------------------------------------------------------- |
| `sessions/`    | newest 50 state files, pruned on the first turn of a new session |
| `compactions/` | newest 30 snapshots, pruned before writing a new one             |

## License

MIT
