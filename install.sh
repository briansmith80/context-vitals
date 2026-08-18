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

REPO="${CONTEXT_DOCTOR_REPO:-briansmith80/context-doctor}"
MARKETPLACE="context-doctor-marketplace"
PLUGIN="context-doctor"
SCOPE="${CONTEXT_DOCTOR_SCOPE:-user}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 \
  || fail "the 'claude' CLI is not on PATH. Install Claude Code first: https://claude.com/claude-code"

command -v node >/dev/null 2>&1 \
  || fail "node is not on PATH. Context Doctor's hooks are Node scripts and need it."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null \
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
