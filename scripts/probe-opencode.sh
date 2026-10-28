#!/usr/bin/env bash
# Probe the opencode surfaces this testbed depends on and dump raw evidence, so a version
# bump (notably 1.x -> 2.x) can be diffed instead of guessed. Not a gate: it records, it
# doesn't assert.
#
#   scripts/probe-opencode.sh [image] [label]
#     image  default localhost/igniteui-testbed:latest
#     label  output subdir under scripts/fixtures/opencode-probe/ (default: opencode --version)
#
# PROBE_MODEL (default opencode/big-pickle, keyless) picks the model for the tool-use run;
# set the matching provider key (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...) in the env or
# .env for a paid one. The auth probe always uses a deliberately invalid Anthropic key.
set -u

if [ "${PROBE_INSIDE:-}" != 1 ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  image=${1:-localhost/igniteui-testbed:latest}
  out="$here/fixtures/opencode-probe/${2:-_pending}"
  mkdir -p "$out"
  [ -f "$here/../.env" ] && { set -a; . "$here/../.env"; set +a; }
  conv() { command -v cygpath >/dev/null && cygpath -m "$1" || echo "$1"; }
  envs=(-e PROBE_INSIDE=1 -e PROBE_LABEL="${2:-}" -e PROBE_MODEL="${PROBE_MODEL:-opencode/big-pickle}")
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_GENERATIVE_AI_API_KEY; do
    [ -n "${!v:-}" ] && envs+=(-e "$v")
  done
  MSYS_NO_PATHCONV=1 podman run --rm --entrypoint bash "${envs[@]}" \
    -v "$(conv "$here"):/probe:ro" -v "$(conv "$out"):/out" \
    "$image" /probe/probe-opencode.sh
  rc=$?
  if [ -z "${2:-}" ] && [ -f "$out/version.txt" ]; then
    label=$(tr -cd '[:alnum:]._-' < "$out/version.txt")
    rm -rf "$here/fixtures/opencode-probe/$label"
    mv "$out" "$here/fixtures/opencode-probe/$label" && out="$here/fixtures/opencode-probe/$label"
  fi
  echo "probe output: $out"
  exit $rc
fi

OUT=/out
ROOT=/tmp/probe
rm -rf "$OUT"/* "$ROOT"; mkdir -p "$ROOT"
log() { echo "== $*" | tee -a "$OUT/probe.log"; }
# section <name> <cmd...>: run with a cap, keep stdout/stderr/exit separately
section() {
  local name=$1; shift
  log "$name: $*"
  timeout "${CAP:-60}" "$@" >"$OUT/$name.stdout" 2>"$OUT/$name.stderr" </dev/null
  echo $? >"$OUT/$name.exit"
}
procs() { ps -eo pid,ppid,pgid,etimes,args | grep -i '[o]pencode' >"$OUT/$1.ps" || true; }
# 2.x: `opencode run` starts a shared `serve --service` daemon that outlives it and keeps the
# env (XDG_DATA_HOME, provider keys) of whichever run started it. Stop it between sections so
# each probe gets its own.
reset_service() {
  pgrep -f 'serve --service' >/dev/null || return 0
  log "stopping background service left by $1"
  pkill -KILL -f 'serve --service'; sleep 1
}

opencode --version 2>&1 | head -1 >"$OUT/version.txt"
npm ls -g --depth=0 >"$OUT/npm-global.txt" 2>&1

# --- 1. CLI surface ---
section help opencode --help
for c in run web serve stats service debug session mcp; do section "help-$c" opencode "$c" --help; done
section debug-paths opencode debug paths

# --- 2. Project fixture: skills in both dirs the testbed relies on, plus AGENTS.md ---
mkproj() {
  local d=$1
  mkdir -p "$d/.agents/skills/probe-agents-skill" "$d/.claude/skills/probe-claude-skill"
  printf -- '---\nname: probe-agents-skill\ndescription: Probe skill from .agents/skills. Load it when asked for the probe skill.\n---\nReply with the word AGENTS-SKILL-LOADED.\n' \
    >"$d/.agents/skills/probe-agents-skill/SKILL.md"
  printf -- '---\nname: probe-claude-skill\ndescription: Probe skill from .claude/skills.\n---\nReply with the word CLAUDE-SKILL-LOADED.\n' \
    >"$d/.claude/skills/probe-claude-skill/SKILL.md"
  printf 'When you finish, end your reply with the line AGENTS-MD-SEEN.\n' >"$d/AGENTS.md"
  (cd "$d" && git init -q && git add -A && git -c user.email=p@p -c user.name=p commit -qm init)
}

PROMPT='Do these steps in order. 1) List by name every skill available to you. 2) Load the skill named probe-agents-skill with your skill tool. 3) Call any one tool from the igniteui-cli MCP server (for example list the components for angular). 4) Create the file /tmp/probe-ext/out.txt containing ok (create the directory if needed). 5) Run the shell command: echo shell-ok. Then reply DONE.'

# dbdump <label> <xdg-data-home>: locate the store, dump schema + tool parts
dbdump() {
  local label=$1 data=$2
  find "$data" -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' \) >"$OUT/$label.dbfiles" 2>/dev/null
  find "$data" -maxdepth 4 -type d >"$OUT/$label.datadirs" 2>/dev/null
  local db; db=$(XDG_DATA_HOME=$data opencode debug paths db 2>/dev/null | tail -1)
  [ -f "$db" ] || db=$(head -1 "$OUT/$label.dbfiles")
  echo "$db" >"$OUT/$label.dbpath"
  [ -f "$db" ] || return 0
  node - "$db" "$OUT/$label" <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const [db, out] = process.argv.slice(2);
const d = new DatabaseSync(db, { readOnly: true });
fs.writeFileSync(out + '.schema.sql',
  d.prepare("select sql from sqlite_master where sql is not null").all().map(r => r.sql).join(';\n\n') + ';\n');
const tables = d.prepare("select name from sqlite_master where type='table'").all().map(r => r.name);
const dump = {};
// session_message is the evidence; other tables (instruction_blob, ...) carry megabytes of prompt text
const clip = (t, r) => t === 'session_message' ? r : Object.fromEntries(Object.entries(r)
  .map(([k, v]) => [k, typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…[clipped]' : v]));
for (const t of tables) {
  try {
    dump[t] = { count: d.prepare(`select count(*) n from "${t}"`).get().n,
                sample: d.prepare(`select * from "${t}" limit 60`).all().map(r => clip(t, r)) };
  } catch (e) { dump[t] = { error: String(e) }; }
}
fs.writeFileSync(out + '.tables.json', JSON.stringify(dump, null, 2));
if (tables.includes('part')) {
  const rows = d.prepare('select * from part').all();
  const parts = rows.map(r => { try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; } });
  fs.writeFileSync(out + '.parts.json', JSON.stringify(parts, null, 2));
  const tools = parts.filter(p => p.data && p.data.type === 'tool')
    .map(p => ({ tool: p.data.tool, status: p.data.state && p.data.state.status,
                 input: p.data.state && p.data.state.input }));
  fs.writeFileSync(out + '.tools.json', JSON.stringify(tools, null, 2));
}
EOF
}

# agentrun <label> <config-json> [extra opencode flags...]
agentrun() {
  local label=$1 cfg=$2 proj=$ROOT/$1 data=$ROOT/$1-data; shift 2
  mkproj "$proj"; mkdir -p "$data"
  echo "$cfg" >"$proj/opencode.json"; cp "$proj/opencode.json" "$OUT/$label.opencode.json"
  rm -rf /tmp/probe-ext; reset_service "pre-$label"
  procs "$label.before"
  (cd "$proj" && CAP=420 XDG_DATA_HOME=$data section "$label" opencode run "$@" "$PROMPT")
  procs "$label.after"
  reset_service "$label"
  ls -la /tmp/probe-ext >"$OUT/$label.extdir" 2>&1
  (cd "$proj" && XDG_DATA_HOME=$data section "$label.stats" opencode stats)
  dbdump "$label" "$data"
  find "$data" -name '*.log' -exec cat {} + >"$OUT/$label.oclog" 2>/dev/null
}

MODEL=${PROBE_MODEL:-opencode/big-pickle}
MCP_V1='{"igniteui-cli":{"type":"local","command":["ig","mcp"],"enabled":true},"disabled-srv":{"type":"local","command":["igniteui-theming-mcp"],"enabled":false}}'

# --- 3. Tool-use run with the exact v1 config the testbed writes today ---
agentrun run-v1cfg "{\"\$schema\":\"https://opencode.ai/config.json\",\"model\":\"$MODEL\",\"permission\":\"allow\",\"mcp\":$MCP_V1}"

# --- 4. Same run in v2-native config with Code Mode off (ignored by 1.x) ---
agentrun run-v2cfg "{\"model\":\"$MODEL\",\"permissions\":[{\"action\":\"*\",\"resource\":\"*\",\"effect\":\"allow\"}],\"mcp\":{\"servers\":{\"igniteui-cli\":{\"type\":\"local\",\"command\":[\"ig\",\"mcp\"],\"codemode\":false},\"disabled-srv\":{\"type\":\"local\",\"command\":[\"igniteui-theming-mcp\"],\"disabled\":true}}}}"

# --- 4b. 2.x shared service: the same run forced onto a private server ---
if grep -q -- '--standalone' "$OUT/help.stdout" "$OUT/help-run.stdout" 2>/dev/null; then
  agentrun run-v2cfg-standalone "$(cat "$OUT/run-v2cfg.opencode.json")" --standalone
fi

# --- 5. Provider-error formats (no tool use needed, so a short prompt) ---
PROMPT='Say hi.'
mkproj "$ROOT/auth"
echo '{"model":"anthropic/claude-sonnet-4-5","permission":"allow"}' >"$ROOT/auth/opencode.json"
reset_service pre-auth
(cd "$ROOT/auth" && ANTHROPIC_API_KEY=sk-ant-deliberately-invalid XDG_DATA_HOME=$ROOT/auth-data CAP=180 section err-auth opencode run "$PROMPT")
mkproj "$ROOT/net"
echo '{"model":"custom/m","permission":"allow","provider":{"custom":{"npm":"@ai-sdk/openai-compatible","name":"Custom","options":{"baseURL":"http://127.0.0.1:9/v1","apiKey":"x"},"models":{"m":{}}}}}' >"$ROOT/net/opencode.json"
reset_service err-auth
(cd "$ROOT/net" && XDG_DATA_HOME=$ROOT/net-data CAP=180 section err-network opencode run "$PROMPT")
reset_service err-network
section run-missing-file opencode run "$PROMPT" --file /nonexistent.png

# --- 6. Long-lived server: web UI + HTTP API ---
probe_server() {
  local sub=$1 port=$2 proj=$ROOT/srv-$1
  mkproj "$proj"; echo "{\"model\":\"$MODEL\",\"permission\":\"allow\"}" >"$proj/opencode.json"
  log "server: opencode $sub --hostname 127.0.0.1 --port $port"
  (cd "$proj" && XDG_DATA_HOME=$ROOT/srv-$1-data setsid opencode "$sub" --hostname 127.0.0.1 --port "$port" \
     >"$OUT/srv-$sub.stdout" 2>"$OUT/srv-$sub.stderr" </dev/null & echo $! >"$ROOT/srv.pid")
  local pid; pid=$(cat "$ROOT/srv.pid")
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 1; done
  procs "srv-$sub.running"
  for p in / /api /doc /openapi.json /session /config /event /global/event; do
    local f; f=$(echo "$p" | tr '/' '_')
    curl -s -m 5 -D "$OUT/srv-$sub.http$f.headers" "http://127.0.0.1:$port$p" 2>&1 | head -c 200000 >"$OUT/srv-$sub.http$f.body"
  done
  kill -TERM -- "-$pid" 2>/dev/null; sleep 3
  procs "srv-$sub.afterkill"
  kill -KILL -- "-$pid" 2>/dev/null
  sed -i -E 's/(server password )\S+/\1<redacted>/' "$OUT/srv-$sub.stdout"
}
probe_server web 4196
probe_server serve 4197

# --- 7. Shared-service footprint: anything opencode left running or listening ---
procs final
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) >"$OUT/final.listen"
find / -xdev \( -path /proc -o -path /out -o -path /probe \) -prune -o -newer "$OUT/version.txt" \
  \( -iname '*opencode*' -o -name '*.sock' \) -print 2>/dev/null | head -200 >"$OUT/final.touched"

log done
