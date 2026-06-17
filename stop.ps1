#!/usr/bin/env pwsh
# Stop running testbed session container(s) started by run.ps1 (PowerShell port of
# stop.sh).
#
#   .\stop.ps1            stop every running igniteui-testbed-* container
#   .\stop.ps1 <session>  stop just igniteui-testbed-<session>
#
# Containers run with --rm, so stopping them also removes them; the session's
# artifacts in .\sessions\<timestamp>\ are on the host and are left untouched.
[CmdletBinding()]
param([string]$Session)

$ErrorActionPreference = 'Stop'
$prefix = 'igniteui-testbed-'

if ($Session) {
  # Allow either the bare session id or the full container name.
  $name  = if ($Session.StartsWith($prefix)) { $Session } else { "$prefix$Session" }
  $names = @($name)
}
else {
  $names = @(podman ps --filter "name=^$prefix" --format '{{.Names}}') |
    Where-Object { $_ -and $_.Trim() }
}

if ($names.Count -eq 0) {
  Write-Host 'No running testbed containers.'
  exit 0
}

foreach ($n in $names) {
  Write-Host "Stopping $n ..."
  podman stop $n | Out-Null
}

Write-Host "Stopped $($names.Count) container(s)."
