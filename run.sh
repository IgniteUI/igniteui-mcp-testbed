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
  - MCP_CMD_<CLASS> (any class) / IGNITEUI_MCP_DOCS_BACKEND_URL / IGNITEUI_MCP_DEBUG
    (an already-exported value wins)

MCP_CMD_<CLASS> swaps that class's MCP server for a locally-built one packed into
./local-mcp/ and installed at build time, e.g.
  MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp ./run.sh --matrix-config ./m.json
  MCP_CMD_THEMING=/opt/local-mcp/bin/my-theming-mcp ./run.sh
Any class works (igniteui, theming, angular, custom, or one a provider pack declares);
a hyphen in a class name becomes an underscore (mui-docs -> MCP_CMD_MUI_DOCS). Unset,
runs use the released server. One image serves every arm. IGNITEUI_MCP_CMD is still
accepted as an alias for MCP_CMD_IGNITEUI.

Session artifacts land in ./sessions/<timestamp>/; run history, matrix reports, and
screenshots persist in ./sessions/history/ across containers.

Host folders bind-mounted in: ./local-skills (ro) · ./tests (ro) · ./providers-data ·
./prompt-images (read-write — reference images attached to the agent's prompt; the UI's
image uploads land here).

Examples:
  ./run.sh build --prune
  ./run.sh
  ./run.sh --matrix-config ./matrix.example.json
  ./run.sh --matrix-config ./matrix.json --validate
EOF
}

case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac

