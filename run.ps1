#!/usr/bin/env pwsh
# Build once, then launch a fresh ephemeral container per session (PowerShell port
# of run.sh). Generated project + logs land in .\sessions\<timestamp> on the host and
# survive container teardown (the container itself is --rm).
#
#   .\run.ps1 build                      build the image
#   .\run.ps1 build -Prune               build, then remove dangling (<none>) images left behind
#   .\run.ps1                            run a fresh container
#   .\run.ps1 -MatrixConfig <file>       run with a matrix JSON config (auto-runs the
#                                        matrix headlessly unless the file sets
#                                        "autoRun": false; the UI reflects the config)
[CmdletBinding()]
param([string]$Command, [switch]$Prune, [string]$MatrixConfig)

$ErrorActionPreference = 'Stop'
$Image = 'localhost/igniteui-testbed:latest'

if ($Command -eq 'build') {
  # Optional licensed Ignite UI build: write a .npmrc into the build context from the
  # private-feed credentials in .env (an empty file when there are none) so the grid
  # bundles without a watermark. The Containerfile bind-mounts it (never into an image
  # layer) and we delete it right after the build. We use a bind-mounted .npmrc rather
  # than `podman build --secret` because podman's build-secret temp file has a broken
  # path on Windows (containers/podman#23815), which fails the build.
  if (Test-Path "$PSScriptRoot/.env") {
    Get-Content "$PSScriptRoot/.env" | ForEach-Object {
      if ($_ -match '^\s*(IG_NPM_TOKEN|IG_NPM_USERNAME|IG_NPM_EMAIL)\s*=\s*(.+)$') {
        Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim()
      }
    }
  }
  $lines = @()
  if ($env:IG_NPM_TOKEN) {
    $feed = '//packages.infragistics.com/npm/js-licensed/'
    $lines += '@infragistics:registry=https://packages.infragistics.com/npm/js-licensed/'
    $lines += "${feed}:_auth=$($env:IG_NPM_TOKEN)"
    if ($env:IG_NPM_USERNAME) { $lines += "${feed}:username=$($env:IG_NPM_USERNAME)" }
    if ($env:IG_NPM_EMAIL)    { $lines += "${feed}:email=$($env:IG_NPM_EMAIL)" }
    Write-Host 'Ignite UI: licensed build (IG_NPM_TOKEN found).'
  } else {
    Write-Host 'Ignite UI: trial build (no IG_NPM_TOKEN).'
  }
  # Always (re)create .npmrc so the Containerfile bind mount resolves; empty => trial.
  $npmrc = Join-Path $PSScriptRoot '.npmrc'
  Set-Content -Path $npmrc -Value ($lines -join "`n") -NoNewline -Encoding ascii
  try {
    podman build -t $Image $PSScriptRoot
    $buildExit = $LASTEXITCODE
  } finally {
    Remove-Item -Path $npmrc -Force -ErrorAction SilentlyContinue
  }
  # Each rebuild orphans the previous image (untagged <none>). Reclaim that space.
  if ($buildExit -eq 0 -and $Prune) {
    Write-Host 'Pruning dangling images ...'
    podman image prune -f
  }
  exit $buildExit
}

# Run-mode arguments: resolve the matrix config to an absolute path up-front.
$mcAbs = $null
if ($MatrixConfig) {
  if (-not (Test-Path $MatrixConfig)) {
    Write-Host "matrix config not found: $MatrixConfig"
    exit 2
  }
  $mcAbs = (Resolve-Path $MatrixConfig).Path
}

