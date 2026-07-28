# Prompt images

Reference images attached to the agent's prompt — design mockups, hand sketches, Figma
exports, screenshots of an app to reproduce — so a run can be driven by *"build this
screen"* rather than by prose alone. This folder is bind-mounted into the container at
`/prompt-images` by `run.sh` / `run.ps1`.

Unlike `local-skills/` and `tests/`, this mount is **read-write**: the wizard's
**Prompt images** picker uploads straight into this folder, so an image attached from the
browser persists on the host and can be referenced by name from a matrix config file
later. Everything in here is gitignored (except this README).

## Layout

Any raster image (`.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`, `.bmp`, `.avif`) at the root or
in a subfolder, up to 4 levels deep. Subfolders are purely for grouping — a config entry
may name a single file **or** a whole folder:

```
prompt-images/
  login-sketch.png            → "login-sketch.png"
  dashboard/
    overview.png              → "dashboard/overview.png"
    detail-drawer.png         → "dashboard/detail-drawer.png"
```

The path relative to this folder is the image's id — what the UI selects and what a
matrix config's `images` field lists.

## How a run uses them

The pipeline's **attach-images** stage copies the selected images into the generated
project's `prompt-images/` folder (a plain, non-hidden folder so opencode can browse and
`@`-mention it). Then:

- **Matrix / headless runs** pass the copies to the agent as real prompt attachments:
  `opencode run "<prompt>" --file <img> …`. The images are part of the one-shot prompt for
  every entry in the matrix, so the same mockup can be compared across platforms, MCP
  sets, and skill modes.
- **Interactive sessions** have no prompt box in the wizard (you prompt inside opencode),
  so the staged copies are the handoff: reference them as
  `@prompt-images/<file>` — the run log prints the exact mentions — or drag the files into
  the opencode composer.

## Limits

- `PROMPT_IMAGE_MAX_BYTES` — per-file upload cap (default 10 MB).
- `PROMPT_IMAGE_MAX_COUNT` — how many images one run may attach (default 8). Every image
  costs tokens and large payloads get rejected by providers, so the cap is deliberate;
  extras are dropped with a warning in the run log.

## Terminal-driven runs

A matrix config file attaches images with the `images` field (see the README's
"Running the matrix from the terminal" table):

```json
{
  "platforms": ["angular", "react"],
  "prompt": "Build the dashboard shown in the attached mockup.",
  "images": ["dashboard"]
}
```

Entries that match no image file produce a load-time **warning** (visible with
`--validate`), not a failure — the run proceeds with a text-only prompt.
