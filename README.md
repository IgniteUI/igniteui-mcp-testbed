# Ignite UI · MCP / Skills Testbed

A single-container appliance for trying out the Ignite UI AI toolchain with
**opencode** (an open-source AI coding agent). It exercises two **MCP servers**
(Model Context Protocol tools the agent can call — here, live Ignite UI component
docs / API lookup and theming queries) and the **Agent Skills** (instruction files
the agent loads automatically).

A small web wizard collects your choices, scaffolds an Ignite UI project, wires the
AI config, and hands you off to opencode. Every session runs in its own **fresh,
ephemeral rootless Podman container**, so nothing leaks between runs.

## What you need

- **Podman** (rootless) — the only thing required on your machine. Everything else
  (Node, .NET, the Ignite UI CLIs, opencode, headless Chromium) is baked into the
  image. On **Windows** use the PowerShell scripts (`run.ps1` / `stop.ps1`); on
  **Linux / macOS** (or Windows Git Bash) use the shell scripts (`run.sh` / `stop.sh`).
  Both handle the Windows-vs-Linux path and flag differences for you.
- **A model + API key** — e.g. an Anthropic or OpenAI key, or a local
  OpenAI-compatible endpoint (Ollama, LM Studio, …). You type this into the wizard;
  it is passed to opencode as an environment variable and **never written to disk**.
  Keyless providers (e.g. opencode's free hosted models like `opencode/big-pickle`)
  need no key at all — just the model id.

## Quick start

**Windows (PowerShell):**

```powershell
.\run.ps1 build           # build the image (podman build -t localhost/igniteui-testbed:latest .)
.\run.ps1 build -Prune    # build, then delete dangling <none> images the rebuild orphaned
.\run.ps1                 # run a fresh container; publishes ports 8080 / 4096 / 5000
.\run.ps1 -MatrixConfig .\matrix.json   # run + execute a matrix from a JSON config (no UI needed)
.\run.ps1 -MatrixConfig .\matrix.json -Validate   # just validate the config and exit
```

**Linux / macOS / Git Bash:**

```bash
./run.sh build            # build the image
./run.sh build --prune    # build, then delete dangling <none> images the rebuild orphaned
./run.sh                  # run a fresh container; publishes ports 8080 / 4096 / 5000
./run.sh --matrix-config ./matrix.json  # run + execute a matrix from a JSON config (no UI needed)
./run.sh --matrix-config ./matrix.json --validate  # just validate the config and exit
```

Each rebuild leaves the previous image untagged (`<none>`), which adds up fast (~3 GB
each). The `-Prune` / `--prune` flag runs `podman image prune -f` after a successful
build to reclaim that space; it only touches untagged images, never your tagged ones.

### Licensed grid (optional)

The History tab uses a commercial Ignite UI grid, so by default it builds the
**watermarked trial**. To build with the licensed package, copy `.env.example` to `.env`
and set `IG_NPM_TOKEN` to an Infragistics private-feed access token (generate one at
<https://account.infragistics.com/access-tokens>), along with `IG_NPM_USERNAME` and
`IG_NPM_EMAIL` (your Infragistics account login and email — the feed needs all three):

```bash
cp .env.example .env   # then edit .env and fill in the token, username, and email
```

`run.sh` / `run.ps1` write these into a temporary `.npmrc` that the build bind-mounts to
install the licensed `@infragistics/*` packages — no watermark — then delete it after the
build. The credentials are used **only at build time** (the grid is bundled into the
image); the runtime container never sees them, and a bind-mounted file never lands in an
image layer. Both `.env` and `.npmrc` are gitignored — **never commit your credentials**.
Leave `IG_NPM_TOKEN` unset to keep the trial build.

Open <http://localhost:8080>, fill in the wizard, and launch. For an interactive
session, opencode web opens in a new tab (<http://localhost:4096>) and the generated
app runs at <http://localhost:5000>; the wizard tab stays open to show live stats.

> If PowerShell refuses to run the script ("running scripts is disabled on this
> system"), either unblock it once with `Unblock-File .\run.ps1` or invoke it as
> `pwsh -ExecutionPolicy Bypass -File .\run.ps1`.

### Stopping a session

The container runs in the foreground, so **Ctrl-C** in its terminal stops it. To stop
from a different terminal, use the stop script (the `<session>` is the timestamp printed
when the container started — omit it to stop every running testbed container):

```powershell
.\stop.ps1                # PowerShell — stop all
.\stop.ps1 <session>      #            — stop just one
```

```bash
./stop.sh                 # Git Bash / Linux / macOS — stop all
./stop.sh <session>       #                          — stop just one
```

Containers run with `--rm`, so stopping also removes them; your session artifacts in
`./sessions/<timestamp>/` stay on the host, untouched.

## Modes

The header switches between four views:

- **Configuration** — manage **provider packs**: JSON files that teach the testbed how
  to scaffold and configure a 3rd-party library (its own scaffold / dev-server
  commands, MCP servers, and skills source). Packs loaded here persist in
  `./providers-data/` on the host (you can also drop pack `.json` files there
  directly), and their frameworks appear as extra platforms in the Interactive and
  Matrix views. [`provider.example.angular-material.json`](provider.example.angular-material.json)
  is a ready-to-load example (Angular Material). A matrix config file can alternatively
  carry packs inline via its `providers` field — see below.
- **Interactive** (default) — scaffold one project, wire the config, and hand off to
  opencode web for a live session with streaming token / cost stats. This is the flow
  in "How a session works" below.
- **Matrix** — run one shared prompt across a grid of **platform × variant** (a
  variant = a set of MCPs + skills on/off). Each cell is a one-shot **headless** agent
  run: it scaffolds, runs `opencode run "<prompt>"`, builds the edited app once,
  screenshots every route, and runs any injected Playwright tests (see "Verification
  tests"). Use it to compare, say, "with skills" vs "without"
  across Angular / React / Blazor / Web Components. Results land in History.
- **History** — a sortable Ignite UI grid of every run (config, stage timings,
  token / cost stats, screenshots, logs), with expandable detail rows, a 1–5★ rating
  per run, and Excel export. It persists in `./sessions/history/` on the host, so it
  survives *across* containers — not just the current session.

## Running the matrix from the terminal

Everything the Matrix tab collects can also come from a JSON config file, so a matrix
can be executed without opening the UI:

```bash
./run.sh --matrix-config ./matrix.json          # Bash
.\run.ps1 -MatrixConfig .\matrix.json           # PowerShell
```

The file is bind-mounted read-only into the container and loaded at startup; by default
the matrix **auto-runs** immediately. The wizard server still starts, so opening
<http://localhost:8080> shows the config **prefilled in the Matrix form** and the run's
live progress — tweak and resubmit from there like any UI-configured matrix. A config
that fails validation stops the container at startup with a clear error.

Progress is **mirrored to the terminal** (`[2/4 react · none · no-skills] — agent —`,
per-entry ✔/✖ outcomes), so a config-driven run is followable without the UI. When the
matrix settles, two artifacts land in `./sessions/history/reports/<matrixId>/` on the
host: a **static HTML report** (`report.html` — summary table, per-entry stage timings,
token/cost usage, test results, and embedded screenshots; openable directly from the
filesystem, no container needed, and served at
`http://localhost:8080/history/reports/<matrixId>/report.html` while one runs) and a
machine-readable **`summary.json`** (per-entry status / duration / stage timings /
tokens / cost / test counts — what a CI job reads to see *which* combo regressed). A
final console message says where they are and that the container can be stopped. Both
are generated for UI-submitted matrices too; set `MATRIX_CONSOLE=1` to get the console
mirror for those as well (e.g. to follow via `podman logs`).

To check a config without running anything, add `--validate` / `-Validate`:

```bash
./run.sh --matrix-config ./matrix.json --validate    # Bash
.\run.ps1 -MatrixConfig .\matrix.json -Validate      # PowerShell
```

It loads and validates the file in the container environment (provider packs and the
tests dir included), prints what the config resolves to — entries, model, whether the
API key resolves, warnings — and exits without starting the wizard or publishing ports
(safe to run while another testbed is up). Exit code 0 = valid, 1 = invalid.

Copy [`matrix.example.json`](matrix.example.json) as a starting point:

| Field | Required | Meaning |
|---|---|---|
| `name` | no | Human label for the whole submission (max 80 chars). Recorded on every entry's history record (shown in the History detail panel and the matrix-tag tooltip), in the report header, and in `summary.json` — so "Tuesday's grid run" is findable without decoding timestamps. |
| `platforms` | yes | Built-in framework ids (`angular`, `blazor`, `react`, `webcomponents`) **or any registered provider pack's framework ids** (from `./providers-data/` or this file's `providers` field). Unknown names are ignored with a warning. |
| `variants` | yes | Rows of `{ "mcps": [...], "skills": bool, "localSkills": bool }`. For built-in platforms `mcps` ⊆ `igniteui` / `theming` / `custom`; for provider platforms use the pack's MCP server `class` names (+ `custom`). Classes no selected platform declares warn at load. `localSkills` without `skills` = local-only. Deduped. |
| `model` | yes | Model id, e.g. `anthropic/claude-sonnet-4-5`. |
| `providers` | no | Array of **provider pack definitions** (same JSON shape the Configuration tab uploads: `name`, `displayName`, `frameworks[]`, `configure.mcpServers[]`, …). Registered in-memory at startup *before* the request is validated, so `platforms`/`mcps` can reference them — a terminal run is fully self-contained in one file. Unlike UI uploads they are **not** persisted to `./providers-data/`; the config re-registers them each start (a same-named disk pack is replaced for that container). Packs with `containerDeps.npmGlobal` warn: those packages must be baked into the image. |
| `prompt` | yes | The shared prompt every entry runs. |
| `apiKey` | no | Provider API key **in plaintext — discouraged**; prefer one of the two below. |
| `apiKeyEnv` | no | Name of an env var (inside the container) holding the key. |
| *(neither)* | — | The provider default for the model's prefix is used (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`). The run scripts read `.env` and forward any of these that are set, so putting the key in the gitignored `.env` is the easiest safe path. |
| `customMcp` | no | Custom MCP server def(s) — a JSON object (single def, named map, or full `mcp.json` shape) or a JSON string. Only used by variants that include `"custom"` in `mcps`. |
| `customBaseUrl` | no | Custom OpenAI-compatible base URL (pairs with `CUSTOM_API_KEY`). |
| `selectedTests` | no | Verification specs to run, as `<platform>::<category>/<file>` keys (e.g. `angular::shared/smoke.spec.ts`). Omitted = run all discovered; `[]` = run none. Unknown keys warn. |
| `autoRun` | no | Default `true`. Set `false` to only prefill the UI (the file becomes a saved preset). |
| `exitOnDone` | no | Default `false` (container keeps serving the UI so results stay browsable). `true` = exit when the matrix finishes, for CI — exit code **0** = every entry succeeded, **2** = every entry built but some verification tests failed, **1** = anything worse (build-error / error / cancelled). |

The API key is never written to disk inside the container and never echoed back to the
browser; a matrix submitted from the prefilled UI with an empty key field falls back to
the config's key automatically.

[`matrix.example.angular-material.json`](matrix.example.angular-material.json) is a
complete self-contained example of the `providers` field: it defines an
**Angular Material** provider inline (Angular CLI scaffold + `@angular/material` /
`@angular/cdk` installed post-scaffold — the *agent* is left to do the Material wiring,
which is the thing being tested) with the Angular CLI MCP as its toggleable server
(class `angular`), then runs one prompt with and without that MCP:

```bash
./run.sh --matrix-config ./matrix.example.angular-material.json
```

Its `containerDeps.npmGlobal` lists `@angular/cli`; the scaffold works without baking it
in (npx fetches on demand, slower per entry) — add it to the Containerfile's
"3rd-party provider dependencies" section and rebuild to skip the per-session fetch.

## How a session works

The interactive pipeline runs six stages, streaming progress to the wizard:

```
wizard (:8080) — pick framework · MCPs · skills · model
   │
   ▼
1 scaffold ─▶ 2 ig ai-config ─▶ 3 translate .mcp.json → opencode.json ─▶ 4 prune skills
                    │
                    └─ skills → .claude/skills/   (opencode loads these natively)
   │
   ▼
5 start the app's dev server (watch, :5000)
   │
   ▼
6 start opencode web (:4096) ─▶ opens in a new tab; the wizard stays open for live stats
```

Matrix mode shares stages 1–4, then differs: instead of launching opencode web it runs
the agent **headless** once, builds the app, screenshots the routes, and runs the injected
verification tests (stage 5 runs *after* the agent there, not before).

The generated project and logs live in `./sessions/<timestamp>/` on the host
(bind-mounted to `/work`), so they survive container teardown even though the container
is `--rm`.

## Configuring a run (the toggles)

- **MCP servers** — `ig ai-config --assistants generic` writes the server definitions to
  the standard `.mcp.json` at the project root (older CLI versions wrote
  `.vscode/mcp.json`; the wizard still falls back to it). The wizard translates that into opencode's `mcp` block in
  `opencode.json` (command+args → single array, `env` → `environment`, `url` →
  `type:"remote"`, `${env:VAR}` → `{env:VAR}`). Each discovered server is classified
  (theming / angular / igniteui / other) and enabled per your checkboxes; the console
  shows exactly what was turned on.
- **Skills** — `--agents claude` writes them to `.claude/skills/`, which opencode
  auto-discovers. The master checkbox switches `--agents claude` vs `--agents none`; the
  "Exclude skills" field deletes individual skill folders after generation (granular
  on/off).
- **Model** — written to `opencode.json`; the API key is passed to opencode as an env
  var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) rather than written to disk. A custom
  OpenAI-compatible base URL declares a provider instead. You can switch model
  mid-session from the "Switch model" panel (it rewrites the config and restarts
  opencode).

## Verification tests

The testbed can run your own **Playwright** end-to-end tests against each generated app
as a post-generation quality gate. Drop specs on the host under `./tests/` (bind-mounted
read-only at `/tests`); after a matrix entry's app builds and starts serving, the
pipeline's **verify** stage runs them, and any failure marks that run `test-failed` in
History (distinct from `success` / `build-error`).

> Verification runs in **matrix (headless) mode**, where there's a clear
> post-generation checkpoint. The interactive wizard lets you pick specs and records the
> selection, but doesn't execute them (its session hands off to a live opencode editor
> with no fixed checkpoint).

### Authoring tests

Tests are split into a **shared** set that runs for every platform plus optional
**per-framework** overlays:

```
tests/
  shared/                 # runs for every platform
    smoke.spec.ts
    auth-flow.spec.ts
  angular/                # runs only for Angular entries (in addition to shared/)
    grid.spec.ts
  react/
  webcomponents/
  blazor/
```

A run collects `tests/shared/**` **plus** `tests/<its-platform>/**`. Specs are matched by
name (`*.spec.ts` / `*.test.ts`, also `.js`, `.tsx`, `.mts`, …).

Write plain Playwright specs — no `node_modules`, `playwright.config`, or `package.json`
in this folder. `@playwright/test` and a headless Chromium are provided by the container;
each spec runs against the served app via Playwright's configured `baseURL`, so navigate
with **relative** paths:

```ts
import { test, expect } from '@playwright/test';

test('home page renders a grid', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('igc-grid, igx-grid, .igr-grid')).toBeVisible();
});
```

Notes:

- **Don't wait for `networkidle`** — framework dev servers keep an HMR WebSocket open, so
  the network never goes idle and the wait would stall. Use `waitUntil: 'domcontentloaded'`
  plus a short fixed pause to let custom elements upgrade.
- Each spec has a 30s per-test timeout; the whole suite is capped by `TEST_TIMEOUT_MS`
  (default 5 min).
- The raw Playwright JSON report is saved with the run (History → run detail → **Tests**),
  and pass/fail counts show in the History grid's **Tests** column.

### Choosing what runs

Both the interactive wizard and the matrix setup have a **Verification tests** picker — a
grouped multi-select combo grouped **by framework**. Each framework group lists the specs
that run for it: its own overlay (`tests/<framework>/`) plus the shared set, so a shared
spec appears under every framework it runs for and can be toggled per framework. **Only
the selected files run**; every discovered spec starts selected, and clearing the
selection skips verification entirely. In matrix mode the picker has one group per
selected platform, and each entry runs only its own group's selected specs. See
[`tests/README.md`](tests/README.md) for the full reference.

## Adapting it to your packages

These integration points depend on the exact packages and generated scripts in your
setup, so they're the most likely to need tuning:

1. **`src/frameworks.ts`** — the dev-server command per framework. The defaults assume
   `npm run start` / `npm run dev` (Angular `ng serve`, React / Web Components on Vite)
   and `dotnet watch run` for Blazor, all forced onto `0.0.0.0:5000`. Match these to the
   scripts your scaffolds actually generate.
2. **`Containerfile`** — the global package names (`opencode-ai`, `igniteui-cli`,
   `igniteui-theming`) and the Blazor template install line (`dotnet new install
   <YourTemplateId>`).
3. **`ig ai-config` flags** — driven non-interactively via `--framework --agents
   --assistants`. If your CLI version adds a `--skills` selector, prefer it over the
   post-generation prune.
4. **Matrix mode's opencode parsing** — headless runs parse the human `opencode stats`
   report for tokens / cost (`src/capture/usage.ts`), discover routes
   (`src/capture/route-discovery.ts`), and screenshot them with Playwright / Chromium
   (`src/capture/screenshots.ts`). The `opencode` output formats and the route-discovery
   heuristics are version-dependent — adjust these if a newer opencode changes its
   `run` / `stats` output.

## Caveats & limitations

- **Fixed ports.** Podman can't add published ports after a container is created, so the
  app dev server is pinned to 5000. If a framework refuses a custom port, change
  `APP_PORT` (env var) or switch to `--network=host` (less isolation).
- **opencode web is unsecured.** It binds localhost by default; the wizard launches it
  with `--hostname 0.0.0.0` so the published port is reachable. Fine on your own machine —
  set `OPENCODE_SERVER_PASSWORD` if you expose it beyond it.
- **Version-sensitive integration.** The points under "Adapting it to your packages"
  (CLI package names, `opencode` output formats, generated dev scripts) track specific
  tool versions. Treat the first build against your exact toolchain as a shakedown.
- **Licensed vs trial grid.** The History grid is a commercial Ignite UI component, so
  builds default to the **watermarked trial**. Set `IG_NPM_TOKEN` (plus `IG_NPM_USERNAME`
  / `IG_NPM_EMAIL`) in `.env` to build the licensed package instead — see "Licensed grid
  (optional)" above. No other private-registry authentication is wired in.