# Provider API keys: source .env (the same file the build reads) and forward any set
# key vars into the container so a matrix config's apiKeyEnv — or the provider default
# for its model — resolves. `-e VAR` passes the value through without echoing it into
# the process listing.
if (Test-Path "$PSScriptRoot/.env") {
  Get-Content "$PSScriptRoot/.env" | ForEach-Object {
    if ($_ -match '^\s*(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|CUSTOM_API_KEY)\s*=\s*(.+)$') {
      Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim()
    }
  }
}
$envFlags = @()
foreach ($v in 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'CUSTOM_API_KEY') {
  if (Test-Path "env:$v") { $envFlags += @('-e', $v) }
}
if ($mcAbs) { $envFlags += @('-e', 'MATRIX_CONFIG=/matrix-config.json') }

$Session = Get-Date -Format "yyyyMMdd'T'HHmmss"
$Out  = Join-Path $PSScriptRoot "sessions/$Session"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $Out). Mounted at /history inside the container.
$Hist = Join-Path $PSScriptRoot 'sessions/history'
# Host-supplied skills overlaid onto the generated .claude/skills/ (see the wizard's
# "use local skills" toggle / matrix variants). Created empty so the bind mount always
# resolves; drop skill folders (each a SKILL.md + resources) here to override.
$Skills = Join-Path $PSScriptRoot 'local-skills'
# Host-supplied Playwright verification tests, bind-mounted read-only at /tests. A run
# collects tests/shared + tests/<framework> and runs them against the freshly-built app
# in the post-generation verify stage. Created so the mount always resolves.
$Tests = Join-Path $PSScriptRoot 'tests'
New-Item -ItemType Directory -Force -Path $Out, $Hist, $Skills, $Tests | Out-Null

Write-Host "Session artifacts -> $Out"
Write-Host 'Ignite UI MCP Testbed UI:   http://localhost:8080'
Write-Host 'opencode:                   http://localhost:4096  (after launch in interactive mode)'
Write-Host 'App:                        http://localhost:5000  (after launch in interactive mode)'

# Host interface to publish on. On Windows the podman machine's port forwarder
# otherwise binds only IPv6 (::1); a browser hitting localhost then connects over
# IPv6 and gets ERR_EMPTY_RESPONSE because forwarding into the WSL VM fails.
# Binding 127.0.0.1 explicitly forces an IPv4 listener that actually forwards.
$HostBind = '127.0.0.1:'

if ($IsLinux -or $IsMacOS) {
  # Linux / macOS (pwsh): SELinux relabel + keep host UID for a writable bind mount.
  $vol    = @('-v', "${Out}:/work:Z", '-v', "${Hist}:/history:Z", '-v', "${Skills}:/local-skills:ro,Z", '-v', "${Tests}:/tests:ro,Z")
  if ($mcAbs) { $vol += @('-v', "${mcAbs}:/matrix-config.json:ro,Z") }
  $userns = @('--userns=keep-id')
}
else {
  # Windows: give Podman a forward-slash path and drop the Linux-only :Z / --userns.
  $outHost    = $Out    -replace '\\', '/'
  $histHost   = $Hist   -replace '\\', '/'
  $skillsHost = $Skills -replace '\\', '/'
  $testsHost  = $Tests  -replace '\\', '/'
  $vol    = @('-v', "${outHost}:/work", '-v', "${histHost}:/history", '-v', "${skillsHost}:/local-skills:ro", '-v', "${testsHost}:/tests:ro")
  if ($mcAbs) {
    $mcHost = $mcAbs -replace '\\', '/'
    $vol += @('-v', "${mcHost}:/matrix-config.json:ro")
  }
  $userns = @()
}

# Allocate a TTY only when we actually have one, so CI / piped invocations
# (e.g. a matrix-config run driven from a script) don't fail on `-t`.
if ([Console]::IsInputRedirected) { $tty = @('-i') } else { $tty = @('-it') }

$podmanArgs = @('run', '--rm') + $tty + @(
  '--name', "igniteui-testbed-$Session",
  '-p', "${HostBind}8080:8080",
  '-p', "${HostBind}4096:4096",
  '-p', "${HostBind}5000:5000"
) + $vol + $userns + $envFlags + $Image

podman @podmanArgs
exit $LASTEXITCODE
