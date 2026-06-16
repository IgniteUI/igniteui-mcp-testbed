# Ignite UI · MCP / Skills Testbed

A single-container appliance for exercising the Ignite UI AI toolchain (the
Ignite UI CLI MCP server, the Theming MCP server, and the Agent Skills) against
**opencode**. Each session runs in a **fresh, ephemeral rootless Podman
container**. A small web wizard collects your choices, scaffolds a project,
wires the AI config, and hands you off to the opencode web UI.

## Flow

```
wizard (8080)
   │  pick framework / MCPs / skills / model
   ▼
scaffold ──▶ ig ai-config ──▶ translate .vscode/mcp.json → opencode.json
   │              │                     │
   │              └─ skills → .claude/skills/ (opencode reads natively)
   ▼
start app dev server (watch, :5000)   start opencode web (:4096)
   │                                          │
   └──────────────── redirect browser ────────┘
```

The generated project and logs live in `./sessions/<timestamp>/` on the host
(bind-mounted to `/work`), so they survive container teardown even though the
container is `--rm`.

## Three views

The wizard header switches between three views:

- **Interactive** (default) — the flow above: scaffold one project, wire the
  config, and hand off to opencode web for a live session with streaming token/
  cost stats.
- **Matrix** — run one shared prompt across a grid of **platform × variant**
  (each variant = a set of MCPs + skills on/off) as sequential one-shot **headless**
  agent runs. Each entry scaffolds, runs `opencode run "<prompt>"`, then builds the
  edited app once and screenshots every route. Results land in History.
- **History** — a persisted, sortable, expandable table of every run (config,
  stage timings, token/cost stats, screenshots, logs). Records live in
  `./sessions/history/` on the host (bind-mounted to `/history`), so they persist
  *across* containers, not just one session.

## Build & run

```bash
./run.sh build          # podman build -t localhost/igniteui-testbed:latest .
./run.sh                 # fresh container; opens ports 8080 / 4096 / 5000
```

Then open <http://localhost:8080>, fill in the wizard, and launch. When the
pipeline finishes it redirects you to opencode web at <http://localhost:4096>;
the running app is at <http://localhost:5000>.

## How the toggles work

- **MCP servers** — `ig ai-config --assistants vscode` writes the server
  definitions to `.vscode/mcp.json`. The wizard translates that into opencode's
  `mcp` block in `opencode.json` (command+args → single array, `env` →
  `environment`, `url` → `type:"remote"`, `${env:VAR}` → `{env:VAR}`). Each
  discovered server is classified (theming / angular / igniteui / other) and
  enabled per your checkboxes; the console shows exactly what was enabled.
- **Skills** — `--agents claude` writes them to `.claude/skills/`, which opencode
  auto-discovers. The master checkbox switches `--agents claude` vs `--agents
  none`; the "Exclude skills" field deletes individual skill folders after
  generation (granular on/off).
- **Model** — written to `opencode.json`; the API key is passed to the opencode
  process as an env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) rather than
  written to disk. A custom OpenAI-compatible base URL declares a provider. You
  can switch model mid-session from the "Switch model" panel (rewrites config,
  restarts opencode).

## What you'll likely need to adjust

These are the spots where I had to assume, because they depend on your exact
packages and generated scripts:

1. **`src/frameworks.js`** — the dev-server command per framework. I assumed
   `npm run start`/`npm run dev` (Angular `ng serve`, React/WC Vite) and
   `dotnet watch run` for Blazor, all forced onto `0.0.0.0:5000`. Match these to
   the scripts your scaffolds actually generate.
2. **`Containerfile`** — package names (`opencode-ai`, `igniteui-cli`) and the
   Blazor template install line (`dotnet new install <YourTemplateId>`).
3. **`ig ai-config` flags** — confirmed non-interactive with
   `--framework --agents --assistants`. If your version adds a `--skills`
   selector, prefer it over the post-generation prune.
4. **Matrix mode's opencode parsing** — headless runs use `opencode run` and parse
   the human `opencode stats` report for tokens/cost (`src/capture/usage.js`), then
   discover routes (`src/capture/route-discovery.js`) and screenshot them with
   Playwright/Chromium (`src/capture/screenshots.js`). Both the opencode output
   formats and the route-discovery heuristics are version-dependent — adjust those
   if a newer opencode changes its `run`/`stats` output.

## Caveats

- Ports are fixed at container-create time (Podman can't add published ports
  later), so the app dev server is forced onto 5000. If a framework refuses a
  custom port, either change `APP_PORT` or switch to `--network=host` (less
  isolation).
- `opencode web` binds localhost by default; the wizard launches it with
  `--hostname 0.0.0.0` so the published port is reachable. It is unsecured for
  localhost use — set `OPENCODE_SERVER_PASSWORD` if you expose it beyond your
  machine.
- This repo was written and syntax-/unit-tested for the translation and
  classification logic, but **not** run end-to-end against real
  `igniteui-cli` / `opencode` / Podman — treat the first build as a shakedown.
- OSS Ignite UI components only; no private-registry auth is wired in.
```
