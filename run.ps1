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

MCP_CMD_<CLASS> (also read from .env, but an already-set value wins) swaps that class's
MCP server for a locally-built one packed into .\local-mcp\ and installed at build time,
e.g. MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp or
MCP_CMD_THEMING=/opt/local-mcp/bin/my-theming-mcp. Any class works (igniteui, theming,
angular, custom, or one a provider pack declares); a hyphen in a class name becomes an
underscore (mui-docs -> MCP_CMD_MUI_DOCS). Unset, runs use the released server, so one
image serves every arm. IGNITEUI_MCP_CMD is still accepted as an alias for
MCP_CMD_IGNITEUI.

Session artifacts land in .\sessions\<timestamp>\; run history, matrix reports, and
screenshots persist in .\sessions\history\ across containers.

Host folders bind-mounted in: .\local-skills (ro), .\tests (ro), .\providers-data, and
.\prompt-images (read-write — reference images attached to the agent's prompt; the UI's
image uploads land here).

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
  # The Containerfile COPYs .\local-mcp (an optional locally-built MCP server tarball to
  # A/B against the released one), so the dir must exist even when it holds nothing.
  New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'local-mcp') | Out-Null
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
$keyVars = @('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'CUSTOM_API_KEY')
# A matrix config may name a custom env var to hold its key via "apiKeyEnv"; forward
# that var too (else loadMatrixConfig can't resolve it and the run goes out keyless).
if ($mcAbs) {
  $mc = Get-Content -Raw $mcAbs
  if ($mc -match '"apiKeyEnv"\s*:\s*"([^"]+)"') {
    $customKeyEnv = $Matches[1]
    if ($customKeyEnv -match '^[A-Za-z_][A-Za-z0-9_]*$') {
      if ($keyVars -notcontains $customKeyEnv) { $keyVars += $customKeyEnv }
    } else {
      Write-Host "warning: ignoring invalid apiKeyEnv name '$customKeyEnv' in $mcAbs"
    }
  }
}
Read-EnvKeys $keyVars
$envFlags = @()
foreach ($v in $keyVars) {
  if (Test-Path "env:$v") { $envFlags += @('-e', $v) }
}
# Non-secret tunables: diagnostics tunables (src/config.ts): forwarded when set so a run can be tuned, and so DIAGNOSTICS_STREAM_DEBUG=1 can be used to answer which stream provider errors actually arrive on. Values are plain numbers/flags, not secrets.
$diagVars = @('DIAGNOSTICS_STREAM_DEBUG', 'AGENT_STALL_MS', 'AGENT_LOOP_REPEATS', 'DIAGNOSTIC_AGGREGATE_THRESHOLD', 'AGENT_TIMEOUT_MS')
foreach ($v in $diagVars) {
  if (Test-Path "env:$v") { $envFlags += @('-e', "$v=$((Get-Item "env:$v").Value)") }
}

# MCP server tuning, forwarded the same way. MCP_CMD_<CLASS> swaps that class's server
# for a locally-built one installed in the image (e.g.
# MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp); unset means the released server.
# Unlike the keys, an already-set value wins over .env — an A/B sweep sets it per arm
# around the .\run.ps1 call, and .env must not clobber that.
#
# The MCP_CMD_ set is a PREFIX SCAN, not a fixed list: the class space is open-ended (a
# provider pack declares whatever class name it likes), so a new class must work without
# editing this script. Snapshot-then-restore is what makes "already-set wins" true — the
# pattern has to stay a wildcard (a class may be named ONLY in .env) and Read-EnvKeys
# sets unconditionally, so an unprotected value would be silently replaced by .env,
# quietly running both sweep arms on the same binary.
$mcpFixed = @('IGNITEUI_MCP_CMD', 'IGNITEUI_MCP_DOCS_BACKEND_URL', 'IGNITEUI_MCP_DEBUG')
$mcpNames = { @($mcpFixed) + @(Get-ChildItem env: | Where-Object { $_.Name -like 'MCP_CMD_*' } | ForEach-Object Name) | Select-Object -Unique }
$mcpPreset = @{}
# Test-Path is true for a declared-but-EMPTY var, and that is load-bearing: an explicit
# empty means "no override for this class" and has to survive the .env pass. Otherwise a
# caller that cleared the var gets it handed back by .env — exactly how run-ab-sweep.sh's
# released arm silently became a second local arm. Only an explicit empty pins a class to
# its released command; a genuinely unset var is still fair game for .env.
foreach ($v in (& $mcpNames)) { if (Test-Path "env:$v") { $mcpPreset[$v] = (Get-Item "env:$v").Value } }
Read-EnvKeys @('MCP_CMD_[A-Za-z0-9_]+', 'IGNITEUI_MCP_CMD', 'IGNITEUI_MCP_DOCS_BACKEND_URL', 'IGNITEUI_MCP_DEBUG')
foreach ($k in $mcpPreset.Keys) { Set-Item -Path "env:$k" -Value $mcpPreset[$k] }
# Re-scan after .env: it may have introduced MCP_CMD_ classes that were not set before.
foreach ($v in (& $mcpNames)) {
  # Non-empty only, matching run.sh: an explicit empty means "no override", so it must not
  # be forwarded — src/config.ts would treat it as unset anyway, but the container env
  # stays clean and the two scripts agree.
  if ((Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { $envFlags += @('-e', $v) }
}

if ($mcAbs) { $envFlags += @('-e', 'MATRIX_CONFIG=/matrix-config.json') }
if ($Validate) { $envFlags += @('-e', 'MATRIX_VALIDATE=1') }

$Session = Get-Date -Format "yyyyMMdd'T'HHmmss"
$Out  = Join-Path $PSScriptRoot "sessions/$Session"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $Out). Mounted at /history inside the container.
$Hist = Join-Path $PSScriptRoot 'sessions/history'
# Host-supplied skills overlaid onto the generated .agents/skills/ (see the wizard's
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
# Reference images attached to the agent's prompt (design mockups, sketches, screenshots).
# Mounted read-WRITE at /prompt-images — unlike the skills/tests mounts — because the
# wizard's "Prompt images" picker uploads into this same folder, so browser-attached
# images persist on the host and can be reused by a terminal-driven matrix config.
$Images = Join-Path $PSScriptRoot 'prompt-images'
New-Item -ItemType Directory -Force -Path $Out, $Hist, $Skills, $Providers, $Tests, $Images | Out-Null

if ($Validate) {
  Write-Host "Validating matrix config: $mcAbs"
} else {
  Write-Host "Session artifacts -> $Out"
  # Report every overridden class, not just igniteui: this line is what a user reads to
  # confirm which arm is running, so a class it cannot see reads as "released" and would
  # misreport the arm outright.
  $mcpShown = $false
  foreach ($v in (& $mcpNames)) {
    if ($v -in @('IGNITEUI_MCP_DOCS_BACKEND_URL', 'IGNITEUI_MCP_DEBUG')) { continue }
    if (-not (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { continue }
    $cls = if ($v -eq 'IGNITEUI_MCP_CMD') { 'igniteui' } else { ($v -replace '^MCP_CMD_', '').ToLower() }
    Write-Host ("MCP server override:        {0} -> {1}" -f $cls, (Get-Item "env:$v").Value)
    $mcpShown = $true
  }
  if (-not $mcpShown) { Write-Host 'MCP servers:                released (no MCP_CMD_* override)' }
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
  $vol    = @('-v', "${Out}:/work:Z", '-v', "${Hist}:/history:Z", '-v', "${Skills}:/local-skills:ro,Z", '-v', "${Providers}:/providers:Z", '-v', "${Tests}:/tests:ro,Z", '-v', "${Images}:/prompt-images:Z")
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
  $imagesHost    = $Images    -replace '\\', '/'
  $vol    = @('-v', "${outHost}:/work", '-v', "${histHost}:/history", '-v', "${skillsHost}:/local-skills:ro", '-v', "${providersHost}:/providers", '-v', "${testsHost}:/tests:ro", '-v', "${imagesHost}:/prompt-images")
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
