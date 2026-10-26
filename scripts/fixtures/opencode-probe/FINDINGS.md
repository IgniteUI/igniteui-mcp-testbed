# opencode probe findings (2026-10-20)

Raw evidence: `1.19.3/`, `2.0.32/` (scripts/probe-opencode.sh, background service stopped
between sections), `2.0.32-r2/` (targeted follow-up, `r2.sh` + `api-probe.txt`). Server
passwords redacted. Baseline matrix on 1.19.3: `mx-20261020052958-74ae`, 2/2 success.

## 1.19.3 (Phase 0 bump)

- Tool parts, `<server>_<tool>` naming, `skill` tool, `part` table: unchanged. Built-in
  skill `customize-opencode` is now offered alongside project skills.
- `opencode stats` layout unchanged, but it exposed two parser bugs (fixed): `Cache Write`
  overwrote `Cache Read`, `Avg Cost/Day` overwrote `Total Cost`.
- Auth error prose is now `Error: invalid x-api-key` — already matched by the auth rule.
- Unreachable endpoint prints `Error: Cannot connect to API: Unable to connect. …` — was
  unclassified; added a `network` prose rule.
- Unknown model id -> multi-line `Error: { "name": "UnknownError", … "ref": … }` with the
  real cause (`ProviderModelNotFoundError`) only in the log. Unclassified (no rule added).
- `opencode web` ignores SIGTERM for >3s; killWatcher's SIGKILL escalation covers it.

## 2.0.32

| Area | Observed |
|---|---|
| Package / bin | `@opencode/cli`, bins `opencode` + `opencode2`; `--version` prints `opencode v2.0.32` |
| Shared service | `opencode run` spawns `opencode serve --service` (own pgid, reparented to init) that **outlives the run** and keeps the env of the run that started it: later runs' `XDG_DATA_HOME` and provider keys are ignored |
| Isolation | `opencode run --standalone …` (flag **after** `run`; `opencode --standalone run` is rejected): no daemon left, store lands in the run's own `XDG_DATA_HOME/opencode/opencode.db`, env keys honoured |
| Model fallback | an unknown model id **silently falls back to a free model** (`minimax-m3.1-flash-free`) and exits 0, even with `--standalone`. Through a shared daemon started without the provider key, a valid model falls back the same way. A *bad* key on a valid model fails properly (exit 1) |
| `opencode web` | gone. `opencode serve --hostname --port` serves the web UI + API; prints `server password <pw>`; API needs Basic auth `opencode:<pw>` (`OPENCODE_SERVER_PASSWORD` is in the binary, unverified). Ignores SIGTERM (>5s) |
| HTTP API | `GET /api/session` -> `{data:[…],cursor}`; `GET /api/event` streams; `/openapi.json` is public; old `/session`, `/event` paths serve the SPA html (200!) |
| Config | v1 `opencode.json` (`permission:"allow"`, flat `mcp`, `enabled`) accepted. v2-native (`permissions[]`, `mcp.servers`, `disabled`) accepted. 1.19 **rejects** v2-native config |
| Code Mode | on by default: MCP tools only reachable via `execute`; the call appears as tool `execute` with `state.metadata.toolCalls[].tool = "igniteui-cli.list_components"` |
| `codemode:false` | honoured (on `mcp.servers.<name>`): native tool `igniteui-cli_list_components`, same name as 1.x |
| Store | no `part` table. Tool calls live in `session_message` (`type` = user/assistant/system/idle, `seq`, `time_created`, `data`); assistant `data.content[]` items `{type:'tool', id, name, state:{status,input,content,metadata}, time:{created,ran,completed}}`; `data.tokens {input,output,reasoning,cache:{read,write}}`, `data.cost`, `data.model {id,providerID}`. Sessions in `session_v2` |
| Tool names | `bash` -> `shell`; skill input is `{id}` (was `{name}`), `metadata.name` still set; built-in skills `opencode`, `report`. Seen in a real matrix run (gpt-6-luna): `read`, `glob`, `grep`, `shell`, `patch`, `skill`, `execute` |
| Skills | `.agents/skills/` and `.claude/skills/` both discovered; `AGENTS.md` loaded |
| `--file` | `--file, -f string`, but **repeatable**: `--file a --file b --file c` attaches all three (text files are inlined into the message as `<file name=…>`, images go to `files[]`); also works before the message. A comma list fails (`File not found: a,b,c`) and extra names after one `--file` become prompt text. Missing file -> `Error: File not found: …`, exit 1 |
| `--format json` | NDJSON events on stdout; provider errors arrive typed: `{"type":"error","error":{"type":"provider.auth","status":401,"message":…}}` |
| Errors (text) | auth `Error: invalid x-api-key` (exit 1); network retries ~11x then `Error: ConnectionRefused: Unable to connect. …` |
| `opencode stats` | entirely new prose/heatmap layout, no cost; `parseOpencodeStats` will not work |
| `--auto` | new flag: auto-approve permissions not explicitly denied |

## Implications for the migration plan

1. Every `opencode run` must carry `--standalone` (or the service must be disabled), or
   matrix isolation, cancel and per-entry stores all break.
2. Write `codemode:false` per server to keep tool-usage and token numbers comparable with
   1.x; Code Mode can become a matrix axis later (the `execute` metadata keeps it measurable).
3. Guard the model: compare `session_message.data.model` against `cfg.model` and fail the
   run on mismatch, otherwise a typo or missing key silently benchmarks a free model.
4. Prefer `--format json` for headless runs: typed provider errors replace the regex anchors.
5. Replace the `part` reader (tool-usage, loop, session-store) with a `session_message`
   reader; replace `opencode stats` parsing with summed message tokens/cost.
6. Interactive: `opencode serve` instead of `opencode web`; stats.ts moves to `/api/*` with
   Basic auth.
7. `--file` repeated once per image works on 2.x as on 1.x (verified 2026-10-26).
