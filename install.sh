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

# ── Install ──────────────────────────────────────────────────

say "Adding marketplace ${REPO} ..."
claude plugin marketplace add "$REPO"

say "Installing ${PLUGIN} (scope: ${SCOPE}) ..."
claude plugin install "${PLUGIN}@${MARKETPLACE}" --scope "$SCOPE" --yes

# ── Next steps ───────────────────────────────────────────────

cat <<'NEXT'

Context Doctor installed.

  /context-check    measure the window now and get one recommendation
  /context-setup    configure the auto-compact window (start here)

Restart Claude Code, or run /reload-plugins, to activate the hooks.

Note: this enables the plugin at user scope, so the Stop hook runs in every
session on this machine. Uninstall with:

  claude plugin uninstall context-doctor@context-doctor-marketplace

NEXT
