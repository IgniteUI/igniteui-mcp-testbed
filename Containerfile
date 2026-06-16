# Ignite UI MCP/Skills testbed — one image, one fresh container per session.
FROM mcr.microsoft.com/dotnet/sdk:10.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git ripgrep jq rsync procps gettext-base \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
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
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY vendor ./vendor

# Bundle Ignite UI Web Components into one self-contained, offline asset served
# from the wizard's own origin (public/vendor/igniteui.js). Loading it from a CDN
# at page load is fragile: the CDN ESM build re-imports lit/@floating-ui/etc. as
# further network requests, any of which can fail behind a proxy and leave the
# <igc-*> elements unregistered. esbuild inlines everything into a single file.
RUN npm install --no-save igniteui-webcomponents@7.2.1 esbuild \
 && ./node_modules/.bin/esbuild vendor/entry.js \
      --bundle --format=esm --minify --outfile=public/vendor/igniteui.js \
 && cp node_modules/igniteui-webcomponents/themes/dark/material.css \
       public/vendor/igniteui-theme.css \
 && npm uninstall --no-save igniteui-webcomponents esbuild

# Wizard UI, opencode web, and the generated app's dev server.
EXPOSE 8080 4096 5000

ENV WORK_DIR=/work \
    HISTORY_DIR=/history \
    WIZARD_PORT=8080 \
    OPENCODE_PORT=4096 \
    APP_PORT=5000

CMD ["node", "server.js"]
