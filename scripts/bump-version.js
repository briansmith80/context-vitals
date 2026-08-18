#!/usr/bin/env node
'use strict';
//
// bump-version.js — move the version in every place that has to agree.
//
//   npm run bump 1.2.0
//   npm run bump 1.2.0 -- --check    (verify only, changes nothing)
//
// A release is gated on one string. Installed plugins are cached per version at
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ and
// `claude plugin update` compares versions, so a push that does not move the
// version reaches nobody while the update command reports "already at the latest
// version" and exits 0. Nothing else notices.
//
// Three files therefore have to move together — plugin.json (the one that
// delivers), package.json (which the lint job asserts agrees with it), and
// CHANGELOG.md (which is the only record of what a user is being given). Doing
// that by hand is three chances to ship a half-release, and the CI jobs that
// catch it only run after the push. This does all three, or refuses.
//
// Zero dependencies, like everything else here.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGIN_MANIFEST = path.join(ROOT, 'plugins', 'context-doctor', '.claude-plugin', 'plugin.json');
const PACKAGE_MANIFEST = path.join(ROOT, 'package.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function die(msg) {
  process.stderr.write('bump: ' + msg + '\n');
  process.exit(1);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { die('cannot read ' + path.relative(ROOT, file)); }
}

/** Rewrite one top-level "version" value, leaving the rest of the file byte-identical.
 *  A JSON.parse/stringify round-trip would reformat both manifests and bury the
 *  actual change in a whitespace diff. */
function setVersion(file, version) {
  const before = readText(file);
  const after = before.replace(/("version"\s*:\s*")[^"]*(")/, '$1' + version + '$2');
  if (after === before) die(path.relative(ROOT, file) + ' has no "version" field to move');
  return { file, before, after };
}

function versionIn(file) {
  const m = /"version"\s*:\s*"([^"]*)"/.exec(readText(file));
  return m ? m[1] : null;
}

/** The date the entry gets stamped with. Deliberately the local date: a release
 *  is a thing a person did on a day, not a UTC instant. */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function changelogHas(version) {
  // Accepts `## [1.2.0]` and `## 1.2.0`, with or without a trailing date, so the
  // check does not fight a hand-edited heading over punctuation.
  const escaped = version.replace(/\./g, '\\.');
  return new RegExp('^##\\s+\\[?' + escaped + '\\]?(\\s|$)', 'm').test(readText(CHANGELOG));
}

// ── --check: the invariant, for CI and for a pre-push sanity pass ──

const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  const pluginVersion = versionIn(PLUGIN_MANIFEST);
  const packageVersion = versionIn(PACKAGE_MANIFEST);

  if (!pluginVersion) die('no version in plugin.json');
  if (pluginVersion !== packageVersion) {
    die('version drift: plugin.json ' + pluginVersion + ' vs package.json ' + packageVersion);
  }
  if (!changelogHas(pluginVersion)) {
    die('CHANGELOG.md has no entry for ' + pluginVersion + '.\n'
      + '       Installed copies are cached per version, so this is the only record of\n'
      + '       what the update gives someone. Add a "## [' + pluginVersion + '] - '
      + today() + '" section,\n'
      + '       or run: npm run bump ' + pluginVersion);
  }
  process.stdout.write('ok ' + pluginVersion + ' (manifests agree, changelog has an entry)\n');
  process.exit(0);
}

// ── The bump ──────────────────────────────────────────────────

const target = argv.find((a) => !a.startsWith('-'));
if (!target) {
  die('usage: npm run bump <version>   (e.g. npm run bump 1.2.0)\n'
    + '       npm run bump 1.2.0 -- --check   verifies without changing anything');
}
if (!SEMVER.test(target)) die(JSON.stringify(target) + ' is not a bare semver version like 1.2.0');

const current = versionIn(PLUGIN_MANIFEST);
if (current === target) die('plugin.json is already ' + target + ' — nothing to bump');

// Refuse to go backwards by accident. Deliberate rollbacks are rare enough to
// deserve doing by hand.
const parts = (v) => v.split('.').map(Number);
const [cMaj, cMin, cPat] = parts(current);
const [tMaj, tMin, tPat] = parts(target);
if (tMaj * 1e6 + tMin * 1e3 + tPat < cMaj * 1e6 + cMin * 1e3 + cPat) {
  die(target + ' is lower than the current ' + current + '. Edit the manifests by hand if that is intended.');
}

const edits = [setVersion(PLUGIN_MANIFEST, target), setVersion(PACKAGE_MANIFEST, target)];

// The changelog entry is written only if it is missing, so re-running the bump
// after editing the notes cannot clobber them.
let changelogNote;
if (changelogHas(target)) {
  changelogNote = 'CHANGELOG.md already has a ' + target + ' entry — left alone';
} else {
  const before = readText(CHANGELOG);
  // Insert above the newest existing entry, or at the end if there is none.
  const firstEntry = before.search(/^##\s+\[?\d+\.\d+\.\d+/m);
  const stub = '## [' + target + '] - ' + today() + '\n\n'
    + '### Fixed\n\n- TODO: what a user who updates gets. Delete the headings you do not need.\n\n'
    + '### Added\n\n- TODO\n\n'
    + '### Changed\n\n- TODO\n\n';
  const after = firstEntry === -1
    ? before.replace(/\n*$/, '\n\n') + stub
    : before.slice(0, firstEntry) + stub + before.slice(firstEntry);
  edits.push({ file: CHANGELOG, before, after });
  changelogNote = 'CHANGELOG.md: added a ' + target + ' entry — fill in the TODOs before committing';
}

for (const e of edits) fs.writeFileSync(e.file, e.after, 'utf8');

process.stdout.write([
  'bumped ' + current + ' -> ' + target,
  '  ' + path.relative(ROOT, PLUGIN_MANIFEST).replace(/\\/g, '/') + '  (this is the one that delivers)',
  '  ' + path.relative(ROOT, PACKAGE_MANIFEST).replace(/\\/g, '/'),
  '  ' + changelogNote,
  '',
  'Next: fill in the changelog, run npm test, then commit and push — pushing to',
  'main is what ships. Record it afterwards with:',
  '  claude plugin tag --push plugins/context-doctor',
  '',
].join('\n'));
