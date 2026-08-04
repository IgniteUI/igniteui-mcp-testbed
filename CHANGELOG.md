# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-04

### Added

- **Tool & skill usage capture** (`src/capture/tool-usage.ts`) — every run now records
  *which* MCP tools the agent called and *which* skills it loaded, not just what it was
  given. A green run that never reached for the configured MCP server is a different
  result from one that called it a dozen times, and that distinction is the metric the
  testbed exists to produce.
  - Per-tool aggregates (calls / errors / total duration), split into `mcp` / `skill` /
    `builtin`, plus an ordered timeline of the first 500 invocations.
  - **Never-used lists**: MCP servers that were configured but never called, and installed
    skills (`.agents/skills/` + `.claude/skills/`) that were never invoked.
  - Read from opencode's SQLite store (`<data dir>/opencode/opencode.db`) **read-only**, so
    a live interactive session's store is never write-locked. Falls back to parsing the
    permission lines in `<data dir>/opencode/log/*.log` (marked `source: "log"`, no timings
    or error status) when the db can't be read, and records `null` rather than a misleading
    all-zero result when neither is readable.
  - Headless/matrix entries collect once right after the agent exits; interactive sessions
    (which have no observable end) refresh on the stats collector's 30-second tick.
  - Surfaced in the History grid (`MCP·Skill` column — amber when some configured tooling
    went unused, red when none of it was touched), the History detail panel, `report.html`
    and `summary.json` (`tools.mcp`, `tools.skills`, `tools.serversUnused`,
    `tools.skillsUnused` — assertable from CI), both history exports, and a one-line run-log
    summary.
- **Prompt images** — attach reference mockups, sketches, Figma exports or screenshots to
  the agent's prompt, so "build this screen from the picture" becomes testable.
  - New read-**write** bind mount `./prompt-images/` → `/prompt-images` (`PROMPT_IMAGES_DIR`),
    created by `run.sh` / `run.ps1`. Read-write on purpose: browser uploads land in the same
    host folder a terminal-driven matrix config reads from — one folder, one namespace.
  - A **Prompt images** picker in both the Interactive and Matrix setup forms: thumbnails of
    what's in the folder, click to attach, upload straight from the browser, delete, rescan.
  - New pipeline stage **attach-images** (4c) copies the selection into the generated
    project's `prompt-images/` (deliberately not dot-prefixed, so opencode's file browser and
    `@`-mentions can see it). Headless runs pass them to the agent as real attachments
    (`opencode run "<prompt>" --file <img> …`); interactive runs stage the copies and log the
    `@prompt-images/<file>` mentions.
  - REST surface: `GET /api/prompt-images` (list), `GET /api/prompt-images/file?name=`
    (serve one), `POST /api/prompt-images?name=` (raw bytes — no multipart dependency),
    `DELETE /api/prompt-images?name=`.
  - Matrix config gains an `images` field (alias `promptImages`) applied to every entry; an
    entry may name a single file or a whole folder, expanded to the images inside.
  - The attached set is recorded per run in History (with thumbnails in the detail panel) and
    in a matrix's `report.html` / `summary.json`.
  - Tunables: `PROMPT_IMAGE_MAX_BYTES` (per-file upload cap, default 10 MB) and
    `PROMPT_IMAGE_MAX_COUNT` (images per run, default 8; `0` disables the feature and the UI
    picker with it).
  - **Vision is a paid-model feature**: opencode's free/keyless hosted models silently drop
    attachments, so an image run on one degrades to a text-only prompt that still reports
    success. The pipeline warns when images are attached with no API key, and both setup
    forms and the README say so.
  - New reference doc [`prompt-images/README.md`](prompt-images/README.md).
- **Token breakdown** — the input / output / reasoning / cache split now travels alongside
  the total, in the matrix `report.html`, `summary.json` (per-entry objects *and* the matrix
  `totals`, as `tokensBreakdown`), the History detail panel's per-model usage, and both
  history exports.

