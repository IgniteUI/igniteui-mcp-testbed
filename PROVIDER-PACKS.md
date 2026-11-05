# Provider packs: adding and configuring

A **provider pack** tells the testbed how to work with one UI library:
- how to scaffold a project and serve it;
- which MCP servers and skills the agent may use;
- which secrets and tools it needs;
- how to tell whether the agent's result built.

Every provider is a pack, including Ignite UI (`packs/igniteui/pack.json`). For a
step-by-step walkthrough, see [ADDING-A-LIBRARY.md](ADDING-A-LIBRARY.md). This page is the
reference.

- Schema for editor autocomplete: [`provider.schema.json`](provider.schema.json). Add
  `"$schema": "../provider.schema.json"` to the pack. Adjust the path to wherever your
  pack sits relative to the schema file.
- Authority: `validatePack` in `src/provider-registry.ts`. When the two disagree, the
  validator wins.
- Small complete example: [`provider.example.angular-material.json`](provider.example.angular-material.json).
- Larger examples: `packs/igniteui/pack.json` (generated MCP config, per-framework vars)
  and `providers-data/angular-mix.json` if you have it (two platforms with different MCP
  sets).

---

## 1. Add a pack

### Where packs live

| Location | Origin | Who manages it |
|---|---|---|
| `packs/<name>/` | `builtin` | Shipped in the image (`/app/packs`), loaded first. Read-only; the UI can't remove or replace it. |
| `providers-data/<name>/pack.json` | `folder` | You, on the host. Can also hold `template/`, `skills/`, `tests/`. |
| `providers-data/<name>.json` | `file` | You, or the Configuration tab's **Load pack** button. |
| a matrix config's `providers` field | `inline` (or a name/path) | That config file. Not saved to `providers-data/`. |

`providers-data/` is mounted at `/providers` and read at container start. A **folder**
pack's folder name must equal its `name`. Only a folder pack can have `template/`,
`skills/` or `tests/`.

### Steps

1. Create `providers-data/<name>/pack.json` (or `providers-data/<name>.json`).
2. Check it inside the image. Nothing runs:
   ```bash
   ./run.sh --validate-pack ./providers-data/<name>      # .\run.ps1 -ValidatePack .\providers-data\<name>
   ```
3. Start a container (`./run.sh`). The pack appears as a provider in the Interactive and
   Matrix tabs, and on the Configuration tab with its secret and dependency status.
   Without restarting, you can load a single-file pack with **Load pack (.json)…**.
4. Optionally reference it from a matrix config: `"providers": ["<name>"]`.

### What the validator rejects

- Names and ids that aren't letters, digits, `-` and `_`, starting with a letter or digit.
- The name of a built-in pack, or a framework id another loaded pack already owns
  (`angular`, `react`, `webcomponents`, `blazor` belong to Ignite UI).
- Unknown fields in a v2 pack (catches typos).
- Paths that are absolute or climb out with `..`: template, skills and secret paths,
  `prepare` keys, MCP source files.
- A secret referenced anywhere in a command line.

---

## 2. Top-level fields

```jsonc
{
  "$schema": "../provider.schema.json",
  "schemaVersion": 2,            // required; v1 packs (no schemaVersion) still load
  "name": "my-lib",              // id: pack folder name, MCP class prefix, history label
  "displayName": "My Lib",       // shown in the UI
  "description": "…",
  "version": "1.0.0",            // free text; the content hash is what identifies a pack
  "frameworks": [ … ],           // required, ≥ 1 — the platforms this pack adds
  "options": [ … ],
  "configure": [ … ],
  "mcp": { … },
  "skills": { … },
  "secrets": [ … ],
  "containerDeps": { … },
  "versions": [ … ]
}
```

---

## 3. Frameworks (platforms)

Each entry is one platform in the UI and one value of a matrix `platforms` axis.

```jsonc
{
  "id": "my-lib-react",                 // unique across all loaded packs
  "label": "React",
  "vars": { "tpl": "{{env:MY_TEMPLATE|default-tpl}}" },
  "scaffold": { … },
  "install": ["my-lib", "my-lib-icons"],  // npm packages added after scaffold
  "prepare": { "relative/path": "file contents with {{vars}}" },
  "dev": { "cmd": "npm", "argv": ["run", "dev", "--", "--host", "0.0.0.0", "--port", "{{port}}"], "env": { … } },
  "buildFailed": ["error TS\\d+", "Failed to compile"],
  "routes": { "kind": "route-config", "fallback": "state-nav" }
}
```

