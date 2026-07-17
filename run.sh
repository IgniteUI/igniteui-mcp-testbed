#!/usr/bin/env bash
# Build once, then launch a fresh ephemeral container per session.
# Generated project + logs land in ./sessions/<timestamp> on the host and
# survive container teardown (the container itself is --rm).
#
#   ./run.sh build                      build the image
#   ./run.sh build --prune              build, then remove dangling (<none>) images left behind
#   ./run.sh                            run a fresh container
#   ./run.sh --matrix-config <file>     run with a matrix JSON config (auto-runs the
#                                       matrix headlessly unless the file sets
#                                       "autoRun": false; the UI reflects the config)
#   ./run.sh --matrix-config <file> --validate
#                                       validate the config and exit (no matrix run,
#                                       no ports published); exit 0 = valid, 1 = invalid
set -euo pipefail

usage() {
  cat <<'EOF'
Ignite UI MCP Testbed — build and run the containerized testbed.

Usage:
  ./run.sh build [--prune]         build the image
                                   (--prune: then remove dangling <none> images)
  ./run.sh                         run a fresh ephemeral session container
  ./run.sh --matrix-config <file>  run + execute a matrix from a JSON config
                                   (auto-runs headlessly unless the file sets
                                   "autoRun": false; the UI prefills from it)
  ./run.sh --matrix-config <file> --validate
                                   validate the config and exit — no matrix run,
                                   no ports published (exit 0 = valid, 1 = invalid)
  ./run.sh -h | --help | help      show this help

Ports (published on 127.0.0.1): 8080 wizard UI · 4096 opencode web · 5000 app dev server

.env (gitignored) is read for:
  - provider API keys forwarded into the container: ANTHROPIC_API_KEY,
    OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, CUSTOM_API_KEY
  - IG_NPM_TOKEN / IG_NPM_USERNAME / IG_NPM_EMAIL (build only: licensed History grid)

Session artifacts land in ./sessions/<timestamp>/; run history, matrix reports, and
screenshots persist in ./sessions/history/ across containers.

Examples:
  ./run.sh build --prune
  ./run.sh
  ./run.sh --matrix-config ./matrix.example.json
  ./run.sh --matrix-config ./matrix.json --validate
EOF
}

case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac

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
  # Pull only the licensed-feed creds from .env (matching run.ps1) rather than sourcing
  # the whole file: a targeted parse tolerates `KEY = value` spacing and never executes
  # arbitrary shell from .env.
  if [[ -f "$PWD/.env" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*(IG_NPM_TOKEN|IG_NPM_USERNAME|IG_NPM_EMAIL)[[:space:]]*=[[:space:]]*(.+)$ ]] || continue
      val="${BASH_REMATCH[2]}"
      val="${val%"${val##*[![:space:]]}"}"   # trim trailing whitespace
      export "${BASH_REMATCH[1]}=$val"
    done < "$PWD/.env"
  fi
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

# Run-mode arguments.
MATRIX_CONFIG_FILE=""
VALIDATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --matrix-config)
      MATRIX_CONFIG_FILE="${2:?--matrix-config needs a path}"; shift 2 ;;
    --validate)
      VALIDATE=1; shift ;;
    -h|--help|help)
      usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 2 ;;
  esac
done
if [[ -n "$MATRIX_CONFIG_FILE" ]]; then
  [[ -f "$MATRIX_CONFIG_FILE" ]] || { echo "matrix config not found: $MATRIX_CONFIG_FILE" >&2; exit 2; }
  MATRIX_CONFIG_FILE="$(cd "$(dirname "$MATRIX_CONFIG_FILE")" && pwd)/$(basename "$MATRIX_CONFIG_FILE")"
fi
if [[ "$VALIDATE" == 1 && -z "$MATRIX_CONFIG_FILE" ]]; then
  echo "--validate requires --matrix-config <file>" >&2
  exit 2
fi

# Provider API keys: source .env (the same file the build reads) and forward any set
# key vars into the container so a matrix config's apiKeyEnv — or the provider default
# for its model — resolves. `-e VAR` passes the value through without echoing it into
# the process listing.
[[ -f "$PWD/.env" ]] && { set -a; . "$PWD/.env"; set +a; }
ENVFLAGS=()
for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY CUSTOM_API_KEY; do
  [[ -n "${!v:-}" ]] && ENVFLAGS+=(-e "$v")
