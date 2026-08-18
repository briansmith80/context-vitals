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

# package.json requires >=18.13, so check the minor too. The version test runs as
# an exit code rather than printed text for two reasons: Windows PowerShell 5.1
# strips the inner double quotes out of a native command's arguments, so a JS
# snippet containing "." reaches node as split(.) and dies with a syntax error
# (which then reads as "your node is too old" while naming a version that is not);
# and node -p colourizes a bare number with ANSI escapes, so the output would not
# compare equal to 1 either. Nothing here is quoted, and nothing is parsed.
node -e 'const v=process.versions.node.split(/[.]/).map(Number); process.exit((v[0]>18||(v[0]===18&&v[1]>=13))?0:1)'
if ($LASTEXITCODE -ne 0) {
  $found = try { node -v } catch { 'none' }
  Fail "node 18.13 or newer is required (found $found)."
}

# -- Install or update ------------------------------------------

# Returns one field of this plugin's entry in `claude plugin list --json`, or an
# empty string when it is not installed at this scope. That JSON is an array of
# {id, scope, version, ...}; the decorated human output carries status glyphs and
# is not worth parsing. stderr is deliberately not redirected here: in Windows
# PowerShell 5.1 redirecting a native command's stderr turns each line into an
# ErrorRecord, which $ErrorActionPreference = 'Stop' would then throw on.
function Get-PluginField($Field) {
  try {
    $raw = (claude plugin list --json) -join "`n"
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return '' }
    # ConvertFrom-Json in Windows PowerShell 5.1 emits a JSON array as a single
    # Object[] rather than enumerating it, so it has to be assigned before it is
    # piped. Piping it straight into Where-Object hands the filter one array that
    # matches nothing, and the field read then yields every plugin version at once.
    $list  = $raw | ConvertFrom-Json
    $entry = $list |
      Where-Object { $_.id -eq "$Plugin@$Marketplace" -and $_.scope -eq $Scope } |
      Select-Object -First 1
    if ($entry -and $null -ne $entry.$Field) { return [string]$entry.$Field }
  } catch { }
  return ''
}

# Read this before the marketplace is touched, so the branch below reflects what
# was on the machine when the script started.
$before = Get-PluginField 'version'

Write-Host "Adding marketplace $Repo ..."
claude plugin marketplace add $Repo
if ($LASTEXITCODE -ne 0) { Fail "marketplace add failed" }

# `claude plugin install` is a no-op on a plugin that is already installed: it
# prints "already installed" and exits 0. Re-running this script to pick up a new
# version would therefore print a tick and change nothing, which is worse than an
# error, because nobody investigates a tick.
if ($before) {
  # And `marketplace add` short-circuits with "already on disk" once the clone
  # exists, fetching nothing - so on this path the clone has to be refreshed
  # explicitly, or the update below is measured against stale commits.
  Write-Host "Refreshing marketplace $Marketplace ..."
  claude plugin marketplace update $Marketplace
  if ($LASTEXITCODE -ne 0) { Fail "marketplace update failed" }

  Write-Host "Updating $Plugin (scope: $Scope) ..."
  claude plugin update "$Plugin@$Marketplace" --scope $Scope --yes
  if ($LASTEXITCODE -ne 0) { Fail "plugin update failed" }
} else {
  Write-Host "Installing $Plugin (scope: $Scope) ..."
  claude plugin install "$Plugin@$Marketplace" --scope $Scope --yes
  if ($LASTEXITCODE -ne 0) { Fail "plugin install failed" }
}

$after = Get-PluginField 'version'

# -- Next steps -------------------------------------------------

Write-Host ''
if (-not $before) {
  if ($after) { Write-Host "Context Doctor installed ($after)." }
  else        { Write-Host 'Context Doctor installed.' }
} elseif ($before -eq $after) {
  Write-Host "Context Doctor is already at $after - nothing to update."
} else {
  Write-Host "Context Doctor updated: $before -> $after."
}

Write-Host @'

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

'@
