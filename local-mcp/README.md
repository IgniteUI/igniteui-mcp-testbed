# Locally-built MCP servers

Drop one or more packed tarballs here (`npm pack` in the MCP server repo, e.g.
`igniteui-mcp-server-15.5.1.tgz`) to test unreleased servers against the released ones.

Unlike the other host folders, this is **not** a bind mount — the tarballs are baked into
the image at build time, so a new tarball needs a rebuild:

```bash
./run.sh build          #  .\run.ps1 build
```

The build installs **every** `*.tgz` it finds under one shared prefix, leaving the
released servers in place. Each package's bins land side by side:

```
/opt/local-mcp/bin/<binary>
```

An empty folder is fine — the build just skips the install.

The build also writes a manifest of the installed tarball basenames to
`/opt/local-mcp/PACKAGES`. This matters because a locally-packed build and the released
one can report the **same** `--version` (both `@igniteui/mcp-server@15.5.1`), so the
manifest is the only thing inside the image that says *which* tarballs are installed —
without it a stale image A/Bs a build against itself and looks like a null result.

## Selecting one per run

`MCP_CMD_<CLASS>` picks which binary a given MCP class launches. It replaces the
*command* of the existing server rather than adding a second one, so the server name —
and every tool name the model sees — stays identical between arms; the binary is the only
thing that varies.

```bash
MCP_CMD_IGNITEUI=/opt/local-mcp/bin/igniteui-mcp ./run.sh --matrix-config ./matrix.json
MCP_CMD_THEMING=/opt/local-mcp/bin/my-theming-mcp ./run.sh
./run.sh --matrix-config ./matrix.json     # unset => the released servers
```

Any class works — `igniteui`, `theming`, `angular`, `custom`, or whatever `class` string a
provider pack declares. The suffix is matched case-insensitively with non-alphanumerics
folded to `_`, so a pack class `mui-docs` is set with `MCP_CMD_MUI_DOCS`. The value is a
whole command line, so flags are fine:
`MCP_CMD_THEMING="/opt/local-mcp/bin/x --stdio"`. An empty value counts as unset.

A class with no built-in default (e.g. `angular`, normally left as the generated
`npx @angular/cli mcp`) is rewritten too once you set its var — the override is what
enables the rewrite, not the presence of a default.

`IGNITEUI_MCP_CMD` is still accepted as an alias for `MCP_CMD_IGNITEUI`; an explicit
`MCP_CMD_IGNITEUI` wins over it.

These can also go in `.env`, though an already-exported value wins so a sweep script can
set it per arm. One image serves every arm.

**Exporting an empty value means "no override" — and that beats `.env` too.** A plain
`unset` does not: the `.env` pass matches `MCP_CMD_*` by wildcard, so an unset class is
re-imported from there. That is why `run-ab-sweep.sh`'s released arm exports
`MCP_CMD_<CLASS>=` rather than unsetting it; with the var merely unset and a
`MCP_CMD_IGNITEUI` line in `.env`, both arms would have run the local binary and the
sweep would have reported an A/B that was really an A/A.

## Provenance

Each run records which binary it used, two ways:

- **Structured** — `config.mcpCommands` on the run's history record (class → command
  line, present only for overridden classes). The History grid's MCPs column renders it
  as `igniteui (local)`, and the detail panel shows the full command. The portable
  history export does the same.
- **In the log** — the translate stage emits `mcp "<server>" command → …`, persisted in
  the run's history record.

## Sweeping both arms

`./run-ab-sweep.sh [rounds] [base-config]` runs the comparison end to end (default 5
rounds, `./matrix.ab-toc-grouping.json`). It defaults to the `igniteui` class; point it
at another with env vars:

```bash
./run-ab-sweep.sh 5
MCP_CLASS=theming MCP_BIN=/opt/local-mcp/bin/my-theming-mcp ./run-ab-sweep.sh 3
```

Both arms run the **same** matrix config — the script derives two copies into `.ab-tmp/`
that differ only in `name`, so the arms are identical by construction rather than by
hand-maintained duplicate files. The arm order flips each round so drift over a long
sweep hits both equally.

It preflights before starting: tarballs are present, the image exists, its `PACKAGES`
manifest matches the tarballs on disk, and `MCP_BIN` is actually executable in the image
(listing the available bins if not). A stale image fails fast with a rebuild hint instead
of quietly producing an A/A sweep.
