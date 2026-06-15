#!/usr/bin/env bash
# Build once, then launch a fresh ephemeral container per session.
# Generated project + logs land in ./sessions/<timestamp> on the host and
# survive container teardown (the container itself is --rm).
set -euo pipefail

IMAGE=localhost/igniteui-testbed:latest
SESSION="$(date +%Y%m%dT%H%M%S)"
OUT="$PWD/sessions/$SESSION"

if [[ "${1:-}" == "build" ]]; then
  podman build -t "$IMAGE" .
  exit 0
fi

mkdir -p "$OUT"
echo "Session artifacts -> $OUT"
echo "Wizard:   http://localhost:8080"
echo "opencode: http://localhost:4096  (after launch)"
echo "App:      http://localhost:5000  (after launch)"

# Host interface to publish on. On Windows the podman machine's port forwarder
# otherwise binds only IPv6 (::1); a browser hitting localhost then connects over
# IPv6 and gets ERR_EMPTY_RESPONSE because forwarding into the WSL VM fails.
# Binding 127.0.0.1 explicitly forces an IPv4 listener that actually forwards.
HOST_BIND="127.0.0.1:"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash / Windows: stop MSYS rewriting the volume arg, give Podman a
    # Windows-style path, and drop the Linux-only :Z and --userns flags.
    export MSYS_NO_PATHCONV=1
    OUT_HOST="$(cygpath -m "$OUT")"   # e.g. D:/work/.../sessions/2026...
    VOL=("-v" "${OUT_HOST}:/work")
    USERNS=()
    ;;
  *)
    # Linux / macOS: SELinux relabel + keep host UID for writable bind mount.
    VOL=("-v" "${OUT}:/work:Z")
    USERNS=("--userns=keep-id")
    ;;
esac

PORTS=(
  -p "${HOST_BIND}8080:8080"
  -p "${HOST_BIND}4096:4096"
  -p "${HOST_BIND}5000:5000"
)

exec podman run --rm -it \
  --name "igniteui-testbed-$SESSION" \
  "${PORTS[@]}" \
  "${VOL[@]}" \
  "${USERNS[@]}" \
  "$IMAGE"