### Scaffold

There are two kinds of scaffold:

```jsonc
// 1. A command.
"scaffold": { "cmd": "npx", "argv": ["-y", "create-vite@latest", "{{name}}", "--template", "react-ts"] }

// 2. A template (folder packs only).
"scaffold": { "kind": "template", "from": "template/react" }
```

- **A command** runs in the **parent** of the project folder and must create
  `./{{name}}` there. `{{name}}` is always `app`. `cwdIsParent` is accepted for
  compatibility, but command scaffolds always run from the parent.
- **A template** copies the folder into the project:
  - `{{name}}`, `{{dir}}`, `{{port}}` and `{{agents}}` are filled in text files and in
    file names. Any other `{{…}}`, such as an Angular binding, is left as written.
  - Binary files are copied unchanged; symlinks are skipped.
  - If the result has a `package.json`, `npm install` runs.
- Either kind may set `"env": { … }`, which can reference secrets.

### Dev server

The dev server must listen on **`0.0.0.0:{{port}}`** (5000). That port is fixed when the
container starts and published to the host.

Vite tips:
- **Hot reload:** set `CHOKIDAR_USEPOLLING=true`, since file events don't cross the
  Windows↔Podman bind mount.
- **Port:** pass `--strictPort`, so a leftover server fails loudly instead of the app
  moving to another port.

### buildFailed

Case-insensitive regexes, each up to 200 characters. A match in the dev-server log after
the agent's edits marks the entry **build-error** right away, instead of waiting out the
six-minute ready timeout. They're checked alongside the built-in markers.

### Routes (for screenshots)

| `kind` | Finds pages by |
|---|---|
| `route-config` | string-literal `path:` entries in `*rout*` source files (Angular, React Router, …) |
| `razor` | `@page` directives in `.razor` files |
| `state-nav` | clicking through the app's navigation items (apps without URL routes) |
| `static` | exactly `"paths": ["/", "/dashboard"]` |

`"fallback": "state-nav"` is tried when the primary kind finds nothing. Without `routes`,
a pack gets `route-config` with the `state-nav` fallback.

### Vars

Placeholders available in `scaffold`, `prepare`, `dev`, `configure` and `versions`:

| Var | Value |
|---|---|
| `{{name}}` | `app` |
| `{{dir}}` | the project's absolute path |
| `{{port}}` | `5000` |
| `{{agents}}` | `generic` when the run installs skills, else `none` |
| `{{<option id>}}` | the provider option's value (see Options) |
| `{{<var name>}}` | the framework's own `vars` entry |

A missing var becomes an **empty string**, so every placeholder you use must be defined.
A `vars` value may read the container's environment with `{{env:NAME|default}}`. Built-in
var names and `SECRET_*` names are not allowed there.

---

## 4. Options

These are inputs the wizard and the Matrix tab show for the provider. Each value becomes
`{{id}}`.

```jsonc
"options": [
  { "id": "theme", "label": "Theme", "choices": ["light", "dark"], "default": "light" },
  { "id": "title", "label": "App title", "placeholder": "e.g. Sales", "default": "" }
]
```

- With `choices` the input is a select, otherwise free text.
- Ids are letters, digits and `_`. `name`, `dir`, `port` and `agents` are reserved.
- A run's values are checked before it starts: an undeclared option, a value outside its
  choices, or a multi-line value is rejected.
- In a matrix config, `"options": { "theme": "dark" }` applies to every entry.

---

## 5. Configure steps

Commands run in the project after scaffold and install, for example a CLI that writes the
AI config:

```jsonc
"configure": [
  { "cmd": "ig", "argv": ["ai-config", "--framework", "angular", "--agents", "{{agents}}", "--assistants", "generic"],
    "frameworks": ["ig-angular"] }
]
```

`frameworks` limits a step to some of the pack's platforms.

---

## 6. MCP servers

Users toggle MCP servers **by class**, not by server. A run enables only the selected
classes, so a run with none selected is a clean baseline.