### Changed

- Form controls across both setup views switched to the `outlined` Ignite UI variant
  (inputs, textareas, combos), the matrix prompt field moved from a hand-styled `<textarea>`
  to `igc-textarea`, and placeholder text got a legible color.
- `run.sh` / `run.ps1` create and mount `./prompt-images`, and their `--help` output now
  lists all bind-mounted host folders.
- The stats SSE stream replays the last tool-usage frame on connect, so a reconnecting client
  isn't blank until the next 30-second tick.
- History grid column widths reduced to eliminate the horizontal scrollbar.
- `vendor/entry.js` explicitly registers `IgcFileInputComponent`: as of
  igniteui-webcomponents 7.2.4 it is exported from the package index but missing from
  `defineAllComponents()`, so without this the upload control never upgrades.

### Fixed

- **Turning skills off actually turns skills off.** `ig new` runs its own `ai-config` pass
  internally, and with `--agents` / `--assistants` absent it fell back to the CLI's
  interactive checkbox defaults (`generic` + `claude`) rather than to nothing — so a
  "no skills" run got the full `.agents/skills/` + `.claude/skills/` + `AGENTS.md` set
  installed at scaffold time, which the later `ig ai-config --agents none` could not undo.
  Every such baseline was silently contaminated, invalidating any matrix comparison against
  it. The scaffold now passes `--agents={{agents}} --assistants=generic`, and the prune stage
  additionally sweeps `.agents/skills/`, `AGENTS.md` and `.claude/` as a guarantee
  (`stripGeneratedAgentConfig`).
- The prompt-image picker no longer shows stale entries after an upload or delete.
- Restored a missing import in `src/pipeline/pipeline.ts`.
- Removed a leftover `AGENTS.md` shipped by the locally installed skills.

### Security

- Bumped `body-parser` 1.20.5 → 1.20.6 (Dependabot).

## [0.1.0] - 2026-07-27

Initial release: a single-container appliance for exercising the Ignite UI AI toolchain
(the Ignite UI CLI MCP server, the Theming MCP server, and the Agent Skills) against
**opencode**.

### Added

- **Containerized session appliance** — `Containerfile` plus `run.sh` / `stop.sh` (Bash) and
  `run.ps1` / `stop.ps1` (PowerShell), handling the Podman platform differences. Each session
  is a fresh, ephemeral rootless container publishing the wizard (8080), opencode web (4096)
  and the generated app's dev server (5000). `build --prune` / `-Prune` reclaims the space
  each rebuild orphans.
- **Interactive pipeline** (`POST /api/run`) — scaffold → `ig ai-config` → translate →
  prune skills → overlay local skills → launch app dev server → hand off to `opencode web`,
  streaming NDJSON progress to the wizard. Four built-in platforms: Angular, React, Web
  Components (`ig new`) and Blazor (`dotnet new`), defined declaratively in
  `src/frameworks.ts`.
- **VS Code → opencode MCP translation** (`src/mcp-translate.ts`) — reads the project's
  `.mcp.json` (falling back to a legacy `.vscode/mcp.json`), classifies each server as
  `theming` / `angular` / `igniteui` / `other`, enables only the classes the run selected,
  and converts the schema (`command`+`args` → single array, `env` → `environment`,
  `${workspaceFolder}` and `${env:VAR}` expansion) into `opencode.json`. Unclassified and
  deselected servers stay disabled and logged, so a no-MCP config is a true clean baseline.
