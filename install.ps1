#
# Context Doctor installer (Windows / PowerShell).
#
# Everything here is two `claude` commands plus preflight checks. If you would
# rather not pipe a script into a shell — a reasonable instinct for something
# that installs event hooks — read the README and run those two commands
# yourself. This script exists for convenience, not because it does anything
# you could not do by hand.

$ErrorActionPreference = 'Stop'

$Repo        = if ($env:CONTEXT_DOCTOR_REPO)  { $env:CONTEXT_DOCTOR_REPO }  else { 'briansmith80/claude-code-context' }
$Scope       = if ($env:CONTEXT_DOCTOR_SCOPE) { $env:CONTEXT_DOCTOR_SCOPE } else { 'user' }
$Marketplace = 'context-doctor-marketplace'
$Plugin      = 'context-doctor'

function Fail($msg) { Write-Error "error: $msg"; exit 1 }

# -- Preflight --------------------------------------------------

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail "the 'claude' CLI is not on PATH. Install Claude Code first: https://claude.com/claude-code"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is not on PATH. Context Doctor's hooks are Node scripts and need it."
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) {
  Fail "node 18.13 or newer is required (found $(node -v))."
}

# -- Install ----------------------------------------------------

Write-Host "Adding marketplace $Repo ..."
claude plugin marketplace add $Repo
if ($LASTEXITCODE -ne 0) { Fail "marketplace add failed" }

Write-Host "Installing $Plugin (scope: $Scope) ..."
claude plugin install "$Plugin@$Marketplace" --scope $Scope --yes
if ($LASTEXITCODE -ne 0) { Fail "plugin install failed" }

# -- Next steps -------------------------------------------------

Write-Host @'

Context Doctor installed.

  /context-check    measure the window now and get one recommendation
  /context-setup    configure the auto-compact window (start here)

Restart Claude Code, or run /reload-plugins, to activate the hooks.

Note: this enables the plugin at user scope, so the Stop hook runs in every
session on this machine. Uninstall with:

  claude plugin uninstall context-doctor@context-doctor-marketplace

'@
