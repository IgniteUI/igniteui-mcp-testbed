# Ignite UI MCP/Skills testbed — one image, one fresh container per session.
FROM mcr.microsoft.com/dotnet/sdk:10.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git ripgrep jq rsync procps gettext-base \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# --- Agent + Ignite UI CLI + Theming MCP (adjust versions/names to your packages) ---
# These are installed globally so the MCP servers launch from local bins (`ig mcp`,
# `igniteui-theming-mcp`) with no per-session npx network fetch in the --rm container.
RUN npm install -g opencode-ai igniteui-cli igniteui-theming

# `opencode web` always tries to open a browser via xdg-open; in a headless
# container that throws ENOENT. A no-op stub on PATH makes the open silently
# succeed so the server keeps running.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/xdg-open \
 && chmod +x /usr/local/bin/xdg-open

# --- Blazor template package (replace with your NuGet template's short name/id) ---
RUN dotnet new install IgniteUI.Blazor.Templates

# --- Wizard backend ---
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Headless Chromium for route screenshots in matrix mode. `--with-deps` pulls the
# OS libraries Chromium needs (apt) on the Debian-based SDK image. Adds notable size.
RUN npx --yes playwright install --with-deps chromium
COPY src ./src
COPY web ./web
COPY public ./public
COPY vendor ./vendor
COPY tsconfig.base.json tsconfig.json ./

# Type-check (fail-fast gate, mirrors the pre-commit hook) and bundle the two
# frontend assets — all in one layer off transient --no-save dev tooling:
#   - public/vendor/igniteui.js: Ignite UI Web Components inlined into one
#     self-contained, offline asset served from the wizard's own origin. A CDN load
#     is fragile — the ESM build re-imports lit/@floating-ui/etc. as further requests
#     that can fail behind a proxy and leave <igc-*> unregistered; esbuild inlines all.
#   - public/vendor/app.js: our web/*.ts bundled to one ESM file the browser runs.
# The backend itself ships no build output — Node strips types from src/*.ts at load.
# The grid is a commercial component: the public `igniteui-webcomponents-grids` is the
# watermarked trial; `@infragistics/igniteui-webcomponents-grids` (private feed) is the
# unwatermarked licensed build of the SAME grid (both 7.1.0). The base
# `igniteui-webcomponents` stays the public package — there is no
# `@infragistics/igniteui-webcomponents`, and the licensed grid does not depend on one
# (its only deps are lit/tslib/igniteui-i18n-core + peer igniteui-i18n-resources, both on
# public npm). So the licensed build keeps the public base, swaps just the grid for the
# scoped package via an esbuild alias, and adds the i18n peer. vendor/entry.js is
# untouched — it imports the grid through `igniteui-webcomponents-grids/grids/combined.js`
# (a sideEffects entry present in both the public and licensed package), which the alias
# redirects to the scoped package.
#
# The run scripts (run.sh/run.ps1) write a .npmrc into the build context from the IG_NPM_*
# credentials in .env (an empty file when there are none); we bind-mount it here so npm
# can reach the private feed. A bind mount is read during the build but never baked into a
# layer, so the token stays out of the image — and unlike `--mount=type=secret` it works
# on Windows podman, whose secret temp-file path is broken across the Windows->machine
# boundary (containers/podman#23815). An empty .npmrc => trial fallback. The credentials
# are consumed only here; the runtime container never installs or imports the grid.
# (Versions track the private feed's `latest` — adjust to your packages.)
RUN --mount=type=bind,source=.npmrc,target=/tmp/ig/.npmrc \
    set -e; \
    COMMON="esbuild typescript @types/node @types/express lit"; \
    BASE_PKG="igniteui-webcomponents"; \
    if [ -s /tmp/ig/.npmrc ]; then \
      echo "Ignite UI: licensed (@infragistics) build"; \
      export npm_config_userconfig=/tmp/ig/.npmrc; \
      GRID_PKG="@infragistics/igniteui-webcomponents-grids"; \
      INSTALL="${BASE_PKG}@7.2.1 ${GRID_PKG}@~7.1.0 igniteui-i18n-resources@^1.0.3"; \
      NAMES="${BASE_PKG} ${GRID_PKG} igniteui-i18n-resources"; \
      ALIAS="--alias:igniteui-webcomponents-grids=${GRID_PKG}"; \
    else \
      echo "Ignite UI: trial (watermarked) build — empty .npmrc"; \
      GRID_PKG="igniteui-webcomponents-grids"; \
      INSTALL="${BASE_PKG}@7.2.1 ${GRID_PKG}@~7.1.0"; \
      NAMES="${BASE_PKG} ${GRID_PKG}"; \
      ALIAS=""; \
    fi; \
    npm install --no-save $INSTALL $COMMON \
 && npx tsc -p tsconfig.json \
 && npx tsc -p web/tsconfig.json \
 && ./node_modules/.bin/esbuild vendor/entry.js \
      --bundle --format=esm --minify $ALIAS --outfile=public/vendor/igniteui.js \
 && ./node_modules/.bin/esbuild web/main.ts \
      --bundle --format=esm --outfile=public/vendor/app.js \
 && cat node_modules/"$BASE_PKG"/themes/dark/material.css \
        node_modules/"$GRID_PKG"/grids/themes/dark/material.css \
       > public/vendor/igniteui-theme.css \
 && npm uninstall --no-save $NAMES $COMMON

# Wizard UI, opencode web, and the generated app's dev server.
EXPOSE 8080 4096 5000

ENV WORK_DIR=/work \
    HISTORY_DIR=/history \
    WIZARD_PORT=8080 \
    OPENCODE_PORT=4096 \
    APP_PORT=5000

CMD ["node", "src/server.ts"]
