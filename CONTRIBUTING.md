# Contributing

Zero dependencies is a hard constraint, not a preference. The plugin installs
event hooks that run on every turn of every session, so the supply chain stays
empty and the tests use Node's built-in runner. Do not add a dependency — not for
linting, not for testing, not for colour.

```bash
npm test        # node --test, built in — Node 20+
```

## What each test file protects

- **`context.test.js`** pins the transcript-shape assumptions the whole plugin rests on — `isSidechain`, `messageId` / `message.id`, `toolUseResult`, `compact_boundary`. None of these is documented or stable.
- **`detection.test.js`** drives window detection, which is the denominator of every percentage, plus exact zone-boundary values, the sanitiser and tail reading. It redirects `HOME` as well as `CLAUDE_PLUGIN_DATA`, because `detectWindow` reads `~/.claude/settings.json` and your real `model` key would otherwise decide the result.
- **`scripts.test.js`** spawns the three scripts for real. This is where the risk lives: every failure path in the hooks is a deliberate `exit 0`, so without these a totally broken hook produces no signal at all. It asserts exit codes and empty stderr for malformed stdin (`''`, `null`, `123`, `[]`, prose), that the report never exceeds 72 rendered columns in any zone, and that a hostile transcript cannot inject an escape sequence or a fence-breaking backtick.

Data the suite touches is confined to a temp dir, so your real config cannot
affect the results — or be affected by them. Fixes here are mutation-checked: each
bug is deliberately re-introduced to confirm a test catches it.

The README's sample report is generated, never hand-written. Regenerate it with:

```bash
node plugins/context-vitals/test/fixtures/make-fixture.js
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000 \
  node plugins/context-vitals/scripts/context-report.js \
  --transcript plugins/context-vitals/test/fixtures/showcase.jsonl
```

## Releasing

Two facts shape this. Users install from the default branch — the marketplace
clone is a shallow clone of `main`, with no tags in it — so **pushing to `main` is
what ships**. And installed plugins are cached per version, with `claude plugin
update` comparing version strings, so **a push that does not move the version
reaches nobody**: every installed copy stays put while the update command reports
*already at the latest version* and exits 0.

```bash
# 1. Bump. Writes both manifests and opens a CHANGELOG entry to fill in.
npm run bump 1.4.0

# 2. Fill in the changelog entry, then check what the lint job checks:
#    the manifests agree and this version is documented.
npm run release:check
npm test

# 3. Commit and push. This is the step that actually ships.
git push

# 4. Tag it. Validates plugin.json against the marketplace entry, refuses on a
#    dirty tree, and creates context-vitals--v<version>.
claude plugin tag --push plugins/context-vitals

# 5. Publish the GitHub Release, so the tag carries its notes. Put this version
#    section of CHANGELOG.md in notes.md first.
gh release create context-vitals--v1.4.0 \
  --title "Context Vitals 1.4.0" \
  --notes-file notes.md \
  --latest --verify-tag
```

Step 1 exists because a release is gated on one string in three files, and the CI
jobs that catch a half-done bump only run after the push. Step 2 is not optional
politeness: `claude plugin update` hands someone new event hooks, and
[`CHANGELOG.md`](CHANGELOG.md) is the only record of what they just got, so the
**lint** job fails the build when the shipping version has no entry.

Step 5 is the one nothing enforces — no CI job checks it and no script creates it,
which is exactly why 1.2.0 shipped with a tag and no release. `--verify-tag`
refuses if step 4 has not run.

Rehearse step 4 with `claude plugin tag --dry-run plugins/context-vitals`, which
prints the exact `git tag` and `git push` it would run. It needs the plugin
directory, not the repo root, because `plugin.json` lives under
`plugins/context-vitals` while `marketplace.json` is at the top.

Tags deliver nothing — no install path reads them. They exist so that `git diff
context-vitals--v1.3.0 HEAD -- plugins/` can answer *what has changed since the
last release*, which is what the **version** CI job asks on every push: if the
version in `plugin.json` is already tagged and `plugins/` has moved since, the
build fails and says to bump. Edits to the README or the installers never trip it,
because neither is served from the plugin cache — those come from
`raw.githubusercontent.com`, so they are live on `main` the moment they land.

## What CI enforces, and why

Every invariant, and the bug that put it there, is tabulated in
[CLAUDE.md](CLAUDE.md#invariants-ci-enforces-and-why). That table is the single
source — it is loaded into context on every session, so it lives there rather than
here. Each row exists because it broke once: do not work around one, fix the
cause.