```jsonc
"mcp": {
  "classes": [
    { "id": "docs",  "label": "My Lib docs MCP", "description": "…" },
    { "id": "cli",   "label": "My Lib CLI MCP", "default": false, "frameworks": ["my-lib-react"] }
  ],
  // EITHER a static list …
  "servers": [
    { "name": "my-lib-docs", "class": "docs", "command": "npx", "args": ["-y", "my-lib-docs-mcp"] }
  ],
  // … OR read what a configure step generated:
  "source": {
    "files": [".mcp.json", ".vscode/mcp.json"],
    "rules": [ { "match": "theming", "class": "theming" }, { "match": "ignite", "class": "igniteui" } ]
  },
  "commands": { "docs": ["my-lib-docs-mcp"] }
}
```

- **`classes`:**
  - `default: false` leaves a class unticked in the wizard and in new matrix rows.
  - `frameworks` offers a class only on those platforms. In the Matrix tab it appears
    once one of them is checked.
  - `custom` is reserved for servers pasted into the UI's Custom MCP box.
- **`servers` vs `source`:**
  - `servers` declares the servers directly.
  - `source` reads the first file that exists (`mcpServers` or VS Code `servers` shape)
    and classifies each server by the **first** rule whose `match` occurs in its name +
    command line. Put specific rules before generic ones. A server no rule matches is
    never enabled.
  - A platform with no generator can still feed `source` by writing the file with
    `prepare` (see `angular-mix.json`).
- **`commands`** sets the default launch command per class. It replaces whatever the file
  or the server list says, for example to use a globally installed binary instead of a
  slow `npx -y`.

### Class names and overrides

Classes are qualified with the pack name: `my-lib/docs`. Configs and history may still use
the bare `docs`; it selects the run's own pack's class.

To swap a class's server for a local build (an A/B test), set an env var before
`./run.sh`:

```bash
MCP_CMD_MY_LIB_DOCS=/opt/local-mcp/bin/my-docs-mcp ./run.sh   # full name: MCP_CMD_<PACK>_<CLASS>
MCP_CMD_DOCS=/opt/local-mcp/bin/my-docs-mcp ./run.sh          # short form, while no other pack has a `docs` class
```

Non-alphanumerics become `_`. If the short form matches several packs, it applies to
none, and the server warns at startup. The override is recorded on every run, and History
shows it as `docs (local)`.

---

## 7. Skills

```jsonc
"skills": {
  "label": "Install My Lib skills",
  "sources": [
    { "github": "my-org/my-lib-skills", "ref": "v1.2.0", "path": "skills", "include": ["my-lib-*"] },
    { "dir": "skills" },
    { "command": ["npx", "my-lib", "skills", "install"] }
  ]
}
```

- Sources install into `.agents/skills/` in order. A later source replaces a skill of the
  same name from an earlier one.
- Only folders with a `SKILL.md` count as skills.
- **`github`:** fetched at `ref` (a branch, tag or commit; default branch if omitted).
  `path` defaults to `skills/` if the repo has one. `include` filters skill names with
  `*` wildcards.
- **`dir`:** a folder inside the pack (folder packs only).
- **`command`:** run inside `.agents/skills/`.
- History records each source's commit (GitHub) or content hash (`dir`), so you can tell
  whether two runs had the same skills.
- If the pack's configure steps already install skills (as `ig ai-config` does), leave
  `sources` empty and use `label` only.
- **Skills off:** removes `.agents/skills/`, `AGENTS.md` and `.claude/` from the project.
- **"Exclude skills"** in the wizard deletes the named skill folders.
- **Local skills** from `./local-skills/<framework id>/` can be layered on top per run.

---

## 8. Secrets

For license keys and similar:

```jsonc
"secrets": [
  { "name": "MY_LIB_LICENSE", "file": "license.key", "description": "License key" },
  { "name": "MY_LIB_TOKEN", "required": false }
]
```

**Where they come from:**
- **File secret:** `./secrets/<pack>/<file>` on the host, mounted read-only at
  `/secrets`. Gitignored.
- **Env secret** (no `file`): `SECRET_<NAME>` in your environment or `.env`, for example
  `SECRET_MY_LIB_TOKEN=…`.

