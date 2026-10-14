# Model sweeps

Compare models on the same task: one matrix config per model, plus `run-model-sweep.sh`,
which runs them one container at a time (the fixed ports 8080/4096/5000 make overlap
impossible).

Model ids change too often to track in git, so only two templates are committed:

| template | provider | key |
| --- | --- | --- |
| `openrouter.example.json` | any model on OpenRouter (`openrouter/<vendor>/<model>`) | `OPENROUTER_API_KEY` |
| `anthropic.example.json` | Anthropic directly (`anthropic/<model>`) | `ANTHROPIC_API_KEY` |

Your own per-model configs are gitignored (`matrix-models/*.json`, except `*.example.json`).

## Setting up a sweep

Copy a template once per model, change `model` and `name`, and leave everything else
alone. That way the model is the only thing that differs between configs:

```bash
cp matrix-models/openrouter.example.json matrix-models/01-<model>.json
cp matrix-models/openrouter.example.json matrix-models/02-<model>.json
```

- **Numbering** — configs run in filename order, and a numeric prefix makes it easy to
  pick a subset (`run-model-sweep.sh 01 03`).
- **`model`** — the prefix picks the provider and so the API key variable (`PROVIDER_ENV`
  in `src/config.ts`): `openrouter/…` → `OPENROUTER_API_KEY`, `anthropic/…` →
  `ANTHROPIC_API_KEY`, and likewise `openai/…` and `google/…`. The configs name the
  variable in `apiKeyEnv`; `run.sh` forwards it from the environment or `.env`.
- **Held constant** (in the templates): `react` only, one variant (`igniteui` + `theming`
  MCPs, skills on), the two-page auth-UI prompt, and the `shared/smoke.spec.ts` test.
  Widen `platforms` or add `variants` rows and the entry count per model multiplies.
- **`exitOnDone: true` is required** — without it the container keeps serving the UI
  after its matrix finishes, and the sweep stalls on the first model.

### Choosing models

- **Tool calling is required.** Check the model's page on the provider before adding it.
  A model without tool support can't reach the MCP servers or edit files.
- **Avoid free tiers.** `:free` endpoints are rate-limited too hard for a 25-minute agent
  run, so they tend to end as `provider-down` or a timeout with no MCP calls.
- **Watch reasoning-only models.** Some models stream only reasoning tokens when called
  without a cap (the way opencode calls them) and never produce content. The run then
  shows a `stalled` warning followed by a timeout, with zero tool calls.
- **Stealth or preview ids expire.** When one is retired, its config fails with a 404.
  Remove it rather than keeping a dead config around.

## Running

```bash
./matrix-models/run-model-sweep.sh              # every config, in filename order
./matrix-models/run-model-sweep.sh 01 03        # only configs whose names match
./matrix-models/run-model-sweep.sh --validate   # validate each config, run nothing
./matrix-models/run-model-sweep.sh --stop-on-error
```

The `*.example.json` templates are always skipped. To try a template as it is, run it
directly: `./run.sh --matrix-config matrix-models/openrouter.example.json`.

Each model's output is also written to `sessions/model-sweep/<timestamp>/<config>.log`.
At the end the script prints each model's exit code (0 = every entry succeeded, 2 = built
but verification tests failed, 1 = worse). The results land in the usual places: the
History tab and `sessions/history/reports/<matrixId>/`. To see the models side by side,
run `npm run compare -- --since 12h`.
