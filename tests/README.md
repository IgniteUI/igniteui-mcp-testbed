# Verification tests

Drop your own **Playwright** end-to-end tests here. This folder is bind-mounted into the
container at `/tests` (read-only) by `run.sh` / `run.ps1`, and the pipeline's
**verify** stage runs them against the freshly-built app after the agent finishes.

Verification runs in **matrix (headless) mode only** — each matrix entry, once its app
compiles and starts serving, is exercised by these tests. The result is recorded on the
run: a suite with any failing test flips the entry's status to **`test-failed`** in the
History view (distinct from `success` / `build-error`), and the pass/fail counts plus the
raw Playwright JSON report are stored on the run record.

## Layout

Tests are split into a **shared** set that runs for every platform plus optional
**per-framework** overlays:

```
tests/
  shared/                 # runs for every platform (angular, react, webcomponents, blazor)
    smoke.spec.ts
  angular/                # runs only for Angular entries
    grid.spec.ts
  react/
  webcomponents/
  blazor/
```

A run collects `tests/shared/**` **plus** `tests/<its-framework>/**`. Files with the same
relative path in a framework folder override the shared one. A folder with no spec files
simply contributes nothing.

Spec files are matched by name: `*.spec.ts` / `*.test.ts` (also `.js`, `.tsx`, `.mts`, …).

## How it runs

- The app is already served at its dev-server port; tests target it via Playwright's
  `baseURL`, so use relative paths: `await page.goto('/')`, `await page.goto('/grid')`.
- `@playwright/test` and a headless Chromium are provided by the container — you do **not**
  need a `node_modules`, `playwright.config`, or `package.json` in this folder. Just write
  `.spec.ts` files that `import { test, expect } from '@playwright/test'`.
- Each spec has a 30s default per-test timeout; the whole suite is capped by
  `TEST_TIMEOUT_MS` (default 5 min).

## Choosing which specs run

The wizard and matrix setup each show a grouped multi-select combo grouped **by
framework**. Each framework group lists the specs that run for it — its own overlay plus
the shared set (a shared spec appears under each framework it runs for). **Only the
selected files run.** Every discovered spec starts selected; clear the selection to skip
verification. In matrix mode there's one group per selected platform, and each entry runs
only its own group's selected specs.

## Example

```ts
import { test, expect } from '@playwright/test';

test('home page renders a grid', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('igc-grid, igx-grid, .igr-grid')).toBeVisible();
});
```

See `shared/smoke.spec.ts` for a baseline that ships with the repo.
