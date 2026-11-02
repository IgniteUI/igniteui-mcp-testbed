# Adding a library in 15 minutes

The testbed runs any UI library through a **provider pack**: a folder that says how to
scaffold a project, which MCP servers and skills the agent gets, and how to tell whether
the result built. Ignite UI itself is one (`packs/igniteui/pack.json`). This guide adds
**Reveal SDK** as a worked example. Every field is described in
[PROVIDER-PACKS.md](PROVIDER-PACKS.md); [`provider.schema.json`](provider.schema.json)
gives your editor autocomplete.

> Package names below come from the Reveal docs: `reveal-sdk-node` is the Express server
> SDK ([install server sdk](https://help.revealbi.io/web/install-server-sdk)), `reveal-sdk`
> the browser client ([install client sdk](https://help.revealbi.io/web/install-client-sdk/)),
> and `reveal-sdk-wrappers` / `reveal-sdk-wrappers-react` the web-component wrappers
> ([installation](https://help.revealbi.io/web/web-component-wrappers/installation)).
> Check which versions match your Reveal release, and **check how that release takes its
> license key**: the example passes a file path, which is a placeholder for whatever your
> version actually reads.

## 1. Make the folder (2 min)

```
providers-data/
  reveal/
    pack.json
    template/node/        # the starting project, copied into every run
    skills/<skill>/       # optional skills (each a folder with a SKILL.md)
    tests/reveal-node/    # optional Playwright specs for this framework
```

The folder name must equal the pack's `name`. `providers-data/` is mounted into the
container at `/providers`, so nothing needs rebuilding.

## 2. The starting project (5 min)

`template/node/package.json`:

```json
{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "scripts": { "dev": "node --watch server.js" },
  "dependencies": { "express": "^4.21.0", "reveal-sdk-node": "*" }
}
```

`template/node/server.js` — whatever minimal Reveal app you want the agent to start from.
It must listen on `0.0.0.0` and the testbed's port:

```js
import express from 'express';
// import reveal from 'reveal-sdk-node';   // wire Reveal per its docs
const app = express();
app.use(express.static('public'));
app.listen({{port}}, '0.0.0.0');
```

The template's text files get `{{name}}`, `{{dir}}`, `{{port}}` and `{{agents}}` filled in.
Any other `{{…}}` (an Angular or Handlebars binding, say) is left exactly as written.
`npm install` runs automatically because there is a `package.json`.

## 3. `pack.json` (5 min)

```jsonc
{
  "$schema": "../../provider.schema.json",
  "schemaVersion": 2,
  "name": "reveal",
  "displayName": "Reveal SDK",
  "version": "0.1.0",

  // License key: kept outside the project, so the agent never sees it.
  // Put the file at ./secrets/reveal/license.key on the host.
  "secrets": [
    { "name": "REVEAL_LICENSE", "file": "license.key", "description": "Reveal license key" }
  ],

  // Wizard / Matrix inputs; each becomes a {{id}} var in the pack's commands.
  "options": [
    { "id": "theme", "label": "Theme", "choices": ["light", "dark"], "default": "light" }
  ],

  "frameworks": [{
    "id": "reveal-node",
    "label": "Node",
    "scaffold": { "kind": "template", "from": "template/node" },
    "dev": {
      "cmd": "npm", "argv": ["run", "dev"],
      // The dev server gets the secret's PATH (never its contents on a command line).
      "env": { "REVEAL_LICENSE_FILE": "{{secret:REVEAL_LICENSE}}" }
    },
    "buildFailed": ["SyntaxError", "Cannot find module"],
    "routes": { "kind": "static", "paths": ["/"] }
  }],

  // Tools the steps need that aren't in the image: installed when the pack loads,
  // into /opt/pack-deps/reveal. Pin versions so runs stay comparable.
  // "containerDeps": { "npmGlobal": ["some-cli@1.2.3"] },

  // Skills the agent gets when "Install Reveal skills" is ticked. A folder in the pack
  // and/or a GitHub repo pinned to a tag or commit.
  "skills": {
    "label": "Install Reveal skills",
    "sources": [{ "dir": "skills" }]
  },

  // MCP servers the agent may use, toggled by class. Replace with a real server; with
  // none, use the wizard's "Custom MCP server" box to paste one per run instead.
  "mcp": {
    "classes": [{ "id": "docs", "label": "Reveal docs MCP" }],
    "servers": [{ "name": "reveal-docs", "class": "docs", "command": "your-reveal-docs-mcp" }]
  },

  // First output line of each is stored with every run (History → detail).
  "versions": [
    { "name": "reveal-sdk-node", "cmd": "node", "argv": ["-p", "require('reveal-sdk-node/package.json').version"] }
  ]
}
```

What happens on a run: the template is copied and installed, `versions` are recorded, the
skills are copied into `.agents/skills/`, `opencode.json` gets the selected MCP servers,
and the agent works on the project. Then the dev server starts, and the screenshot and
verification stages run against it.

## 4. Check it before running (1 min)

```bash
./run.sh --validate-pack ./providers-data/reveal        # .\run.ps1 -ValidatePack .\providers-data\reveal
```

This loads the pack inside the image without running anything. It reports, as ✓ / ⚠ / ✗:
- schema errors;
- name or framework-id clashes with loaded packs;
- missing template or skills folders;
- unset secrets;
- container deps that don't resolve on npm;
- commands not found in the image.

It exits 0 when there are no ✗. On the example exactly as written it reports two ✗,
the two things you still have to supply: the license file, and a real MCP server
command in place of `your-reveal-docs-mcp`.

## 5. Run it (2 min)

- **Interactive:** `./run.sh`, open http://localhost:8080. **Reveal SDK** is now a
  provider next to Ignite UI, with its options, MCP classes and skills label. The
  Configuration tab shows whether the secret is set and how the container deps install
  went.
- **Matrix:** reference the pack by name in a matrix config:

```json
{
  "providers": ["reveal"],
  "platforms": ["reveal-node"],
  "variants": [{ "mcps": ["docs"], "skills": true }, { "mcps": [], "skills": false }],
  "options": { "theme": "dark" },
  "model": "anthropic/claude-sonnet-4-5",
  "prompt": "Add a dashboard page with a bar chart of monthly sales."
}
```

`./run.sh --matrix-config reveal.json`. Bare class names like `"docs"` resolve to the
pack's own class, `reveal/docs`.

## What makes two runs comparable

Each run's History record stores:
- the pack's name, version and **content hash** (the whole folder, template and tests
  included);
- the commit or hash of every skill source;
- the installed container-dep versions;
- each `versions` probe's output.

If two runs labelled "reveal" differ in any of these, they didn't use the same setup.
The History re-run dialog warns when this container's copy of the pack differs from the
recorded one.

## Gotchas

- **Secrets are not isolation.** They stay out of the project, the logs and the agent's
  environment, and `opencode.json` denies reads of `/secrets`. But the agent runs as the
  same user with a shell, so a determined agent could still find them (for example in
  the dev server's `/proc/<pid>/environ`).
- **`{{secret:…}}` only works in `env` values**, never in a command line: command lines
  are written to the run log, which is saved in history.
- **MCP override env vars** are `MCP_CMD_<PACK>_<CLASS>`, e.g.
  `MCP_CMD_REVEAL_DOCS=/opt/local-mcp/bin/my-build`. The short `MCP_CMD_DOCS` works only
  while no other loaded pack also has a `docs` class.
- **Single-file packs** (`providers-data/reveal.json`) work too, but can't have a
  `template/`, `skills/` or `tests/` folder; only a folder pack can.
