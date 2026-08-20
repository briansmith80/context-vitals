# Changelog

All notable changes to the **Context Vitals** plugin.

The version in `plugins/context-vitals/.claude-plugin/plugin.json` is what
actually delivers a release: installed copies are cached per version at
`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and
`claude plugin update` compares version strings — so a push that does not move
the version reaches nobody. Every version that ships gets an entry here, and the
`lint` CI job fails the build if the current version has none.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are [semantic](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-08-20

### Changed

- **Renamed to Context Vitals — identifier and all.** The old name filed the
  plugin under the wrong idea: in CLI convention `doctor` means *check my install
  for config problems* (`brew doctor`, `flutter doctor`), while this reads a live
  runtime quantity and reports it with its provenance. "Vitals" is what the
  report already called its own two readings, so the new name is vocabulary the
  tool was using anyway.

  This is a breaking rename, taken deliberately before the plugin had users.
  Everything moved:

  | | from | to |
  | :-- | :-- | :-- |
  | Plugin | `context-doctor` | `context-vitals` |
  | Marketplace | `context-doctor-marketplace` | `context-vitals-marketplace` |
  | Directory | `plugins/context-doctor/` | `plugins/context-vitals/` |
  | Config | `~/.claude/context-doctor/` | `~/.claude/context-vitals/` |
  | Tags | `context-doctor--v*` | `context-vitals--v*` |
  | Installer env | `CONTEXT_DOCTOR_REPO`, `_SCOPE` | `CONTEXT_VITALS_REPO`, `_SCOPE` |

  There is no migration path and none is offered. Remove the old plugin and
  marketplace, then install the new one; `claude plugin update` will not carry
  you across, because the plugin it knew no longer exists. Settings under
  `~/.claude/context-doctor/` are no longer read and can be deleted.

- **The two-reading table is headed `MEASURE`, not `VITALS`.** With the plugin
  itself called Context Vitals, the old header made one word name both the tool
  and a single table inside its report.

### Added

- **A test pinning the Stop nudge's self-identification.** Claude Code labels
  hook output by event, so the message text is the only thing telling you which
  Stop hook is speaking. Nothing guarded that, which meant a rename could have
  dropped the name silently.

## [1.2.0] - 2026-08-18

### Fixed

- **A queued auto-compaction announcement could be written where the Stop hook
  never looked.** `pre-compact.js` and `stop-nudge.js` each turned the session id
  into a filename separately, and differently: one mapped an id of `.` or `..`
  onto `unknown` and the other did not. For those ids the two hooks addressed
  different files, so the announcement was queued into one and read from the
  other, and never delivered. Both now go through one implementation in
  `lib/context.js`, covered by a test that drives the real scripts.
- The pre-compaction snapshot filename and the session state key disagreed on
  their fallback for a missing session id (`session` vs `unknown`). One
  sanitiser, one answer.

### Added

- **`/context-check` now names any `config.json` setting it had to ignore.**
  Every key fails closed, which is correct and used to be silent — leaving you
  believing a setting was in force. The `METHOD` block now leads with a `config`
  row naming the rejected value *and* what is in force instead, for: a quoted
  boolean (`"quiet": "true"` silences nothing), an unknown `minZone` (falls back
  to `watch`), an unparseable `contextWindow` (falls through to detection), a
  key that does not exist (`minzone` is not `minZone`), and a config file that
  is not a usable JSON object — a trailing comma reverts all three settings at
  once. Reported on the no-reading path too, where a broken config file is the
  likeliest reason there is nothing to show.
- `configIssues` in the `--format json` output, for callers that want the same
  information structured.
- Coverage is now reported in CI, on the newest Node leg.

### Changed

- **Node 20 is the floor** (was 18.13). Node 18 reached end of life in April
  2025, and testing an unsupported runtime buys nothing. CI runs 20, 22 and 24;
  both installers refuse below 20 with that message rather than installing
  something untested on that runtime.
- The two hooks share one token formatter and one set of session-state
  accessors, instead of a copy each. `context-report.js` keeps its own
  `fmtT`/`fmtTP`, which round negatives away from zero and carry a decimal for
  the two figures the report asks you to trust.
- `npm run bump <version>` writes both manifests and opens the changelog entry,
  so a release cannot half-happen.

### Internal

- 82 tests, up from 67. The state-file regression above was mutation-checked:
  restoring the old key logic verbatim fails the new test.

## [1.1.0] - 2026-08-18

### Fixed

- **Transcript selection could report another project's session as yours.** The
  project-directory slug was reconstructed with a regex whose `+` collapsed
  `C:\` into a single dash, so the exact-match branch was dead on every
  platform and a fallback that matched any directory merely *ending with* the
  current folder's basename was the only live path. Nothing is reconstructed
  now: match `CLAUDE_CODE_SESSION_ID`, else match the `cwd` each transcript
  records about itself, else report no reading.
- **The headline was the pre-compaction total until Claude next replied.** Usage
  was read from the whole transcript while only the breakdown used the live
  slice, so a compacted session read 600K/DEGRADED when 21K survived. The
  compaction is applied before measuring now, falling back to the boundary's own
  `postTokens` and naming that provenance in the report.
- **The PreCompact hook's user-facing half reached nobody.** Claude Code
  discards a PreCompact `systemMessage`, so the auto-compaction warning and the
  snapshot path were written and dropped. The announcement is queued into
  session state and delivered by the Stop hook, whose `systemMessage` is shown.
- The pressure ladder ran on a guessed window with no configured trigger, giving
  a confident CRITICAL at 180K that flipped to WATCH one token later. It is
  suppressed when both of its inputs are inventions, and an unconfigured trigger
  point is labelled an upper bound rather than an estimate.
- Transcript-derived text reached stdout and the snapshots with raw escape
  sequences and backticks intact, able to repaint the terminal, forge report
  rows, or close the code fence the skill reproduces verbatim.
- The character estimate silently clamped a negative residual and printed bars
  past full. Over-attribution is now disclosed instead.
- A `null` hook payload crashed the Stop hook on every turn.
- Config was read from `~/.claude/context-doctor` while installed plugins use
  `CLAUDE_PLUGIN_DATA`, which the Bash tool does not export — so the hooks and
  the report read two different files.
- The installers used the `owner/repo` shorthand, which clones over SSH with
  interactive prompts suppressed, hard-failing for HTTPS-only users on a public
  repository that needs no credentials.
- **`install.ps1` had never worked.** Windows PowerShell 5.1 strips the inner
  quotes from a native command's arguments, so the Node preflight's `split(".")`
  reached `node` as `split(.)`, died, and was reported as "node 18.13 or newer
  is required (found v22.22.0)".
- **The installers no-opped instead of updating.** `claude plugin install` prints
  "already installed" and exits 0, so re-running an installer to pick up a new
  version reported success and changed nothing. Both now branch to
  `claude plugin update`, refreshing the marketplace clone first.
- **`npm test` never ran on two of the three supported Node versions.**
  `node --test` does not expand globs before v21, so the quoted pattern matched
  nothing; and Node 18.13's TAP lexer aborted on a non-ASCII test name.
- `scripts.test.js` let spawned children read the developer's real
  `~/.claude/settings.json`, so a local `autoCompactWindow` of 400K read three
  ACT fixtures as CRITICAL while CI stayed green.

### Changed

- The report was restyled: one gauge carrying both ladders, a vitals table
  marking which ladder bound the verdict, and a `METHOD` block for provenance.
- The 52.9% figure behind the central thesis is an oracle that decides by
  consulting the correct answer. Relabelled as an upper bound, with its
  single-model, single-benchmark scope stated.

### Added

- A `version` CI job asserting that if the current version is already tagged,
  `plugins/` is identical to that tag — so a change that would reach nobody
  fails the build instead.
- Line endings pinned per file type, with CI asserting them: a CRLF
  `install.sh` fails with `bad interpreter: /usr/bin/env sh^M` when piped to a
  shell, which is exactly how the README serves it.

## [1.0.0] - 2026-08-18

Initial release.

- `/context-check` — a measured reading of the live context window, from the
  transcript's own usage records, plus a character-derived category breakdown,
  the largest tool results, re-read files, and one recommendation.
- `/context-setup` — configure the auto-compact window and the plugin's own
  settings.
- Stop-hook nudges, emitted only on a crossing into a worse zone, so one climb
  through the ladder costs at most four messages.
- PreCompact recovery snapshots, recording what was in context before a
  compaction discarded it.
- Two-zone model: absolute-size degradation and window pressure, reported as
  whichever binds.
- Zero dependencies. `thresholds.md` documents the evidence behind each
  threshold, with primary sources.

[1.3.0]: https://github.com/briansmith80/context-vitals/compare/context-doctor--v1.2.0...context-vitals--v1.3.0
[1.2.0]: https://github.com/briansmith80/context-vitals/compare/context-doctor--v1.1.0...context-doctor--v1.2.0
[1.1.0]: https://github.com/briansmith80/context-vitals/releases/tag/context-doctor--v1.1.0
[1.0.0]: https://github.com/briansmith80/context-vitals/commit/1b2027f
