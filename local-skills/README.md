# Local skills

Drop your own Agent Skills here to override or supplement the ones the testbed generates
with `ig ai-config`. This folder is bind-mounted into the container at `/local-skills`
(read-only) by `run.sh` / `run.ps1`, and the pipeline's **overlay-skills** stage copies
them into the generated project's `.agents/skills/`.

A "skill" is just a folder containing a `SKILL.md` (opencode auto-loads every folder under
`.agents/skills/`). It can be **anything you want** — not only Ignite UI skills: a
coding-style guide, a domain cheat-sheet, a "always write tests" rule, etc. Name a local
folder the same as a generated skill to **override** it, or use a new name to **add** one.

## Layout

Skills are organized **per platform** — one subfolder per framework
(`angular`, `react`, `webcomponents`, `blazor`), and within it one subfolder per skill,
each containing a `SKILL.md` (plus any resources the skill needs). The skill folder name
becomes the skill name:

```
local-skills/
  angular/
    my-grid-helper/
      SKILL.md
      reference.md      # optional resources
    another-skill/
      SKILL.md
  react/
    my-grid-helper/
      SKILL.md
  webcomponents/
    ...
  blazor/
    ...
```

A run uses **only its platform's folder**: an interactive session copies from the
framework you selected, and each matrix entry copies from its own platform. A skill
subfolder without a `SKILL.md` is skipped (with a warning in the run log); a platform with
no folder simply has no local skills to overlay.

## How it's applied

Per run you choose, in the wizard or per matrix variant:

- **off** — no skills.
- **default** — only the generated Ignite UI skills.
- **default + local (merge)** — generated skills, with same-named local folders here
  winning (override on top).
- **local** — only the skills in this folder (the generated set is wiped first).

Anything in here is gitignored (this README aside), so your skills stay local.