done
[[ -n "$MATRIX_CONFIG_FILE" ]] && ENVFLAGS+=(-e "MATRIX_CONFIG=/matrix-config.json")
[[ "$VALIDATE" == 1 ]] && ENVFLAGS+=(-e "MATRIX_VALIDATE=1")

mkdir -p "$OUT"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $OUT). Mounted at /history inside the container.
HIST="$PWD/sessions/history"
mkdir -p "$HIST"
# Host-supplied skills overlaid onto the generated .claude/skills/ (see the wizard's
# "use local skills" toggle / matrix variants). Created empty so the bind mount always
# resolves; drop skill folders (each a SKILL.md + resources) here to override.
SKILLS="$PWD/local-skills"
mkdir -p "$SKILLS"
# Provider packs (3rd-party library configs) persisted across containers.
# Drop a ProviderPack JSON file here (or use the Configuration tab in the wizard) to
# make additional libraries available in the wizard and matrix views.
PROVIDERS="$PWD/providers-data"
mkdir -p "$PROVIDERS"
# Host-supplied Playwright verification tests, bind-mounted read-only at /tests. A run
# collects tests/shared + tests/<framework> and runs them against the freshly-built app
# in the post-generation verify stage. Created so the mount always resolves.
TESTS="$PWD/tests"
mkdir -p "$TESTS"
if [[ "$VALIDATE" == 1 ]]; then
  echo "Validating matrix config: $MATRIX_CONFIG_FILE"
else
  echo "Session artifacts -> $OUT"
  echo "Ignite UI MCP Testbed UI:   http://localhost:8080"
  echo "opencode:                   http://localhost:4096  (after launch in interactive mode)"
  echo "App:                        http://localhost:5000  (after launch in interactive mode)"
fi

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
    SKILLS_HOST="$(cygpath -m "$SKILLS")"
    PROV_HOST="$(cygpath -m "$PROVIDERS")"
    TESTS_HOST="$(cygpath -m "$TESTS")"
    VOL=("-v" "${OUT_HOST}:/work" "-v" "${HIST_HOST}:/history" "-v" "${SKILLS_HOST}:/local-skills:ro" "-v" "${PROV_HOST}:/providers" "-v" "${TESTS_HOST}:/tests:ro")
    if [[ -n "$MATRIX_CONFIG_FILE" ]]; then
      MC_HOST="$(cygpath -m "$MATRIX_CONFIG_FILE")"
      VOL+=("-v" "${MC_HOST}:/matrix-config.json:ro")
    fi
    USERNS=()
    ;;
  *)
    # Linux / macOS: SELinux relabel + keep host UID for writable bind mount.
    VOL=("-v" "${OUT}:/work:Z" "-v" "${HIST}:/history:Z" "-v" "${SKILLS}:/local-skills:ro,Z" "-v" "${PROVIDERS}:/providers:Z" "-v" "${TESTS}:/tests:ro,Z")
    if [[ -n "$MATRIX_CONFIG_FILE" ]]; then
      VOL+=("-v" "${MATRIX_CONFIG_FILE}:/matrix-config.json:ro,Z")
    fi
    USERNS=("--userns=keep-id")
    ;;
esac

PORTS=(
  -p "${HOST_BIND}8080:8080"
  -p "${HOST_BIND}4096:4096"
  -p "${HOST_BIND}5000:5000"
)
# Validate mode publishes no ports (it exits immediately and must not conflict with a
# testbed that is already running).
[[ "$VALIDATE" == 1 ]] && PORTS=()

# Allocate a TTY only when we actually have one, so CI / piped invocations
# (e.g. a matrix-config run driven from a script) don't fail on `-t`.
if [[ -t 0 ]]; then TTY=(-it); else TTY=(-i); fi

if [[ "$VALIDATE" == 1 ]]; then
  # Not exec: reap the (empty) session dir the mount needed, then forward the exit code.
  podman run --rm "${TTY[@]}" \
    --name "igniteui-testbed-validate-$SESSION" \
    "${VOL[@]}" \
    "${USERNS[@]}" \
    "${ENVFLAGS[@]}" \
    "$IMAGE" && RC=0 || RC=$?
  rm -rf "$OUT" 2>/dev/null || true
  exit "$RC"
fi

exec podman run --rm "${TTY[@]}" \
  --name "igniteui-testbed-$SESSION" \
  "${PORTS[@]}" \
  "${VOL[@]}" \
  "${USERNS[@]}" \
  "${ENVFLAGS[@]}" \
  "$IMAGE"