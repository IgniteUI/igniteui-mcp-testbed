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
  need no key at all — just the model id, though they can't do vision, so the
  "Prompt images" feature below needs a paid model.

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
tokens / cost / test counts — what a CI job reads to see *which* combo regressed;
`tokens` is the total, with the input/output/reasoning/cache split alongside it in
`tokensBreakdown`, on both the per-entry objects and the matrix `totals`). A
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
| `images` | no | Reference images attached to the prompt (see "Prompt images"), as paths relative to `./prompt-images/`. An entry may be a file (`"dashboard/overview.png"`) or a whole folder (`"dashboard"` → every image inside). Applied to **every** entry. Entries matching no image warn. Requires a **paid, vision-capable** `model` — free/keyless models silently drop attachments. Alias: `promptImages`. |
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
                    └─ skills → .agents/skills/   (opencode loads these natively)
   │
   ▼
4b overlay local skills · attach prompt images → prompt-images/   (both optional)
   │
   ▼
5 start the app's dev server (watch, :5000)
   │
   ▼
6 start opencode web (:4096) ─▶ opens in a new tab; the wizard stays open for live stats
```

Matrix mode shares stages 1–4b, then differs: instead of launching opencode web it runs
the agent **headless** once (with any attached prompt images passed as `--file`
attachments), builds the app, screenshots the routes, and runs the injected verification
tests (stage 5 runs *after* the agent there, not before).

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
- **Skills** — `--agents generic` writes them to `.agents/skills/`, which opencode
  auto-discovers. The master checkbox switches `--agents generic` vs `--agents none`; the
  "Exclude skills" field deletes individual skill folders after generation (granular
  on/off). The flag is passed to **both** `ig new` and `ig ai-config`: `ig new` runs its
  own `ai-config` pass and, without the flag, falls back to the CLI's interactive
  defaults — so the scaffold would install the full skill set before the configure stage
  could say no. With the toggle off, stage 4 also sweeps `.agents/skills/`, `AGENTS.md`
  and `.claude/` if anything wrote them anyway, so a "no skills" run is a genuine clean
  baseline.
- **Model** — written to `opencode.json`; the API key is passed to opencode as an env
  var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) rather than written to disk. A custom
  OpenAI-compatible base URL declares a provider instead. You can switch model
  mid-session from the "Switch model" panel (it rewrites the config and restarts
  opencode).
- **Prompt images** — reference mockups attached to the prompt; see below.

## Prompt images

You can test generating an app **from a picture** — a design mockup, a hand sketch, a
Figma export, a screenshot of an app to reproduce — instead of from prose alone.

Images live in `./prompt-images/` on the host (bind-mounted at `/prompt-images`,
subfolders allowed). Both the Interactive and Matrix setup forms have a **Prompt images**
picker that lists what's in that folder, lets you click images to attach them, and can
**upload** new ones straight from the browser — uploads are written into the same host
folder, so an image attached from the UI persists and can be referenced by name from a
matrix config later. (`✕ delete files` removes the selected files from that folder, and
`↻ rescan` picks up files you dropped in outside the UI.)

The pipeline's **attach-images** stage copies the attached images into the generated
project's `prompt-images/` folder, then:

- **Matrix / headless runs** hand them to the agent as real prompt attachments —
  `opencode run "<prompt>" --file <img> …` — for every entry, so one mockup can be compared
  across platforms, MCP sets, and skill modes. A good prompt for this names the image:
  *"Build the dashboard shown in the attached mockup."*
- **Interactive sessions** stage the copies for you to reference inside opencode, since
  the prompting happens there: mention them as `@prompt-images/<file>` (the run log prints
  the exact mentions) or drag the files into the opencode composer.

> **Needs a paid, vision-capable model.** Attachments only work with a model that can see
> images — Claude, GPT, Gemini and friends, i.e. a **paid** provider model with an API key.
> opencode's free / keyless hosted models (e.g. `opencode/big-pickle`) have no vision: they
> ignore or reject the attachment, and the run quietly degrades to a text-only prompt that
> looks like the mockup was never provided. The pipeline logs a warning when images are
> attached with no API key, but only the provider can say for sure — pick a paid model
> before drawing conclusions from an image-driven run.

Accepted: `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`, `.bmp`, `.avif`. Tunables:
`PROMPT_IMAGE_MAX_BYTES` (per-file upload cap, default 10 MB) and
`PROMPT_IMAGE_MAX_COUNT` (images per run, default 8 — every image costs tokens). The
attached set is recorded per run in History (with thumbnails in the detail panel) and in a
matrix's `report.html` / `summary.json`. See
[`prompt-images/README.md`](prompt-images/README.md) for the full reference.

## Tool & skill usage

Every run records **which MCP tools the agent called and which skills it loaded**. This is
the metric the testbed exists to produce: an MCP server can be configured perfectly and a
run can finish green without the agent ever reaching for it, and that is a completely
different result from one where it called `get_api_reference` twelve times. Tokens and cost
tell you how hard the agent worked; this tells you *what it worked with*.

It is collected from opencode's own store (`<data dir>/opencode/opencode.db`) after the
agent finishes, and needs no configuration — there is nothing to switch on.

**What's recorded per run:**

| | |
| --- | --- |
| **MCP tools** | every tool call, grouped by server and tool name, with call counts, error counts, and total time |
| **Skills** | every skill the agent loaded, by name, with how many times |
| **Built-in tools** | `read` / `write` / `edit` / `bash` / `grep` / … , for context on the shape of the run |
| **Never used** | MCP servers that were configured but never called, and installed skills that were never invoked |
| **Timeline** | the first 500 calls in order, so you can see *when* a skill was loaded relative to the edits |

**Where to see it:**

- **History grid** — an `MCP·Skill` column showing `<mcp calls> · <skill invocations>`.
  It turns **amber** when some configured tooling went unused and **red** when the agent
  never touched a configured MCP server or an installed skill at all. Sortable, so
  "which variants ignored the MCP server" is one click.
- **History detail panel** — the per-tool breakdown, the never-used lists, and a full
  table of every tool with counts, errors, and timings.
- **Matrix `report.html` / `summary.json`** — `MCP` and `Skill` columns in the per-entry
  table plus a tool block per entry. `summary.json` carries the structured lists
  (`tools.mcp`, `tools.skills`, `tools.serversUnused`, `tools.skillsUnused`) so CI can
  assert *"the igniteui MCP server was actually exercised"*, not just that the app built.
- **Run log** — a one-line summary (`tools: 81 tool call(s) · MCP: 2 (create_theme,
  detect_platform) · skills: 3 (…) · MCP servers never called: igniteui-cli`).

An interactive session has no end the pipeline can observe, so its usage is refreshed on
the stats collector's 30-second tick for as long as `opencode web` is up (rather than
written once at the end like a matrix entry's).

> Both opencode's schema and its tool naming are version-dependent. If the SQLite store
> can't be read, the collector falls back to parsing the permission lines in
> `<data dir>/opencode/log/*.log` — that still answers "was this server/skill used", but
> without per-call timings or error status, and the record is marked `source: "log"`. If
> neither is readable the run's `tools` stays `null` rather than reporting a misleading
> zero. See [`src/capture/tool-usage.ts`](src/capture/tool-usage.ts).

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
   --assistants`. `ig new` takes `--agents` / `--assistants` too and *must* be given
   them, since its built-in `ai-config` pass otherwise falls back to the interactive
   checkbox defaults (`generic` + `claude`) rather than to nothing. If your CLI version
   adds a `--skills` selector, prefer it over the post-generation prune.
4. **Matrix mode's opencode parsing** — headless runs parse the human `opencode stats`
   report for tokens / cost (`src/capture/usage.ts`), discover routes
   (`src/capture/route-discovery.ts`), and screenshot them with Playwright / Chromium
   (`src/capture/screenshots.ts`). The `opencode` output formats and the route-discovery
   heuristics are version-dependent — adjust these if a newer opencode changes its
   `run` / `stats` output.

## Testing an unreleased MCP server

To compare a locally-built MCP server against the released one, pack it (`npm pack`) and
drop the tarball into `local-mcp/`:

```bash
cp ../igniteui-cli/packages/.../igniteui-mcp-server-15.5.1.tgz local-mcp/
./run.sh build          #  .\run.ps1 build
```

The build installs **every** `*.tgz` it finds under one shared prefix — each package's
bins land side by side in `/opt/local-mcp/bin/` — and leaves the released servers in
place, so **one image serves every arm**. An empty `local-mcp/` just skips the install,
so the folder is optional.

Pick which binary a class uses with `MCP_CMD_<CLASS>`:

```bash
MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp ./run.sh --matrix-config ./matrix.json
MCP_CMD_THEMING="/opt/local-mcp/bin/my-theming-mcp --stdio" ./run.sh
./run.sh --matrix-config ./matrix.json     # unset => the released servers
```

Any class works — `igniteui`, `theming`, `angular`, `custom`, or whatever `class` a
provider pack declares. The suffix is matched case-insensitively with non-alphanumerics
folded to `_`, so a pack class `mui-docs` is set with `MCP_CMD_MUI_DOCS`. The value is a
whole command line, so flags are fine. `IGNITEUI_MCP_CMD` remains an alias for
`MCP_CMD_IGNITEUI`.

This replaces the *command* of the existing server rather than adding a second one, so the
server name — and therefore every tool name the model sees — is identical in both arms,
leaving the binary as the only variable. (The vars can live in `.env` too, but an
already-exported value wins, so a sweep script can set them per arm.)

Each run records the binary two ways: structured, as `config.mcpCommands` on the history
record — the History grid's **MCPs** column renders it as `igniteui (local)` and the detail
panel shows the full command line — and in the log (`mcp "igniteui-cli" command → …`).
Both are kept in the run's history record, so arms stay identifiable afterwards. Pair it
with the [Tool & skill usage](#tool--skill-usage) report to see which tools each server
actually got called for.

`./run-ab-sweep.sh [rounds] [base-config]` drives the whole comparison: both arms from one
matrix config (only the `name` differs), arm order alternating each round, and a preflight
that refuses to start against a stale image. Point it at another class with
`MCP_CLASS=theming MCP_BIN=/opt/local-mcp/bin/my-theming-mcp ./run-ab-sweep.sh 3`.
See `local-mcp/README.md` for the details.

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