**Who gets them:**
- Only the pack's scaffold, install, configure and dev-server steps.
- Each is passed as an env var named after the secret: the value for an env secret, the
  file path for a file secret.
- A step's `env` can also use `"MY_PATH": "{{secret:MY_LIB_LICENSE}}"`. Never in `argv`.

**What protects them:**
- They're never in the project or in `opencode.json`, and opencode never inherits them.
- `opencode.json` denies the agent read access to `/secrets`.
- A value a step prints is masked in the log.

**Not isolation.** The agent runs as the same user with a shell, so a determined agent
could still read a secret, for example from the dev server's environment in `/proc`.

**When a secret is missing:**
- A missing required secret (the default) stops the run before it scaffolds.
- The Configuration tab shows each secret as set or missing, never the value.

---

## 9. Container dependencies

Tools the steps need that aren't in the image:

```jsonc
"containerDeps": { "npmGlobal": ["my-lib-cli@3.4.1"] }
```

- **Install:** these are installed when the pack loads, into `/opt/pack-deps/<pack>`,
  and put on `PATH` for that pack's runs only (steps, dev server, opencode, MCP servers).
- **Failures:** the first run waits for the install. A failed install fails the run
  before scaffold, and the next run retries.
- **Allowed specs:** registry package names only, optionally `@version`. Git, URL and
  file specs are rejected.
- **Pin versions.** The install happens per container, and the versions it got are
  recorded with each run as `npm:<package>`.
- npm must be reachable from the container.
- For something heavy or used by every run, adding it to the `Containerfile` is still
  faster.

---

## 10. Tests, versions and provenance

- **Tests:** Playwright specs in `<pack>/tests/<framework id>/` run in the verify stage
  together with `./tests/shared/` and `./tests/<framework id>/`. They're listed as
  `@<pack>/<file>`. Specs get `APP_BASE_URL` and `APP_DIR`.
- **Versions:** the first version number each probe prints (or, without one, its first output line) is stored in the run's history.
  `frameworks` limits a probe to some platforms. A failing probe is recorded, not fatal.
  ```jsonc
  "versions": [ { "name": "my-lib", "cmd": "node", "argv": ["-p", "require('my-lib/package.json').version"] } ]
  ```
- **Provenance:** every run records:
  - the pack's name, version and **content hash** (the whole folder, template and tests
    included);
  - its options and skill sources;
  - its container-dep and tool versions.

  The History re-run dialog warns when this container's copy of the pack differs from
  the recorded one. A folder pack edited on the host while the container runs is
  re-hashed and reloaded at the start of the next run, so the recorded hash is always
  the content that run used; an edit that breaks the pack fails that run.

---

## 11. Using a pack in a matrix

```json
{
  "providers": ["my-lib"],
  "platforms": ["my-lib-react"],
  "variants": [
    { "mcps": ["docs"], "skills": true },
    { "mcps": [], "skills": false }
  ],
  "options": { "theme": "dark" },
  "model": "anthropic/claude-sonnet-4-5",
  "prompt": "…"
}
```

- **`providers`** entries can be:
  - a loaded pack's **name**;
  - a **path** to a pack file or folder, relative to `/providers`;
  - an **inline** single-file pack body.
- Variants list MCP classes by bare or qualified name.
- Check without running: `./run.sh --matrix-config <file> --validate`.

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Pack missing from the UI | Check the container log for `provider-registry: failed to load …`; run `--validate-pack`. |
| `folder "x" holds pack "y"` | Folder name and `name` differ. |
| `--agents=` / empty argument errors | A `{{var}}` your command uses isn't defined. |
| Entry ends `build-error` with no app | The dev server didn't bind `0.0.0.0:{{port}}`, or a `buildFailed` pattern matched. |
| MCP class selected but no server | No `servers` entry or `source` rule produces that class; `--validate-pack` warns about it. |
| `MCP_CMD_X` seems ignored | Two packs share class `x`; use `MCP_CMD_<PACK>_<CLASS>`. |
| `missing required secret(s)` | Put the file under `./secrets/<pack>/` or set `SECRET_<NAME>`. |
| `could not install … for pack` | A `containerDeps` name/version doesn't exist, or npm can't be reached. |
| No screenshots of inner pages | Set `routes` (e.g. `static` paths, or a `state-nav` fallback). |
