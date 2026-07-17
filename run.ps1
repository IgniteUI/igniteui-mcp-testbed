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
#   .\run.ps1 -MatrixConfig <file> -Validate
#                                        validate the config and exit (no matrix run,
#                                        no ports published); exit 0 = valid, 1 = invalid

<#
.SYNOPSIS
Build and run the Ignite UI MCP Testbed container (PowerShell port of run.sh).

.DESCRIPTION
Builds the testbed image, or launches a fresh ephemeral session container publishing
127.0.0.1 ports 8080 (wizard UI), 4096 (opencode web), and 5000 (app dev server).

Reads the gitignored .env for provider API keys forwarded into the container
(ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
CUSTOM_API_KEY) and, at build time only, IG_NPM_TOKEN / IG_NPM_USERNAME / IG_NPM_EMAIL
for the licensed History grid.

Session artifacts land in .\sessions\<timestamp>\; run history, matrix reports, and
screenshots persist in .\sessions\history\ across containers.

.PARAMETER Command
'build' to build the image; 'help' to show this help; omit to run a session container.

.PARAMETER Prune
With build: remove dangling <none> images after a successful build.

.PARAMETER MatrixConfig
Path to a matrix JSON config. Bind-mounted into the container; the matrix auto-runs
headlessly unless the file sets "autoRun": false (the UI prefills from it either way).

.PARAMETER Validate
With -MatrixConfig: validate the config and exit — no matrix run, no ports published.
Exit code 0 = valid, 1 = invalid.

.PARAMETER Help
Show this help and exit.

.EXAMPLE
.\run.ps1 build -Prune

.EXAMPLE
.\run.ps1

.EXAMPLE
.\run.ps1 -MatrixConfig .\matrix.example.json

.EXAMPLE
.\run.ps1 -MatrixConfig .\matrix.json -Validate
#>
[CmdletBinding()]
param([string]$Command, [switch]$Prune, [string]$MatrixConfig, [switch]$Validate, [switch]$Help)

$ErrorActionPreference = 'Stop'

if ($Help -or $Command -eq 'help') {
  Get-Help $PSCommandPath -Detailed
  exit 0
}
$Image = 'localhost/igniteui-testbed:latest'

# Targeted .env parse shared by build and run modes (matching run.sh read_env_keys):
# pulls only the named vars — tolerates `KEY = value` spacing, strips surrounding
# quotes and inline comments, and never executes .env content.
function Read-EnvKeys([string[]]$Names) {
  $envFile = Join-Path $PSScriptRoot '.env'
  if (-not (Test-Path $envFile)) { return }
  $namePattern = $Names -join '|'
  Get-Content $envFile | ForEach-Object {
    if ($_ -match "^\s*($namePattern)\s*=\s*(.+)$") {
      $name = $Matches[1]
      $val = $Matches[2].Trim()
      if ($val -match '^"(.*)"$' -or $val -match "^'(.*)'$") {
        $val = $Matches[1]
      } else {
        $val = ($val -replace '\s#.*$', '').Trim()
      }
      if ($val) { Set-Item -Path "env:$name" -Value $val }
    }
  }
}

if ($Command -eq 'build') {
  # Optional licensed Ignite UI build: write a .npmrc into the build context from the
  # private-feed credentials in .env (an empty file when there are none) so the grid
  # bundles without a watermark. The Containerfile bind-mounts it (never into an image
  # layer) and we delete it right after the build. We use a bind-mounted .npmrc rather
  # than `podman build --secret` because podman's build-secret temp file has a broken
  # path on Windows (containers/podman#23815), which fails the build.
  Read-EnvKeys IG_NPM_TOKEN, IG_NPM_USERNAME, IG_NPM_EMAIL
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
if ($Validate -and -not $mcAbs) {
  Write-Host '-Validate requires -MatrixConfig <file>'
  exit 2
}

# Provider API keys: read them from .env (the same file the build reads) and forward
# any set key vars into the container so a matrix config's apiKeyEnv — or the provider
# default for its model — resolves. `-e VAR` passes the value through without echoing
# it into the process listing.
Read-EnvKeys ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, CUSTOM_API_KEY
$envFlags = @()
foreach ($v in 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'CUSTOM_API_KEY') {
  if (Test-Path "env:$v") { $envFlags += @('-e', $v) }
}
if ($mcAbs) { $envFlags += @('-e', 'MATRIX_CONFIG=/matrix-config.json') }
if ($Validate) { $envFlags += @('-e', 'MATRIX_VALIDATE=1') }

$Session = Get-Date -Format "yyyyMMdd'T'HHmmss"
$Out  = Join-Path $PSScriptRoot "sessions/$Session"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $Out). Mounted at /history inside the container.
$Hist = Join-Path $PSScriptRoot 'sessions/history'
# Host-supplied skills overlaid onto the generated .claude/skills/ (see the wizard's
# "use local skills" toggle / matrix variants). Created empty so the bind mount always
# resolves; drop skill folders (each a SKILL.md + resources) here to override.
$Skills = Join-Path $PSScriptRoot 'local-skills'
# Provider packs (3rd-party library configs) persisted across containers.
# Drop a ProviderPack JSON file here (or use the Configuration tab in the wizard) to
# make additional libraries available in the wizard and matrix views.
$Providers = Join-Path $PSScriptRoot 'providers-data'
# Host-supplied Playwright verification tests, bind-mounted read-only at /tests. A run
# collects tests/shared + tests/<framework> and runs them against the freshly-built app
# in the post-generation verify stage. Created so the mount always resolves.
$Tests = Join-Path $PSScriptRoot 'tests'
New-Item -ItemType Directory -Force -Path $Out, $Hist, $Skills, $Providers, $Tests | Out-Null

