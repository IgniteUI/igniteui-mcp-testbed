'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { Screenshot } from '../types.ts';

export interface ShootOpts {
  settle?: number;
  navTimeout?: number;
  /** Cap on the best-effort quiet-network wait after navigation. */
  netIdleTimeout?: number;
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

// Navigate, then wait for the network to go quiet — but only as a BEST EFFORT.
//
// This used to be `goto(..., { waitUntil: 'networkidle' })`, which never returns
// against a dev server: Vite/Angular hold an HMR channel open for the life of the
// page, so the idle event the navigation was waiting on cannot fire, and every route
// failed with "Timeout 30000ms exceeded" while the app was serving perfectly (the
// Playwright verification stage passed against the same URL seconds later).
// tests/shared/smoke.spec.ts already avoids networkidle for exactly this reason.
//
// `domcontentloaded` always fires; the quiet-network wait then rides along inside a
// bounded catch, so a page that DOES settle is still given its moment, and one that
// never can costs the timeout instead of the whole capture.
//
// The timeout is minutes, not seconds, because THE FIRST navigation is not a page
// load — it is a build. Vite binds the port in ~2s (so the port-based readiness check
// passes at once) and only prebundles dependencies when the first module is requested;
// `<script type="module">` is deferred, so DOMContentLoaded waits out that prebundle.
// With Ignite UI's grid/chart packages that ran past the old 30s cap, and every route
// failed while the app was serving — the failed attempt warmed the optimizer, which is
// why the verification tests passed seconds later. One retry covers the related case
// where Vite optimizes new deps and forces a page reload mid-navigation.
export async function navigate(page: any, url: string, opts: ShootOpts): Promise<void> {
  const navTimeout = opts.navTimeout != null
    ? opts.navTimeout
    : Number(process.env.SCREENSHOT_NAV_TIMEOUT_MS || 120000);
  const idle = opts.netIdleTimeout != null
    ? opts.netIdleTimeout
    : Number(process.env.SCREENSHOT_NETIDLE_MS || 5000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (err) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  }
  if (idle > 0) await page.waitForLoadState('networkidle', { timeout: idle }).catch(() => {});
}

// Screenshot every route of a running app. Playwright is required lazily so the
// wizard backend still loads on hosts without Chromium installed (it's only present
// in the container). Per-route try/catch — one broken route never aborts the set.
export async function shoot(baseUrl: string, routes: string[], outDir: string, opts: ShootOpts = {}): Promise<Screenshot[]> {
  const { chromium } = await import('playwright');
  fs.mkdirSync(outDir, { recursive: true });
  // Wait after navigation before capturing: the load events fire before custom
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
        await navigate(page, joinUrl(baseUrl, '/'), opts);
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
          if (await item.count() === 0) {
            await page.screenshot({ path: dest, fullPage: true });
            results.push({ route, file, ok: false, error: `nav item not found: ${displayName}` });
            continue;
          }
          await item.click();
          await page.waitForTimeout(settle);
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
          await navigate(page, joinUrl(baseUrl, route), opts);
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
