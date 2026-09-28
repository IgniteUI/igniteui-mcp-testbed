#!/usr/bin/env bash
# Run every per-model matrix config in this directory, one container at a time.
# The *.example.json templates are skipped.
#
# Sequential is not a preference: each container publishes the fixed ports
# (8080/4096/5000), so two runs cannot overlap. Every config sets
# "exitOnDone": true, which is what makes ./run.sh return instead of leaving the
# container serving the UI — the sweep would otherwise stop at the first model.
#
#   ./matrix-models/run-model-sweep.sh                 run all configs in order
#   ./matrix-models/run-model-sweep.sh 03 09           run only configs whose name matches
#   ./matrix-models/run-model-sweep.sh --validate      validate every config, run nothing
#   ./matrix-models/run-model-sweep.sh --continue-on-error   (default; kept for clarity)
#   ./matrix-models/run-model-sweep.sh --stop-on-error stop at the first failing model
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# The header comment above IS the help text; print it up to the first non-comment line
# so adding a line to it can never silently spill code into --help.
usage() { sed -n '2,${/^[^#]/q;p;}' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; }

VALIDATE=0
STOP_ON_ERROR=0
FILTERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate) VALIDATE=1; shift ;;
    --stop-on-error) STOP_ON_ERROR=1; shift ;;
    --continue-on-error) STOP_ON_ERROR=0; shift ;;
    -h|--help|help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) FILTERS+=("$1"); shift ;;
  esac
done

CONFIGS=()
for f in "$HERE"/*.json; do
  [[ -e "$f" ]] || continue
  [[ "$f" == *.example.json ]] && continue
  if [[ ${#FILTERS[@]} -gt 0 ]]; then
    keep=0
    for pat in "${FILTERS[@]}"; do [[ "$(basename "$f")" == *"$pat"* ]] && keep=1; done
    [[ "$keep" == 1 ]] || continue
  fi
  CONFIGS+=("$f")
done
if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  echo "no matrix configs matched in $HERE" >&2
  echo "copy a template to start one, e.g.: cp $HERE/openrouter.example.json $HERE/01-<model>.json" >&2
  exit 2
fi

# The configs resolve their key via apiKeyEnv; run.sh forwards it from the environment
# or .env. Warn rather than fail — .env is read by run.sh, not here.
for keyvar in $(grep -hoE '"apiKeyEnv"[[:space:]]*:[[:space:]]*"[A-Z0-9_]+"' "${CONFIGS[@]}" | sed -E 's/.*"([A-Z0-9_]+)"$/\1/' | sort -u); do
  if [[ -z "${!keyvar:-}" ]] && ! grep -qE "^[[:space:]]*$keyvar[[:space:]]*=" "$ROOT/.env" 2>/dev/null; then
    echo "warning: $keyvar is not set and not in .env — runs that use it will go out keyless" >&2
  fi
done

STAMP="$(date +%Y%m%dT%H%M%S)"
LOGDIR="$ROOT/sessions/model-sweep/$STAMP"
mkdir -p "$LOGDIR"

NAMES=()
CODES=()
FAILED=0

for cfg in "${CONFIGS[@]}"; do
  name="$(basename "$cfg" .json)"
  echo
  echo "=============================================================="
  echo "[$((${#NAMES[@]} + 1))/${#CONFIGS[@]}] $name"
  echo "  config: $cfg"
  echo "  model:  $(grep -oE '"model"[[:space:]]*:[[:space:]]*"[^"]+"' "$cfg" | sed -E 's/.*"([^"]+)"$/\1/')"
  echo "  log:    $LOGDIR/$name.log"
  echo "=============================================================="

  if [[ "$VALIDATE" == 1 ]]; then
    "$ROOT/run.sh" --matrix-config "$cfg" --validate 2>&1 | tee "$LOGDIR/$name.log"
  else
    "$ROOT/run.sh" --matrix-config "$cfg" 2>&1 | tee "$LOGDIR/$name.log"
  fi
  # run.sh's exit code, not tee's. exitOnDone maps it: 0 = every entry succeeded,
  # 2 = built but some verification tests failed, 1 = anything worse.
  rc="${PIPESTATUS[0]}"

  NAMES+=("$name")
  CODES+=("$rc")
  [[ "$rc" != 0 ]] && FAILED=$((FAILED + 1))
  echo "-> $name finished with exit $rc"
  if [[ "$rc" != 0 && "$STOP_ON_ERROR" == 1 ]]; then
    echo "stopping: --stop-on-error and $name exited $rc" >&2
    break
  fi
done

echo
echo "=============== sweep summary ($STAMP) ==============="
for i in "${!NAMES[@]}"; do
  case "${CODES[$i]}" in
    0) verdict="ok" ;;
    2) verdict="tests failed" ;;
    *) verdict="failed" ;;
  esac
  printf '  %-30s exit %-3s %s\n' "${NAMES[$i]}" "${CODES[$i]}" "$verdict"
done
echo "  logs:    $LOGDIR"
echo "  history: $ROOT/sessions/history  (reports under sessions/history/reports/<matrixId>/)"
echo "======================================================"

[[ "$FAILED" -eq 0 ]] || exit 1
