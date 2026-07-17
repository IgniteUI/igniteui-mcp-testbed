#!/usr/bin/env bash
# Stop running testbed session container(s) started by run.sh.
#
#   ./stop.sh            stop every running igniteui-testbed-* container
#   ./stop.sh <session>  stop just igniteui-testbed-<session>
#
# Containers run with --rm, so stopping them also removes them; the session's
# artifacts in ./sessions/<timestamp>/ are on the host and are left untouched.
set -euo pipefail

usage() {
  cat <<'EOF'
Stop running Ignite UI MCP Testbed container(s) started by run.sh.

Usage:
  ./stop.sh                 stop every running igniteui-testbed-* container
  ./stop.sh <session>       stop just igniteui-testbed-<session>
                            (<session> is the timestamp printed at container start,
                            e.g. 20260716T114237; the full container name works too)
  ./stop.sh -h | --help | help   show this help

Containers run with --rm, so stopping also removes them; session artifacts in
./sessions/<timestamp>/ stay on the host, untouched.
EOF
}

case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac

PREFIX=igniteui-testbed-

if [[ -n "${1:-}" ]]; then
  # Allow either the bare session id or the full container name.
  name="$1"; [[ "$name" == "$PREFIX"* ]] || name="${PREFIX}${name}"
  names=("$name")
else
  mapfile -t names < <(podman ps --filter "name=^${PREFIX}" --format '{{.Names}}')
fi

if [[ ${#names[@]} -eq 0 ]]; then
  echo "No running testbed containers."
  exit 0
fi

for n in "${names[@]}"; do
  echo "Stopping $n …"
  # A failed stop (already gone / not running) must not abort the loop under `set -e`,
  # so the remaining containers are still stopped and the summary still prints — matching
  # stop.ps1, where a native non-zero exit doesn't throw.
  podman stop "$n" >/dev/null || true
done

echo "Stopped ${#names[@]} container(s)."
