#!/usr/bin/env bash
# A/B a locally-built MCP server against the released one.
#
#   ./run-ab-sweep.sh [rounds] [base-config]
#
# Defaults to the igniteui class, but works for ANY class — override with the env vars
# below, e.g. to compare a local theming server instead:
#
#   MCP_CLASS=theming MCP_BIN=/opt/local-mcp/bin/my-theming-mcp ./run-ab-sweep.sh 3
#
# Both arms run the SAME matrix config, so the MCP_CMD_<CLASS> var is the only thing that
# varies — the whole point of overriding the server's *command* rather than adding a
# second server (the name, and so every tool name in the model's context, is identical
# across arms). The only per-arm edit is the config's `name`, so the two submissions are
# tellable apart in the History grid; provenance is also structured on every record
# (config.mcpCommands → the MCPs column shows `igniteui (local)`) and in each entry's log
# line (`mcp "<server>" command → …`).
#
# The arm order flips each round so drift over a long sweep hits both arms equally.
set -euo pipefail
cd "$(dirname "$0")"

N="${1:-5}"
BASE="${2:-./matrix.ab-toc-grouping.json}"
MCP_CLASS="${MCP_CLASS:-igniteui}"
MCP_BIN="${MCP_BIN:-/opt/local-mcp/bin/igniteui-mcp}"
IMAGE=localhost/igniteui-testbed:latest
TMP=./.ab-tmp

# Same folding src/config.ts applies, so a hyphenated pack class (mui-docs) reaches the
# right var name (MCP_CMD_MUI_DOCS).
CMD_VAR="MCP_CMD_$(printf '%s' "$MCP_CLASS" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"
CMD_VAR="${CMD_VAR%_}"

[[ "$N" =~ ^[0-9]+$ && "$N" -gt 0 ]] || { echo "rounds must be a positive integer, got '$N'" >&2; exit 2; }
[[ -f "$BASE" ]] || { echo "base config not found: $BASE" >&2; exit 2; }

# Forwarded into the container by run.sh's MCP block.
export IGNITEUI_MCP_DEBUG=1

# Preflight. A sweep is hours long; failing now beats discovering at round 1 that arm A
# silently ran the released server because the image predates the tarball.
mapfile -t TGZ < <(ls local-mcp/*.tgz 2>/dev/null | xargs -n1 basename 2>/dev/null | sort || true)
[[ ${#TGZ[@]} -gt 0 ]] || { echo "no *.tgz in ./local-mcp — nothing to compare against" >&2; exit 2; }
echo "local tarball(s): ${TGZ[*]}"

podman image exists "$IMAGE" || { echo "image $IMAGE not built — run ./run.sh build" >&2; exit 2; }

# MSYS_NO_PATHCONV: Git Bash rewrites /bin/sh and /opt/... into Windows paths on the way
# into podman, which fails as `/app/C:/Program Files/Git/usr/bin/sh not found`.
# PACKAGES is the manifest the Containerfile writes, because a locally-packed build and
# the released one can report the SAME `--version` — build provenance is the only thing
# that tells them apart, and a stale image would otherwise A/B a build against itself.
probe="$(MSYS_NO_PATHCONV=1 podman run --rm --entrypoint /bin/sh "$IMAGE" -c \
  "cat /opt/local-mcp/PACKAGES 2>/dev/null; echo ---; test -x '$MCP_BIN' && echo BIN_OK" || true)"
probe="${probe//$'\r'/}"
# awk, not `sed -n '1,/^---$/p'`: sed's range cannot terminate on line 1, so an empty
# manifest (marker first) ran to EOF and put the marker itself into the list.
baked="$(printf '%s\n' "$probe" | awk '/^---$/{exit} {print}' | sort)"
if [[ -z "$baked" ]]; then
  echo "$IMAGE has no local MCP packages baked in (or predates the PACKAGES manifest)." >&2
  echo "Rebuild with the tarball(s) in ./local-mcp: ./run.sh build" >&2
  exit 2
fi
if [[ "$baked" != "$(printf '%s\n' "${TGZ[@]}")" ]]; then
  echo "image is stale — baked vs ./local-mcp differ:" >&2
  diff <(printf '%s\n' "$baked") <(printf '%s\n' "${TGZ[@]}") >&2 || true
  echo "Versions alone cannot tell these apart, so this would compare the wrong build." >&2
  echo "Rebuild: ./run.sh build" >&2
  exit 2
fi
if ! grep -q '^BIN_OK$' <<<"$probe"; then
  echo "$MCP_BIN is not executable in $IMAGE. Available bins:" >&2
  MSYS_NO_PATHCONV=1 podman run --rm --entrypoint /bin/sh "$IMAGE" -c 'ls -1 /opt/local-mcp/bin 2>/dev/null' >&2 || true
  echo "Set MCP_BIN to one of the above." >&2
  exit 2
fi
echo "verified: $IMAGE has ${#TGZ[@]} package(s); $MCP_BIN present"
echo "arm A sets $CMD_VAR=$MCP_BIN (class '$MCP_CLASS'); arm B leaves it unset"

mkdir -p "$TMP"

# Same config, only `name` rewritten, so the arms can't drift apart by hand-editing.
arm_config() {  # $1 = out path, $2 = name suffix
  node -e '
    const fs = require("fs");
    const [base, out, suffix] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(base, "utf8"));
    cfg.name = `${cfg.name} — ${suffix}`;
    fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
  ' "$BASE" "$1" "$2"
}

CFG_A="$TMP/arm-a-local.json";    arm_config "$CFG_A" "arm A ($MCP_CLASS: local $(basename "$MCP_BIN"))"
CFG_B="$TMP/arm-b-released.json"; arm_config "$CFG_B" "arm B ($MCP_CLASS: released)"

run_arm_a() {
  echo "=== round $1/$N — arm A: local $MCP_CLASS MCP ($MCP_BIN)"
  ( export "$CMD_VAR=$MCP_BIN"; ./run.sh --matrix-config "$CFG_A" )
}
run_arm_b() {
  echo "=== round $1/$N — arm B: released $MCP_CLASS MCP"
  # Export EMPTY, do not `unset`: run.sh reads MCP_CMD_* out of .env with a wildcard, so
  # an unset var is re-imported from there and this arm would quietly run the local binary
  # too — an A/A sweep that still reports as A/B. An explicit empty pins it to released.
  ( export "$CMD_VAR=" IGNITEUI_MCP_CMD=; ./run.sh --matrix-config "$CFG_B" )
}

for ((i = 1; i <= N; i++)); do
  if (( i % 2 == 1 )); then
    run_arm_a "$i"; run_arm_b "$i"
  else
    run_arm_b "$i"; run_arm_a "$i"
  fi
done

echo "=== sweep done: $N round(s), $((N * 2)) submissions"
echo "compare in the History tab (MCPs column shows '$MCP_CLASS (local)' for arm A)"
