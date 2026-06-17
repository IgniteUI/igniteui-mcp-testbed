#!/usr/bin/env pwsh
# Build once, then launch a fresh ephemeral container per session (PowerShell port
# of run.sh). Generated project + logs land in .\sessions\<timestamp> on the host and
# survive container teardown (the container itself is --rm).
#
#   .\run.ps1 build           build the image
#   .\run.ps1 build -Prune    build, then remove dangling (<none>) images left behind
#   .\run.ps1                 run a fresh container
[CmdletBinding()]
param([string]$Command, [switch]$Prune)

$ErrorActionPreference = 'Stop'
$Image = 'localhost/igniteui-testbed:latest'

if ($Command -eq 'build') {
  podman build -t $Image $PSScriptRoot
  $buildExit = $LASTEXITCODE
  # Each rebuild orphans the previous image (untagged <none>). Reclaim that space.
  if ($buildExit -eq 0 -and $Prune) {
    Write-Host 'Pruning dangling images ...'
    podman image prune -f
  }
  exit $buildExit
}

$Session = Get-Date -Format "yyyyMMdd'T'HHmmss"
$Out  = Join-Path $PSScriptRoot "sessions/$Session"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $Out). Mounted at /history inside the container.
$Hist = Join-Path $PSScriptRoot 'sessions/history'
New-Item -ItemType Directory -Force -Path $Out, $Hist | Out-Null

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
  $vol    = @('-v', "${Out}:/work:Z", '-v', "${Hist}:/history:Z")
  $userns = @('--userns=keep-id')
}
else {
  # Windows: give Podman a forward-slash path and drop the Linux-only :Z / --userns.
  $outHost  = $Out  -replace '\\', '/'
  $histHost = $Hist -replace '\\', '/'
  $vol    = @('-v', "${outHost}:/work", '-v', "${histHost}:/history")
  $userns = @()
}

$podmanArgs = @(
  'run', '--rm', '-it',
  '--name', "igniteui-testbed-$Session",
  '-p', "${HostBind}8080:8080",
  '-p', "${HostBind}4096:4096",
  '-p', "${HostBind}5000:5000"
) + $vol + $userns + $Image

podman @podmanArgs
exit $LASTEXITCODE
