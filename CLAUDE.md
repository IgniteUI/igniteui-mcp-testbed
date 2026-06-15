# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-container appliance for exercising the Ignite UI AI toolchain (the Ignite UI CLI MCP server, the Theming MCP server, and the Agent Skills) against **opencode**. A small Express web wizard collects the user's choices, scaffolds an Ignite UI project, wires the AI config, and hands off to the opencode web UI. Each session runs in a fresh, ephemeral rootless Podman container.

This repo's logic (the MCP translation and server classification) is unit-/syntax-tested, but the README notes it has **not** been run end-to-end against real `igniteui-cli` / `opencode` / Podman — treat first builds as a shakedown, and expect the "adjust to your packages" spots (see below) to need tuning.

## Commands

```bash
./run.sh build     # podman build -t localhost/igniteui-testbed:latest .
./run.sh           # run a fresh ephemeral container; publishes ports 8080 / 4096 / 5000
npm start          # run the wizard backend directly (node server.js), for host-side dev
```

There is no test runner, linter, or build step wired into `package.json` — `npm start` is the only script. The wizard backend is plain CommonJS Node with one dependency (express).

Ports: wizard `8080`, opencode web `4096`, generated app dev server `5000`. These are fixed at container-create time (Podman can't add published ports later), so the app dev server is forced onto `0.0.0.0:5000`.

## Architecture

The whole system is a pipeline driven by `POST /api/run` in `server.js`, streaming NDJSON progress events (`step` / `log` / `error` / `done`) back to the wizard UI (`public/index.html`). The six pipeline stages:

1. **Scaffold** — `ig new` (Angular/React/WebComponents) or `dotnet new <template>` (Blazor), per `lib/frameworks.js`.
2. **Configure** — `ig ai-config --framework <fw> --agents <claude|none> --assistants vscode`. `--agents claude` writes skills to `.claude/skills/` (opencode reads these natively); `--assistants vscode` writes MCP server defs to `.vscode/mcp.json`.
3. **Translate** — read `.vscode/mcp.json`, classify and toggle servers, convert to opencode's `mcp` block, write `opencode.json` (`lib/mcp-translate.js`).
4. **Prune** — delete deselected skill folders under `.claude/skills/` (granular skill on/off).
5. **Launch app** — spawn the framework's dev-server watcher, wait for port 5000.
6. **Launch opencode** — spawn `opencode web --hostname 0.0.0.0 --port 4096`, wait for port 4096.

`POST /api/model` rewrites `opencode.json` (preserving the existing `mcp` block) and restarts opencode to switch model/key mid-session. `GET /api/status` reports the two child processes. `lastConfig` (module global) is the only state remembered between `/api/run` and `/api/model`.

### Key design points

- **Two long-lived children, tracked in `procs`** (`app`, `opencode`), spawned via `spawnWatcher` with output tee'd to `/work/logs/<name>.log`. `run()` is for one-shot commands; `spawnWatcher()` for the persistent dev server and opencode.
- **MCP server classification** (`server.js`, the `classify` fn) maps each discovered server to `theming` / `angular` / `igniteui` / `other` by matching name+command, with **explicit precedence** — `theming` and `angular` are checked before the generic `ignite` match so the theming server isn't swallowed. Unclassified (`other`) servers are kept **enabled** and logged, so nothing is silently dropped. The user toggles by class, not by individual server name.
- **VS Code → opencode MCP translation** (`lib/mcp-translate.js`) handles the schema gap: `command`(string)+`args`(array) → single `command` array; `env` → `environment`; `${workspaceFolder}` → real dir; `${env:VAR}` → opencode's `{env:VAR}`. `${input:...}` prompts can't be answered headlessly — left as-is and flagged in `warnings`.
- **API keys are never written to disk.** The provider key is passed to the opencode child as an env var chosen by the model-id prefix (`PROVIDER_ENV` map in `server.js`: `anthropic/openai/openrouter/google`). A custom OpenAI-compatible base URL instead declares a `provider` block in `opencode.json` using `{env:CUSTOM_API_KEY}`.
- **Host bind mount**: the container's `/work` is bind-mounted to `./sessions/<timestamp>/` on the host, so the generated `app/` and `logs/` survive the `--rm` container teardown.

## The "adjust to your packages" spots

These depend on the exact published packages and generated scripts, and are the most likely things to need editing:

- **`lib/frameworks.js`** — the single place to tweak per-framework scaffold + dev-server commands. Assumes `npm run start` (Angular `ng serve`, WC), `npm run dev` (React/Vite), and `dotnet watch run` (Blazor), all forced onto `0.0.0.0:5000`. Match these to the scripts the scaffolds actually generate. Blazor template short name comes from `BLAZOR_TEMPLATE` env (default `igniteui-blazor`). File watching across the Windows↔Podman bind mount needs polling (inotify events don't cross it): Vite via `CHOKIDAR_USEPOLLING`, Angular via `--poll`, Blazor via `DOTNET_USE_POLLING_FILE_WATCHER`. Blazor additionally writes a `Directory.Build.props` (the framework's `prepare` map, dropped in after scaffold) relocating `obj/`+`bin/` to `/tmp` so dotnet watch's polling watcher doesn't crash scanning generated files in `obj/` (dotnet/sdk#45455); if the template ships its own `Directory.Build.props`, merge rather than overwrite.
- **`Containerfile`** — global npm package names (`opencode-ai`, `igniteui-cli`, `igniteui-theming`) and the Blazor `dotnet new install` template id (`IgniteUI.Blazor.Templates`).
- **`MCP_COMMAND_BY_CLASS` in `server.js`** — the launch commands for the Ignite UI MCP servers. `ig ai-config` writes `npx -y <pkg> …` invocations that don't resolve to a runnable bin (igniteui-cli exposes `ig`/`igniteui`, not `igniteui-cli`; theming exposes `igniteui-theming-mcp`) and would cold-fetch from npm each session, so the translate stage rewrites them to the globally-installed bins (`ig mcp`, `igniteui-theming-mcp`). If the bin names change in a future package version, update this map (and the global install in the Containerfile). The `angular-cli` server is left as the generated `npx @angular/cli mcp` (resolves to `ng mcp`, but cold-fetches unless `@angular/cli` is installed globally).
- **`ig ai-config` flags** — confirmed non-interactive via `--framework --agents --assistants`. If a newer CLI adds a `--skills` selector, prefer it over the post-generation prune in stage 4.
- **`lib/stats.js` opencode API shape** — the stats collector subscribes to opencode's SSE stream (`GET /event`) and backfills via REST (`GET /session`, `GET /session/{id}/messages`), reading `tokens`/`cost` off each message's `info`. Endpoint paths and field names are opencode-version-dependent; if a `message.updated` event arrives in an unrecognized shape the collector logs a one-time warning and leans on the REST backfill. Adjust `normalizeMessage`/`extractMessages` if opencode changes its schema.

## Conventions

- Plain CommonJS (`'use strict'`, `require`), no build/transpile, no TypeScript.
- `lib/frameworks.js` uses `{{name}}` / `{{type}}` / `{{theme}}` / `{{dir}}` / `{{port}}` placeholders in `argv`, substituted at runtime by `subst()`. Add new framework entries here rather than branching in `server.js`.
- `run.sh` handles Git Bash/Windows vs Linux/macOS Podman differences (path conversion via `cygpath`, dropping `:Z` / `--userns` on Windows). Keep platform branches there, not in the Node code.
