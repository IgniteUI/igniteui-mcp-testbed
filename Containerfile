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
RUN npm install --no-save igniteui-webcomponents@7.2.1 esbuild typescript @types/node @types/express \
 && npx tsc -p tsconfig.json \
 && npx tsc -p web/tsconfig.json \
 && ./node_modules/.bin/esbuild vendor/entry.js \
      --bundle --format=esm --minify --outfile=public/vendor/igniteui.js \
 && ./node_modules/.bin/esbuild web/main.ts \
      --bundle --format=esm --outfile=public/vendor/app.js \
 && cp node_modules/igniteui-webcomponents/themes/dark/material.css \
       public/vendor/igniteui-theme.css \
 && npm uninstall --no-save igniteui-webcomponents esbuild typescript @types/node @types/express

# Wizard UI, opencode web, and the generated app's dev server.
EXPOSE 8080 4096 5000

ENV WORK_DIR=/work \
    HISTORY_DIR=/history \
    WIZARD_PORT=8080 \
    OPENCODE_PORT=4096 \
    APP_PORT=5000

CMD ["node", "src/server.ts"]
