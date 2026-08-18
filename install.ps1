#
# Context Doctor installer (Windows / PowerShell).
#
# Everything here is two `claude` commands plus preflight checks. If you would
# rather not pipe a script into a shell — a reasonable instinct for something
# that installs event hooks — read the README and run those two commands
# yourself. This script exists for convenience, not because it does anything
# you could not do by hand.

$ErrorActionPreference = 'Stop'

# An explicit https:// source, NOT the `owner/repo` shorthand. Claude Code clones
# the shorthand over SSH by default and suppresses the interactive host-key and
# passphrase prompts, so an HTTPS-only GitHub setup — the common one on Windows —
# fails with "Permission denied (publickey)" on a public repo.
$Repo        = if ($env:CONTEXT_DOCTOR_REPO)  { $env:CONTEXT_DOCTOR_REPO }  else { 'https://github.com/briansmith80/context-doctor' }
$Scope       = if ($env:CONTEXT_DOCTOR_SCOPE) { $env:CONTEXT_DOCTOR_SCOPE } else { 'user' }
$Marketplace = 'context-doctor-marketplace'
$Plugin      = 'context-doctor'

function Fail($msg) { Write-Error "error: $msg"; exit 1 }

# -- Preflight --------------------------------------------------

if ($Scope -notin @('user', 'project', 'local')) {
  Fail "CONTEXT_DOCTOR_SCOPE must be user, project or local (got '$Scope')."
}
if ($Repo.StartsWith('-')) {
  Fail "CONTEXT_DOCTOR_REPO must not start with '-'."
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Fail "the 'claude' CLI is not on PATH. Install Claude Code first: https://claude.com/claude-code"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is not on PATH. Context Doctor's hooks are Node scripts and need it."
}

# package.json requires >=18.13, so check the minor too. Guarded because a node
# that fails to run at all would otherwise cast $null to 0 and read as "too old"
# with a confusing message.
$nodeOk = $null
try { $nodeOk = node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>18||(a===18&&b>=13))?"yes":"no"' } catch { $nodeOk = $null }
if ($nodeOk -ne 'yes') {
  $found = try { node -v } catch { 'none' }
  Fail "node 18.13 or newer is required (found $found)."
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