- **API keys are never written to disk** — passed to the opencode child as the env var its
  model-id prefix implies (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`); a custom OpenAI-compatible base URL declares a provider
  block instead. `POST /api/model` switches model mid-session.
- **Matrix mode** (`POST /api/matrix`) — run one shared prompt across **platform × variant**
  (a variant being a set of MCPs plus skills on/off) as sequential one-shot headless runs.
  Each entry gets its own project and data dir, streams progress over SSE, is cancellable
  mid-flight (killing the whole child process group, not just the launcher), retains its log
  server-side for reconnect and history, and prunes its regenerable dirs afterwards.
- **Post-agent capture** — the edited app is built once, then routes are discovered
  (`@page` directives for Blazor; string-literal `path:` for the JS frameworks) and each is
  screenshotted with Playwright / Chromium into `/history/artifacts/<runId>/`. Terminal build
  failures short-circuit the wait instead of burning the full timeout, and the build-error
  tail is written into the entry log so it's obvious why there are no screenshots.
- **Token / cost stats** — a live `StatsCollector` subscribing to opencode's SSE stream with
  REST backfill for interactive sessions; headless entries parse the `opencode stats` report
  (`src/capture/usage.ts`).
- **Verification tests** — host-authored Playwright specs bind-mounted read-only at `/tests`,
  split into a `shared/` set plus per-framework overlays. In headless mode the **verify**
  stage assembles a throwaway harness against the serving app, runs the selected specs, and
  flips the entry to `test-failed` on any failure (precedence: build-error > test-failed >
  success). Both setup forms pick specs from a grouped `igc-combo`.
- **Local skills** — a read-only `/local-skills` mount, organized per platform
  (`local-skills/<framework>/<skill>/`), overlaid onto the generated `.agents/skills/` after
  the prune stage. Opt-in per run, with a merge or local-only mode; a 4-way axis in matrix
  mode (off / default / local / default+local).
- **Provider packs** — JSON files that teach the testbed how to scaffold and configure a
  third-party library (its own scaffold and dev-server commands, MCP servers, skills source).
  Managed from the Configuration view, persisted in `./providers-data/`, or declared inline
  in a matrix config. [`provider.example.angular-material.json`](provider.example.angular-material.json)
  ships as a working example.
- **Terminal-driven matrix** — `./run.sh --matrix-config <file>` / `.\run.ps1 -MatrixConfig
  <file>` bind-mounts a JSON config, validates it fail-fast at startup, and auto-runs the
  matrix with progress mirrored to the console. `--validate` / `-Validate` checks a config and
  exits without publishing ports. `exitOnDone` gives CI an exit code (0 all passed / 2 tests
  failed / 1 worse). Reference: [`matrix.example.json`](matrix.example.json).
- **Matrix reports** — a self-contained `report.html` (summary table, stage timings, usage,
  test results, embedded screenshots) plus a machine-readable `summary.json` per matrix, in
  `./sessions/history/reports/<matrixId>/`.
- **Run history** — one atomic JSON record per run in `./sessions/history/` (a second bind
  mount, so history outlives the per-session container): redacted config, stage timings,
  outcome, logs, screenshots, stats and a 1–5★ rating. Stale `running` records are settled to
  `interrupted` at startup. Rendered in an Ignite UI `igc-grid` with sortable columns,
  master-detail rows, Excel export, per-run and per-matrix delete, and color-stable matrix
  tags that filter the grid to one submission.
- **lit-html web UI** — four views (Configuration / Interactive / Matrix / History) as
  TypeScript ES modules under `web/`, bundled by esbuild; `public/index.html` is a thin shell.
- **Licensed grid build** — setting `IG_NPM_TOKEN` / `IG_NPM_USERNAME` / `IG_NPM_EMAIL` in a
  gitignored `.env` builds the History grid from the Infragistics private feed instead of the
  watermarked trial. Credentials are build-time only, delivered via a bind-mounted `.npmrc`
  (`podman build --secret` is broken on Windows) and deleted after the build.
- **ESM TypeScript throughout**, type-stripped natively by Node ≥24 with no backend build
  step; `npm run typecheck` (`tsc --noEmit` over the backend and frontend tsconfigs) is the
  gate, wired into `.githooks/pre-commit` and the image build.
- MIT license.

[0.2.0]: https://github.com/IgniteUI/igniteui-mcp-testbed/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/IgniteUI/igniteui-mcp-testbed/releases/tag/0.1.0