if ($Validate) {
  Write-Host "Validating matrix config: $mcAbs"
} else {
  Write-Host "Session artifacts -> $Out"
  Write-Host 'Ignite UI MCP Testbed UI:   http://localhost:8080'
  Write-Host 'opencode:                   http://localhost:4096  (after launch in interactive mode)'
  Write-Host 'App:                        http://localhost:5000  (after launch in interactive mode)'
}

# Host interface to publish on. On Windows the podman machine's port forwarder
# otherwise binds only IPv6 (::1); a browser hitting localhost then connects over
# IPv6 and gets ERR_EMPTY_RESPONSE because forwarding into the WSL VM fails.
# Binding 127.0.0.1 explicitly forces an IPv4 listener that actually forwards.
$HostBind = '127.0.0.1:'

if ($IsLinux -or $IsMacOS) {
  # Linux / macOS (pwsh): SELinux relabel + keep host UID for a writable bind mount.
  $vol    = @('-v', "${Out}:/work:Z", '-v', "${Hist}:/history:Z", '-v', "${Skills}:/local-skills:ro,Z", '-v', "${Providers}:/providers:Z", '-v', "${Tests}:/tests:ro,Z")
  if ($mcAbs) { $vol += @('-v', "${mcAbs}:/matrix-config.json:ro,Z") }
  $userns = @('--userns=keep-id')
}
else {
  # Windows: give Podman a forward-slash path and drop the Linux-only :Z / --userns.
  $outHost       = $Out       -replace '\\', '/'
  $histHost      = $Hist      -replace '\\', '/'
  $skillsHost    = $Skills    -replace '\\', '/'
  $providersHost = $Providers -replace '\\', '/'
  $testsHost     = $Tests     -replace '\\', '/'
  $vol    = @('-v', "${outHost}:/work", '-v', "${histHost}:/history", '-v', "${skillsHost}:/local-skills:ro", '-v', "${providersHost}:/providers", '-v', "${testsHost}:/tests:ro")
  if ($mcAbs) {
    $mcHost = $mcAbs -replace '\\', '/'
    $vol += @('-v', "${mcHost}:/matrix-config.json:ro")
  }
  $userns = @()
}

# Allocate a TTY only when we actually have one, so CI / piped invocations
# (e.g. a matrix-config run driven from a script) don't fail on `-t`.
if ([Console]::IsInputRedirected) { $tty = @('-i') } else { $tty = @('-it') }

# Validate mode publishes no ports (it exits immediately and must not conflict with a
# testbed that is already running).
if ($Validate) {
  $podmanArgs = @('run', '--rm') + $tty + @('--name', "igniteui-testbed-validate-$Session") +
    $vol + $userns + $envFlags + $Image
  podman @podmanArgs
  $rc = $LASTEXITCODE
  # Reap the (empty) session dir the mount needed.
  try { Remove-Item -Path $Out -Recurse -Force -ErrorAction Stop } catch {}
  exit $rc
}

$podmanArgs = @('run', '--rm') + $tty + @(
  '--name', "igniteui-testbed-$Session",
  '-p', "${HostBind}8080:8080",
  '-p', "${HostBind}4096:4096",
  '-p', "${HostBind}5000:5000"
) + $vol + $userns + $envFlags + $Image

podman @podmanArgs
exit $LASTEXITCODE
