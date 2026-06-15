#!/usr/bin/env bash
# Stop running testbed session container(s) started by run.sh.
#
#   ./stop.sh            stop every running igniteui-testbed-* container
#   ./stop.sh <session>  stop just igniteui-testbed-<session>
#
# Containers run with --rm, so stopping them also removes them; the session's
# artifacts in ./sessions/<timestamp>/ are on the host and are left untouched.
set -euo pipefail

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
  podman stop "$n" >/dev/null
done

echo "Stopped ${#names[@]} container(s)."
