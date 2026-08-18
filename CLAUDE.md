# context-doctor

A Claude Code plugin that reads the live context window from the session
transcript and says whether to `/clear`, `/compact` (with a drafted focus line),
prune tool output, or carry on. Its whole claim is that the headline number is
**measured, not estimated** — so anything that could make a number wrong, or
imply a precision it does not have, is a defect rather than a rough edge.

One marketplace, one plugin, **zero dependencies**. That is a constraint, not an
accident: it installs event hooks that run on every turn of every session, so the
supply chain stays empty and the tests use Node's built-in runner. Do not add a
dependency — not for linting, not for testing, not for colour.

## Before you change anything

1. `npm test` — 82 tests, must be green before you start and after you finish.
2. Read the top entry of [CHANGELOG.md](CHANGELOG.md). It is written for users,
   and it is the fastest way to know what the last release actually changed.

## Invariants CI enforces, and why

Each of these exists because it broke once. Do not work around one; fix the cause.

| Invariant | Why it is load-bearing |
| :-- | :-- |
| `plugin.json` version must move when `plugins/**` changes | Installed plugins are cached per version and `claude plugin update` compares version strings. A push without a bump reaches **nobody** while the update command reports "already at the latest version". |
| `plugin.json` and `package.json` versions agree | Two sources of truth drift silently. |
| The shipping version has a `CHANGELOG.md` entry | `claude plugin update` hands someone new event hooks; the changelog is the only record of what they got. |
| `install.sh` is LF, `install.ps1` is CRLF | A CRLF `install.sh` dies with `bad interpreter: /usr/bin/env sh^M` when piped to a shell — which is exactly how the README serves it. |
| `install.sh` is POSIX `sh` and shellcheck-clean | It is piped into `sh`, not bash. No `[[`, no `readlink -f`, no `sed -i`. |
| `install.ps1` parses under Windows PowerShell 5.1 | 5.1 strips inner quotes from a native command's arguments. That shipped once and broke every Windows install. |
| Test names are ASCII | Test names are machine-consumed by TAP readers. |
| The report never exceeds 72 rendered columns | Column arithmetic is done in *rendered* width, not `String.length`: `⛔` has length 1 and renders 2. |
| `showcase.jsonl` is byte-reproducible from `make-fixture.js` | The README's sample output is a real capture. A hand-edited sample drifts from the renderer and then misrepresents a measurement tool. |
| Node 20 / 22 / 24 on Linux, macOS, Windows | `engines` claims a floor; CI has to actually test it. |

## How to work in this repo

**Never commit, push, or tag without Brian explicitly saying so.** Build the
change, leave it in the working tree, and hand back the exact commands. Being
asked to build release machinery is not authorisation to use it. Say plainly in
your report that nothing was committed.

**A fix is not done until a test fails without it.** Then mutation-check it:
re-introduce the bug verbatim, confirm the new test fails, restore. The suite's
value is that every failure path in the hooks is a deliberate `exit 0`, so a
totally broken hook otherwise produces no signal at all.

**Hooks must never fail loudly.** `stop-nudge.js` runs on every turn of every
session at user scope. Every path exits 0; a stack trace there is noise on every
turn. `pre-compact.js` must never block — blocking an auto-compaction drives the
conversation into the model's hard limit, which is worse than a lossy summary.

**Everything transcript- or config-derived goes through `lib.safe()`** before it
reaches output. The `/context-check` skill instructs the model to relay the
report verbatim inside a code fence, so a raw `ESC` could repaint the terminal or
forge report rows, and three backticks could break out of the fence into prose.

**Never state a bound as a measurement.** If the auto-compact trigger was not
configured, the runway is `at most` that much. If the window was inferred, say
so. The `METHOD` block exists to carry that provenance.

**Comments explain why, not what** — usually which bug or which undocumented
Claude Code behaviour forced the shape of the code. Match that density.

**Regenerate, never hand-edit, generated text.** The README's sample report comes
from `make-fixture.js` plus the renderer; CI diffs it.

## Releasing

```bash
npm run bump 1.3.0        # both manifests + a CHANGELOG entry to fill in
# fill in the changelog entry
npm run release:check     # the invariant the lint job checks
npm test
git push                  # THIS is what ships — ask first
claude plugin tag --push plugins/context-doctor   # provenance, not delivery
```

Users install from the default branch. The marketplace clone Claude Code keeps is
a shallow clone of `main` with no tags in it, so **pushing to `main` is what
ships** and tags only record what went out. Changes to the README or the
installers are live the moment they land — they are served from
`raw.githubusercontent.com`, not the plugin cache — so they do not need a bump.

## Layout

`plugins/context-doctor/lib/context.js` is the core: transcript parsing, window
detection, zone classification, and the shared session-state and formatting
helpers both hooks use. `scripts/` holds the two hooks and the `/context-check`
data source. `skills/` holds the two slash commands, and
`skills/context-check/reference/thresholds.md` documents the evidence behind
every threshold, with primary sources — update it if you move a number.

The README has the full tree, the measurement method, and the known limits. Read
its **Known limits** section before claiming the plugin has a limitation; it is
probably already documented there, in more detail.

## When you are unsure

Ask, and bring a recommendation rather than a menu. Guessing at a number, a
threshold, or a Claude Code behaviour is the one failure mode this project cannot
absorb — verify it against the CLI or the docs, or say that you could not.
