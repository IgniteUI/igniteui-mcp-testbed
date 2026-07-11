'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Screenshot } from '../types.ts';

export interface ShootOpts {
  settle?: number;
  navTimeout?: number;
  /** When true, routes are logical page names (state-based nav). Navigate to root
   * once, then click the matching sidebar/nav item for each page. */
  stateNav?: boolean;
}

// Turn a route path into a safe PNG filename. "/" -> "index", "/auth/profile" -> "auth_profile".
export function sanitize(route: string): string {
  const s = String(route).replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'index';
}

export function joinUrl(base: string, route: string): string {
  const b = String(base).replace(/\/+$/, '');
  return route === '/' ? b + '/' : b + route;
}

// Screenshot every route of a running app. Playwright is required lazily so the
// wizard backend still loads on hosts without Chromium installed (it's only present
// in the container). Per-route try/catch — one broken route never aborts the set.
export async function shoot(baseUrl: string, routes: string[], outDir: string, opts: ShootOpts = {}): Promise<Screenshot[]> {
  const { chromium } = await import('playwright');
  fs.mkdirSync(outDir, { recursive: true });
  // Wait after navigation before capturing: `networkidle` fires before custom
  // elements upgrade / charts paint, so a short page can screenshot blank-white.
  const settle = opts.settle != null ? opts.settle : Number(process.env.SCREENSHOT_PAGE_SETTLE_MS || 5000);

  const results: Screenshot[] = [];
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    if (opts.stateNav) {
      // State-based navigation (React useState): the app has no URL routes.
      // Navigate to the root once, then click sidebar/nav items by text to switch pages.
      try {
        await page.goto(joinUrl(baseUrl, '/'), { waitUntil: 'networkidle', timeout: opts.navTimeout || 30000 });
        await page.waitForTimeout(settle);
      } catch (err: any) {
        // If root fails, every entry will fail — record and bail.
        for (const route of routes) {
          results.push({ route, file: sanitize(route) + '.png', ok: false, error: err.message });
        }
        await ctx.close();
        return results;
      }
      // Nav containers to search inside (widening selector so custom sidebar class names work).
      const NAV_SEL = 'nav, aside, [role="navigation"], [class*="sidebar"], [class*="side-bar"], [class*="nav"]';
      for (const route of routes) {
        const file = sanitize(route) + '.png';
        const dest = path.join(outDir, file);
        // Derive a human display name: '/dashboard' → 'Dashboard'.
        const pageName = route.replace(/^\//, '');
        const displayName = pageName.charAt(0).toUpperCase() + pageName.slice(1);
        try {
          // Look for a nav item whose visible text matches the page name (case-insensitive).
          const navArea = page.locator(NAV_SEL);
          const item = navArea.getByText(displayName, { exact: false }).first();
          if (await item.count() > 0) {
            await item.click();
            await page.waitForTimeout(settle);
          }
          await page.screenshot({ path: dest, fullPage: true });
          results.push({ route, file, ok: true });
        } catch (err: any) {
          results.push({ route, file, ok: false, error: err.message });
        }
      }
    } else {
      for (const route of routes) {
        const file = sanitize(route) + '.png';
        const dest = path.join(outDir, file);
        try {
          await page.goto(joinUrl(baseUrl, route), { waitUntil: 'networkidle', timeout: opts.navTimeout || 30000 });
          // Let custom elements upgrade and charts paint before capturing.
          await page.waitForTimeout(settle);
          await page.screenshot({ path: dest, fullPage: true });
          results.push({ route, file, ok: true });
        } catch (err: any) {
          results.push({ route, file, ok: false, error: err.message });
        }
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  return results;
}
