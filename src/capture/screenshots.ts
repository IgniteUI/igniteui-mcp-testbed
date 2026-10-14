'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { terminateTree, treeAlive } from '../proc/exec.ts';
import type { Screenshot } from '../types.ts';

export interface ShootOpts {
  settle?: number;
  navTimeout?: number;
  /** Cap on the best-effort quiet-network wait after navigation. */
  netIdleTimeout?: number;
  /** When true, routes are logical page names (state-based nav). Navigate to root
   * once, then click the matching sidebar/nav item for each page. */
  stateNav?: boolean;
  log?: (msg: string) => void;
  isCancelled?: (() => boolean) | null;
  /** Receives the Chromium process so the matrix cancel can kill it like any other child. */
  onChild?: ((child: ChildProcess) => void) | null;
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

// Beyond these we capture the viewport only: an agent-built layout with an unbounded
// size (e.g. a grid at height:100% in an auto-height parent, or runaway horizontal
// overflow) can make a fullPage bitmap large enough to stall or OOM Chromium. fullPage
// spans the whole document in BOTH directions, so the cap is on area, not just height.
const MAX_FULLPAGE_HEIGHT = 12000;
const MAX_FULLPAGE_PIXELS = 1280 * MAX_FULLPAGE_HEIGHT;

// Playwright's own timeouts don't cover everything (the fonts wait inside screenshot(),
// a renderer wedged by an agent's infinite loop, close() on a stuck browser), so every
// step that can block is raced against a hard deadline.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(t));
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

async function capture(page: any, dest: string): Promise<void> {
  const size = await withTimeout<{ w: number; h: number }>(
    page.evaluate(`(() => { const d = document.documentElement, b = document.body || d;
      return { w: Math.max(d.scrollWidth, b.scrollWidth), h: Math.max(d.scrollHeight, b.scrollHeight) }; })()`),
    5000, 'measure',
  ).catch(() => ({ w: 0, h: 0 }));
  const fullPage = size.w > 0 && size.h > 0 && size.h <= MAX_FULLPAGE_HEIGHT && size.w * size.h <= MAX_FULLPAGE_PIXELS;
  await page.screenshot({ path: dest, fullPage, timeout: 30000, animations: 'disabled', caret: 'hide' });
}

const firstLine = (s: unknown) => String(s).split('\n')[0];

// Screenshot every route of a running app. Playwright is required lazily so the
// wizard backend still loads on hosts without Chromium installed (it's only present
// in the container). Per-route try/catch — one broken route never aborts the set.
export async function shoot(baseUrl: string, routes: string[], outDir: string, opts: ShootOpts = {}): Promise<Screenshot[]> {
  const { chromium } = await import('playwright');
  fs.mkdirSync(outDir, { recursive: true });
  // Wait after navigation before capturing: the load events fire before custom
  // elements upgrade / charts paint, so a short page can screenshot blank-white.
  const settle = opts.settle != null ? opts.settle : Number(process.env.SCREENSHOT_PAGE_SETTLE_MS || 5000);
  const navOpts: ShootOpts = {
    ...opts,
    navTimeout: opts.navTimeout != null ? opts.navTimeout : Number(process.env.SCREENSHOT_NAV_TIMEOUT_MS || 120000),
    netIdleTimeout: opts.netIdleTimeout != null ? opts.netIdleTimeout : Number(process.env.SCREENSHOT_NETIDLE_MS || 5000),
  };
  // Must outlast navigate()'s own worst case (two goto attempts + the idle wait) plus
  // the settle and the capture, or the outer deadline pre-empts the retry.
  const routeTimeout = Number(process.env.SCREENSHOT_ROUTE_TIMEOUT_MS
    || 2 * navOpts.navTimeout! + navOpts.netIdleTimeout! + settle + 60000);
  const goTo = async (p: any, url: string) => { await navigate(p, url, navOpts); await p.waitForTimeout(settle); };
  const log = opts.log || (() => {});
  const cancelled = () => !!(opts.isCancelled && opts.isCancelled());
  const rootUrl = joinUrl(baseUrl, '/');

  // launchServer rather than launch: it hands back the Chromium process, so a browser
  // that won't close (or a cancel) can be force-killed instead of merely abandoned —
  // an abandoned one would survive into the next matrix entry.
  let server: any = null;
  let browser: any = null;
  let ctx: any = null;
  let page: any = null;
  let killing: Promise<void> | null = null;

  // Resolve only once Chromium is confirmed gone (or a bounded wait says it isn't), so
  // recovery or the next matrix entry never overlaps a browser that is still dying.
  const killServer = async (s: any) => {
    const proc: ChildProcess = s.process();
    await withTimeout<void>(s.kill(), 10000, 'chromium kill').catch(() => {});
    if (!proc || !treeAlive(proc)) return;
    const { confirmed } = await terminateTree(proc);
    if (!confirmed) log(`warning: Chromium (pid ${proc.pid}) did not confirm exit after SIGKILL; continuing`);
  };

  const killBrowser = async () => {
    if (killing) return killing;
    const s = server; server = null; browser = null; ctx = null; page = null;
    if (!s) return;
    killing = killServer(s).finally(() => { killing = null; });
    return killing;
  };

  // A cancel (or recovery) can kill the browser while a start/open is mid-await. Each
  // step builds into locals and re-checks afterwards, so a stale continuation throws
  // instead of reviving cleared state or launching Chromium after the kill.
  const aborted = (s: any) => cancelled() || server !== s;
  const cancelErr = () => new Error('cancelled');

  const openPage = async () => {
    const s = server, c = ctx;
    if (!c || aborted(s)) throw cancelErr();
    const p = await withTimeout<any>(c.newPage(), 15000, 'new page');
    if (aborted(s)) { p.close().catch(() => {}); throw cancelErr(); }
    p.on('dialog', (d: any) => d.dismiss().catch(() => {}));
    page = p;
    // State-nav clicks need the app loaded, so that mode always starts from the root.
    if (opts.stateNav) await withTimeout(goTo(p, rootUrl), routeTimeout, 'root navigation');
  };

  const startBrowser = async () => {
    if (killing) await killing;
    if (cancelled()) throw cancelErr();
    log('screenshot: launching Chromium');
    const launching = chromium.launchServer({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let s: any;
    try {
      s = await withTimeout<any>(launching, 60000, 'chromium launch');
    } catch (e) {
      // The launch may still complete after its deadline; don't let that Chromium leak.
      launching.then(killServer, () => {});
      throw e;
    }
    if (cancelled()) { await killServer(s); throw cancelErr(); }
    server = s;
    opts.onChild?.(s.process());
    const b = await withTimeout<any>(chromium.connect(s.wsEndpoint()), 30000, 'chromium connect');
    if (aborted(s)) { b.close().catch(() => {}); throw cancelErr(); }
    browser = b;
    const c = await withTimeout<any>(b.newContext({ viewport: { width: 1280, height: 900 } }), 15000, 'new context');
    if (aborted(s)) throw cancelErr();
    ctx = c;
    await openPage();
  };

  // After any hard failure the page may be crashed, closed, or wedged (Playwright's own
  // "Timeout … exceeded" and "Target crashed" included), so never reuse it: open a fresh
  // page, or restart Chromium entirely when the browser itself went away.
  const recover = async () => {
    if (browser && browser.isConnected()) {
      if (page) await withTimeout(page.close(), 5000, 'page close').catch(() => {});
      try { await openPage(); return; } catch (e: any) { log(`  warning: fresh page failed — ${firstLine(e.message)}; restarting Chromium`); }
    }
    await killBrowser();
    await startBrowser();
  };

  // Cancel must interrupt an in-flight capture, not wait for its deadline: killing the
  // browser rejects whatever Playwright call is pending.
  const cancelPoll = setInterval(() => { if (cancelled() && server) killBrowser(); }, 1000);

  const results: Screenshot[] = [];
  const usedFiles = new Set<string>();
  // '/a/b' and '/a_b' both sanitize to 'a_b'; suffix collisions so one can't overwrite the other.
  const fileFor = (route: string) => {
    const base = sanitize(route);
    let file = base + '.png';
    for (let n = 2; usedFiles.has(file); n++) file = `${base}-${n}.png`;
    usedFiles.add(file);
    return file;
  };

  try {
    try {
      await startBrowser();
    } catch (err: any) {
      // Root page (state-nav) or the browser itself is unavailable — every route would fail.
      log(`  ✗ ${cancelled() ? 'cancelled' : firstLine(err.message)}`);
      for (const route of routes) results.push({ route, file: fileFor(route), ok: false, error: cancelled() ? 'cancelled' : err.message });
      return results;
    }

    // `work` resolves to a warning when it captured *something* but not the page asked for.
    const shootOne = async (route: string, i: number, work: (dest: string, setPhase: (p: string) => void) => Promise<string | void>) => {
      const file = fileFor(route);
      if (cancelled()) { results.push({ route, file, ok: false, error: 'cancelled' }); return; }
      let phase = 'navigate';
      const t0 = Date.now();
      log(`  → [${i + 1}/${routes.length}] ${route}`);
      try {
        if (!page) await recover();
        const warning = await withTimeout(work(path.join(outDir, file), (p) => { phase = p; }), routeTimeout, `route ${route}`);
        results.push(warning ? { route, file, ok: true, warning } : { route, file, ok: true });
        log(`  ${warning ? '⚠' : '✓'} ${route} (${Date.now() - t0}ms)${warning ? ` — ${warning}` : ''}`);
      } catch (err: any) {
        const msg = cancelled() ? 'cancelled' : `${firstLine(err.message)} (during ${phase})`;
        results.push({ route, file, ok: false, error: msg });
        log(`  ✗ ${route} — ${msg}`);
        if (!cancelled()) await recover().catch((e: any) => { page = null; log(`  warning: recovery failed — ${firstLine(e.message)}`); });
      }
    };

    // Nav containers to search inside (widening selector so custom sidebar class names work).
    const NAV_SEL = 'nav, aside, [role="navigation"], [class*="sidebar"], [class*="side-bar"], [class*="nav"]';
    for (const [i, route] of routes.entries()) {
      if (opts.stateNav) {
        // State-based navigation (React useState): the app has no URL routes, so click
        // the sidebar/nav item whose text matches the page name ('/dashboard' → 'Dashboard').
        const pageName = route.replace(/^\//, '');
        const displayName = pageName.charAt(0).toUpperCase() + pageName.slice(1);
        await shootOne(route, i, async (dest, setPhase) => {
          setPhase('find nav item');
          const item = page.locator(NAV_SEL).getByText(displayName, { exact: false }).first();
          if (await item.count() === 0) {
            setPhase('capture');
            await capture(page, dest);
            return `nav item not found: ${displayName} — captured the current page instead`;
          }
          setPhase('click nav item');
          await item.click({ timeout: 10000 });
          await page.waitForTimeout(settle);
          setPhase('capture');
          await capture(page, dest);
        });
      } else {
        await shootOne(route, i, async (dest, setPhase) => {
          await goTo(page, joinUrl(baseUrl, route));
          setPhase('capture');
          await capture(page, dest);
        });
      }
    }
  } finally {
    clearInterval(cancelPoll);
    // close() on a browser with a hung renderer can block forever; the files are already
    // on disk, so bound it and then force-kill whatever is left.
    if (browser) await withTimeout(browser.close(), 10000, 'browser close').catch((e: any) => log(`warning: ${e.message}; killing Chromium`));
    await killBrowser();
  }
  return results;
}
