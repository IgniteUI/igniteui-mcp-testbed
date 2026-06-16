'use strict';

const fs = require('fs');
const path = require('path');

// Turn a route path into a safe PNG filename. "/" -> "index", "/auth/profile" -> "auth_profile".
function sanitize(route) {
  const s = String(route).replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'index';
}

function joinUrl(base, route) {
  const b = String(base).replace(/\/+$/, '');
  return route === '/' ? b + '/' : b + route;
}

// Screenshot every route of a running app. Playwright is required lazily so the
// wizard backend still loads on hosts without Chromium installed (it's only present
// in the container). Per-route try/catch — one broken route never aborts the set.
async function shoot(baseUrl, routes, outDir, opts = {}) {
  const { chromium } = require('playwright');
  fs.mkdirSync(outDir, { recursive: true });
  // Wait after navigation before capturing: `networkidle` fires before custom
  // elements upgrade / charts paint, so a short page can screenshot blank-white.
  const settle = opts.settle != null ? opts.settle : Number(process.env.SCREENSHOT_PAGE_SETTLE_MS || 5000);

  const results = [];
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    for (const route of routes) {
      const file = sanitize(route) + '.png';
      const dest = path.join(outDir, file);
      try {
        await page.goto(joinUrl(baseUrl, route), { waitUntil: 'networkidle', timeout: opts.navTimeout || 30000 });
        // Let custom elements upgrade and charts paint before capturing.
        await page.waitForTimeout(settle);
        await page.screenshot({ path: dest, fullPage: true });
        results.push({ route, file, ok: true });
      } catch (err) {
        results.push({ route, file, ok: false, error: err.message });
      }
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { shoot, sanitize, joinUrl };
