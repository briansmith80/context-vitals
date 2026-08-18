#!/usr/bin/env sh
#
# Context Doctor installer.
#
# Everything here is two `claude` commands plus preflight checks. If you would
# rather not pipe a script into a shell — a reasonable instinct for something
# that installs event hooks — read the README and run those two commands
# yourself. This script exists for convenience, not because it does anything
# you could not do by hand.

set -eu

# An explicit https:// source, NOT the `owner/repo` shorthand. Claude Code clones
# the shorthand over SSH by default, and it suppresses the interactive host-key
# and passphrase prompts — so anyone authenticated to GitHub over HTTPS only
# (`gh auth login`, Credential Manager, Keychain) gets a hard
# "Permission denied (publickey)" on a public repository that needs no
# credentials at all.
REPO="${CONTEXT_DOCTOR_REPO:-https://github.com/briansmith80/context-doctor}"
MARKETPLACE="context-doctor-marketplace"
PLUGIN="context-doctor"
SCOPE="${CONTEXT_DOCTOR_SCOPE:-user}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────

case "$SCOPE" in
  user|project|local) ;;
  *) fail "CONTEXT_DOCTOR_SCOPE must be user, project or local (got '$SCOPE')." ;;
esac

case "$REPO" in
  -*) fail "CONTEXT_DOCTOR_REPO must not start with '-'." ;;
esac

command -v claude >/dev/null 2>&1 \
  || fail "the 'claude' CLI is not on PATH. Install Claude Code first: https://claude.com/claude-code"

command -v node >/dev/null 2>&1 \
  || fail "node is not on PATH. Context Doctor's hooks are Node scripts and need it."

# package.json requires >=18.13, so check the minor too rather than just the major.
NODE_OK=$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>18||(a===18&&b>=13))?"yes":"no"' 2>/dev/null || echo no)
[ "$NODE_OK" = yes ] \
  || fail "node 18.13 or newer is required (found $(node -v 2>/dev/null || echo none))."

# ── Install or update ────────────────────────────────────────

# Prints one field of this plugin's entry in `claude plugin list --json`, or
# nothing at all when it is not installed at this scope. That JSON is an array
# of {id, scope, version, ...}; the decorated human output carries status
# glyphs and is not worth grepping. node is already required above.
plugin_field() {
  claude plugin list --json 2>/dev/null |
    CD_ID="${PLUGIN}@${MARKETPLACE}" CD_SCOPE="$SCOPE" CD_FIELD="$1" node -e '
        let s = "";
        process.stdin.on("data", d => { s += d; }).on("end", () => {
          try {
            const hit = JSON.parse(s).find(
              p => p.id === process.env.CD_ID && p.scope === process.env.CD_SCOPE
            );
            if (hit && hit[process.env.CD_FIELD] != null) {
              process.stdout.write(String(hit[process.env.CD_FIELD]));
            }
          } catch (e) {
            /* absent or unparseable: print nothing, which reads as "not installed" */
          }
        });
      ' 2>/dev/null || true
}

# Read this before the marketplace is touched, so the branch below reflects
# what was on the machine when the script started.
BEFORE=$(plugin_field version)

say "Adding marketplace ${REPO} ..."
claude plugin marketplace add "$REPO"

# `claude plugin install` is a no-op on a plugin that is already installed: it
# prints "already installed" and exits 0. Re-running this script to pick up a
# new version would therefore print a tick and change nothing, which is worse
# than an error, because nobody investigates a tick.
if [ -n "$BEFORE" ]; then
  # And `marketplace add` short-circuits with "already on disk" once the clone
  # exists, fetching nothing — so on this path the clone has to be refreshed
  # explicitly, or the update below is measured against stale commits.
  say "Refreshing marketplace ${MARKETPLACE} ..."
  claude plugin marketplace update "$MARKETPLACE"

  say "Updating ${PLUGIN} (scope: ${SCOPE}) ..."
  claude plugin update "${PLUGIN}@${MARKETPLACE}" --scope "$SCOPE" --yes
else
  say "Installing ${PLUGIN} (scope: ${SCOPE}) ..."
  claude plugin install "${PLUGIN}@${MARKETPLACE}" --scope "$SCOPE" --yes
fi

AFTER=$(plugin_field version)

# ── Next steps ───────────────────────────────────────────────

say ""
if [ -z "$BEFORE" ]; then
  say "Context Doctor installed${AFTER:+ (${AFTER})}."
elif [ "$BEFORE" = "$AFTER" ]; then
  say "Context Doctor is already at ${AFTER} - nothing to update."
else
  say "Context Doctor updated: ${BEFORE} -> ${AFTER}."
fi

cat <<'NEXT'

  /context-check    measure the window now and get one recommendation
  /context-setup    configure the auto-compact window (start here)

Restart Claude Code, or run /reload-plugins, to activate the hooks.

Update later by re-running this installer, or directly with:

  claude plugin update context-doctor@context-doctor-marketplace

Either way it applies on the next restart. To stop having to do it at all,
turn on auto-update for this marketplace in /plugin.

Note: this enables the plugin at user scope, so the Stop hook runs in every
session on this machine. Uninstall with:

  claude plugin uninstall context-doctor@context-doctor-marketplace

NEXT
