#!/usr/bin/env bash
# Build once, then launch a fresh ephemeral container per session.
# Generated project + logs land in ./sessions/<timestamp> on the host and
# survive container teardown (the container itself is --rm).
#
#   ./run.sh build           build the image
#   ./run.sh build --prune   build, then remove dangling (<none>) images left behind
#   ./run.sh                 run a fresh container
set -euo pipefail

IMAGE=localhost/igniteui-testbed:latest
SESSION="$(date +%Y%m%dT%H%M%S)"
OUT="$PWD/sessions/$SESSION"

if [[ "${1:-}" == "build" ]]; then
  # Optional licensed Ignite UI build: write a .npmrc into the build context from the
  # private-feed credentials in .env (an empty file when there are none) so the grid
  # bundles without a watermark. The Containerfile bind-mounts it (never into an image
  # layer) and we delete it right after the build. We use a bind-mounted .npmrc rather
  # than `podman build --secret` because podman's build-secret temp file has a broken
  # path on Windows (containers/podman#23815), which fails the build.
  [[ -f "$PWD/.env" ]] && { set -a; . "$PWD/.env"; set +a; }
  NPMRC="$PWD/.npmrc"
  : > "$NPMRC"                       # always present (empty = trial) so the bind mount resolves
  trap 'rm -f "$NPMRC"' EXIT
  if [[ -n "${IG_NPM_TOKEN:-}" ]]; then
    FEED="//packages.infragistics.com/npm/js-licensed/"
    {
      echo "@infragistics:registry=https://packages.infragistics.com/npm/js-licensed/"
      echo "${FEED}:_auth=${IG_NPM_TOKEN}"
      [[ -n "${IG_NPM_USERNAME:-}" ]] && echo "${FEED}:username=${IG_NPM_USERNAME}"
      [[ -n "${IG_NPM_EMAIL:-}" ]] && echo "${FEED}:email=${IG_NPM_EMAIL}"
    } > "$NPMRC"
    echo "Ignite UI: licensed build (IG_NPM_TOKEN found)."
  else
    echo "Ignite UI: trial build (no IG_NPM_TOKEN)."
  fi
  podman build -t "$IMAGE" .
  # Each rebuild orphans the previous image (untagged <none>). Reclaim that space.
  if [[ "${2:-}" == "--prune" ]]; then
    echo "Pruning dangling images …"
    podman image prune -f
  fi
  exit 0
fi

mkdir -p "$OUT"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $OUT). Mounted at /history inside the container.
HIST="$PWD/sessions/history"
mkdir -p "$HIST"
echo "Session artifacts -> $OUT"
echo "Ignite UI MCP Testbed UI:   http://localhost:8080"
echo "opencode:                   http://localhost:4096  (after launch in interactive mode)"
echo "App:                        http://localhost:5000  (after launch in interactive mode)"

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
    HIST_HOST="$(cygpath -m "$HIST")"
    VOL=("-v" "${OUT_HOST}:/work" "-v" "${HIST_HOST}:/history")
    USERNS=()
    ;;
  *)
    # Linux / macOS: SELinux relabel + keep host UID for writable bind mount.
    VOL=("-v" "${OUT}:/work:Z" "-v" "${HIST}:/history:Z")
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