# Targeted .env parse shared by build and run modes (matching run.ps1): pull only the
# named vars (an `A|B|C` pattern) rather than sourcing the file — tolerates
# `KEY = value` spacing, strips surrounding quotes and inline comments, and never
# executes arbitrary shell from .env.
read_env_keys() {
  local re="^[[:space:]]*($1)[[:space:]]*=[[:space:]]*(.+)$" line name val
  [[ -f "$PWD/.env" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $re ]] || continue
    name="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    else
      val="${val%%[[:space:]]#*}"
      val="${val%"${val##*[![:space:]]}"}"
    fi
    [[ -n "$val" ]] && export "$name=$val"
  done < "$PWD/.env"
}

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
  read_env_keys 'IG_NPM_TOKEN|IG_NPM_USERNAME|IG_NPM_EMAIL'
  # The Containerfile COPYs ./local-mcp (an optional locally-built MCP server tarball to
  # A/B against the released one), so the dir must exist even when it holds nothing.
  mkdir -p "$PWD/local-mcp"
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

# Provider API keys: read them from .env (the same file the build reads) and forward
# any set key vars into the container so a matrix config's apiKeyEnv — or the provider
# default for its model — resolves. `-e VAR` passes the value through without echoing
# it into the process listing.
KEY_VARS=(ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY CUSTOM_API_KEY)
# A matrix config may name a custom env var to hold its key via "apiKeyEnv"; forward
# that var too (else loadMatrixConfig can't resolve it and the run goes out keyless).
if [[ -n "$MATRIX_CONFIG_FILE" ]]; then
  # `|| true` is load-bearing: apiKeyEnv is OPTIONAL, and under `set -euo pipefail` a
  # grep that matches nothing exits 1, pipefail propagates it out of the substitution
  # and the script dies right here with no output at all. Every committed example
  # config happens to carry the field, which is why this hid — a config that omits it
  # (entirely legal: apiKey > apiKeyEnv > PROVIDER_ENV) made run.sh exit 1 silently.
  CUSTOM_KEY_ENV="$(grep -oE '"apiKeyEnv"[[:space:]]*:[[:space:]]*"[^"]+"' "$MATRIX_CONFIG_FILE" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/' || true)"
  if [[ -n "$CUSTOM_KEY_ENV" ]]; then
    if [[ "$CUSTOM_KEY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      dup=0; for v in "${KEY_VARS[@]}"; do [[ "$v" == "$CUSTOM_KEY_ENV" ]] && dup=1; done
      [[ "$dup" == 0 ]] && KEY_VARS+=("$CUSTOM_KEY_ENV")
    else
      echo "warning: ignoring invalid apiKeyEnv name '$CUSTOM_KEY_ENV' in $MATRIX_CONFIG_FILE" >&2
    fi
  fi
fi
KEY_RE="$(IFS='|'; echo "${KEY_VARS[*]}")"
read_env_keys "$KEY_RE"
ENVFLAGS=()
for v in "${KEY_VARS[@]}"; do
  [[ -n "${!v:-}" ]] && ENVFLAGS+=(-e "$v")
done
# Non-secret tunables: diagnostics tunables (src/config.ts): forwarded when set so a run can be tuned, and so DIAGNOSTICS_STREAM_DEBUG=1 can be used to answer which stream provider errors actually arrive on. Values are plain numbers/flags, not secrets.
DIAG_VARS=(DIAGNOSTICS_STREAM_DEBUG AGENT_STALL_MS AGENT_LOOP_REPEATS DIAGNOSTIC_AGGREGATE_THRESHOLD AGENT_TIMEOUT_MS)
for v in "${DIAG_VARS[@]}"; do
  [[ -n "${!v:-}" ]] && ENVFLAGS+=(-e "$v=${!v}")
done

# MCP server tuning, forwarded the same way. MCP_CMD_<CLASS> swaps that class's server
# for a locally-built one installed in the image (e.g.
# MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp); unset means the released server.
# Unlike the keys, an already-exported value wins over .env — an A/B sweep sets it per
# arm around the ./run.sh call, and .env must not clobber that.
#
# The MCP_CMD_ set is a PREFIX SCAN, not a fixed list: the class space is open-ended
# (a provider pack declares whatever class name it likes), so any new class has to work
# without editing this script. `${!MCP_CMD_@}` expands to the names of the already-set
# ones; the .env pass uses the matching regex so a class set only there is picked up too.
MCP_FIXED=(IGNITEUI_MCP_CMD IGNITEUI_MCP_DOCS_BACKEND_URL IGNITEUI_MCP_DEBUG)
# Snapshot what is already exported, then restore it after the .env pass. The pattern has
# to stay a wildcard (a class may be named ONLY in .env), and read_env_keys exports
# unconditionally — so filtering the pattern cannot protect an exported value, and an
# unprotected one would be silently replaced by .env, quietly running both sweep arms on
# the same binary. Snapshot/restore is what actually makes "exported wins" true.
# `${!v+set}` (declared) rather than `-n` (non-empty) is load-bearing: an explicitly
# EMPTY value means "no override for this class", and it has to survive the .env pass too.
# Otherwise a caller that cleared the var gets it handed straight back by .env — which is
# exactly how run-ab-sweep.sh's released arm silently became a second local arm, since
# putting MCP_CMD_* in .env is a documented workflow. An unset var is still fair game for
# .env; only an explicit empty pins the class to its released command.
MCP_PRESET=()
for v in "${MCP_FIXED[@]}" ${!MCP_CMD_@}; do
  [[ -n "${!v+set}" ]] && MCP_PRESET+=("$v=${!v}")
done
read_env_keys "MCP_CMD_[A-Za-z0-9_]+|IGNITEUI_MCP_CMD|IGNITEUI_MCP_DOCS_BACKEND_URL|IGNITEUI_MCP_DEBUG"
for kv in ${MCP_PRESET[@]+"${MCP_PRESET[@]}"}; do export "$kv"; done
# Re-scan after .env: it may have introduced MCP_CMD_ classes that were not set before.
for v in "${MCP_FIXED[@]}" ${!MCP_CMD_@}; do
  [[ -n "${!v:-}" ]] && ENVFLAGS+=(-e "$v")
done

[[ -n "$MATRIX_CONFIG_FILE" ]] && ENVFLAGS+=(-e "MATRIX_CONFIG=/matrix-config.json")
[[ "$VALIDATE" == 1 ]] && ENVFLAGS+=(-e "MATRIX_VALIDATE=1")

mkdir -p "$OUT"
# Run history persists across containers, so it lives in a stable shared dir
# (not the per-session $OUT). Mounted at /history inside the container.
HIST="$PWD/sessions/history"
mkdir -p "$HIST"
# Host-supplied skills overlaid onto the generated .agents/skills/ (see the wizard's
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
# Reference images attached to the agent's prompt (design mockups, sketches, screenshots).
# Mounted read-WRITE at /prompt-images — unlike the skills/tests mounts — because the
# wizard's "Prompt images" picker uploads into this same folder, so browser-attached
# images persist on the host and can be reused by a terminal-driven matrix config.
IMAGES="$PWD/prompt-images"
mkdir -p "$IMAGES"
if [[ "$VALIDATE" == 1 ]]; then
  echo "Validating matrix config: $MATRIX_CONFIG_FILE"
else
  echo "Session artifacts -> $OUT"
  # Report every overridden class, not just igniteui: this line is what a user reads to
  # confirm which arm is running, so a class it cannot see reads as "released" and would
  # misreport the arm outright.
  MCP_SHOWN=0
  for v in "${MCP_FIXED[@]}" ${!MCP_CMD_@}; do
    case "$v" in IGNITEUI_MCP_DOCS_BACKEND_URL|IGNITEUI_MCP_DEBUG) continue ;; esac
    [[ -n "${!v:-}" ]] || continue
    cls="${v#MCP_CMD_}"; [[ "$v" == IGNITEUI_MCP_CMD ]] && cls=IGNITEUI
    printf 'MCP server override:        %s -> %s\n' "$(printf '%s' "$cls" | tr '[:upper:]' '[:lower:]')" "${!v}"
    MCP_SHOWN=1
  done
  # `if`, not `[[ ]] && echo`: under `set -e` that compound returns 1 whenever an
  # override WAS printed, which would abort the script right before it starts podman.
  if [[ "$MCP_SHOWN" == 0 ]]; then
    echo "MCP servers:                released (no MCP_CMD_* override)"
  fi
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
    IMAGES_HOST="$(cygpath -m "$IMAGES")"
    VOL=("-v" "${OUT_HOST}:/work" "-v" "${HIST_HOST}:/history" "-v" "${SKILLS_HOST}:/local-skills:ro" "-v" "${PROV_HOST}:/providers" "-v" "${TESTS_HOST}:/tests:ro" "-v" "${IMAGES_HOST}:/prompt-images")
    if [[ -n "$MATRIX_CONFIG_FILE" ]]; then
      MC_HOST="$(cygpath -m "$MATRIX_CONFIG_FILE")"
      VOL+=("-v" "${MC_HOST}:/matrix-config.json:ro")
    fi
    USERNS=()
    ;;
  *)
    # Linux / macOS: SELinux relabel + keep host UID for writable bind mount.
    VOL=("-v" "${OUT}:/work:Z" "-v" "${HIST}:/history:Z" "-v" "${SKILLS}:/local-skills:ro,Z" "-v" "${PROVIDERS}:/providers:Z" "-v" "${TESTS}:/tests:ro,Z" "-v" "${IMAGES}:/prompt-images:Z")
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