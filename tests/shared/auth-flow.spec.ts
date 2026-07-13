import { test, expect, type Page, type Locator } from '@playwright/test';

// Verifies the generated app exposes a login AND a registration flow: a clickable
// entry point (link/button) exists for each, and activating it lands the user on the
// corresponding auth view (a URL change to a login/register route, or an inline
// login/register form — e.g. a password field or a modal). Framework-agnostic: it
// searches anchors, native buttons and Ignite UI button custom elements by their
// visible text across the root plus a handful of common auth routes.

// Visible-text patterns for the entry-point controls.
const LOGIN_TEXT = /\b(log\s?in|sign\s?in)\b/i;
const REGISTER_TEXT = /\b(register|sign\s?up|create\s+(an?\s+)?account|get\s+started)\b/i;

// URL fragments that indicate we've landed on the matching auth view.
const LOGIN_URL = /login|log-in|signin|sign-in|auth/i;
const REGISTER_URL = /register|signup|sign-up|create-account|createaccount|create-an-account/i;

// Anything a user could click to reach an auth view (native + Ignite UI controls).
const CLICKABLE = [
  'a', 'button', '[role="button"]', '[role="link"]', '[role="menuitem"]',
  'igc-button', 'igx-button', 'igc-icon-button', 'igc-nav-drawer-item',
].join(', ');

// Routes to probe when the control isn't on the current page (apps differ in where
// they surface auth entry points — header, landing page, or a dedicated route).
const CANDIDATE_ROUTES = ['/', '/login', '/signin', '/sign-in', '/auth', '/register', '/signup', '/sign-up', '/account'];

async function settle(page: Page): Promise<void> {
  // NB: do NOT wait for 'networkidle' — framework dev servers (Vite/Angular) hold an
  // open HMR WebSocket, so the network never goes idle and the wait would always stall.
  // A fixed pause lets custom elements upgrade / SPA routes render instead.
  await page.waitForTimeout(1500);
}

function control(page: Page, re: RegExp): Locator {
  // Prefer accessible role matches (most reliable), then fall back to any clickable
  // element whose visible text matches.
  const byRole = page.getByRole('link', { name: re }).or(page.getByRole('button', { name: re }));
  const byText = page.locator(CLICKABLE).filter({ hasText: re });
  return byRole.or(byText).first();
}

// Find a login/register entry point, probing common auth routes if the root lacks one.
async function findControl(page: Page, re: RegExp): Promise<Locator | null> {
  for (const route of CANDIDATE_ROUTES) {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await settle(page);
    const el = control(page, re);
    if ((await el.count()) > 0 && (await el.first().isVisible().catch(() => false))) {
      return el.first();
    }
  }
  return null;
}

// Assert that activating `entry` leads to the matching auth view.
async function assertLandsOnAuthView(page: Page, entry: Locator, urlHint: RegExp, label: string): Promise<void> {
  const before = page.url();
  await entry.scrollIntoViewIfNeeded().catch(() => {});
  await entry.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);

  const url = page.url();
  const urlMatches = urlHint.test(url);
  const urlChanged = url !== before;
  // A password field appearing (new page or modal) is strong evidence of an auth view.
  const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
  const hasAuthForm = await page.locator('form input[type="email"], input[name*="user" i], input[id*="user" i]')
    .first().isVisible().catch(() => false);

  expect(
    urlMatches || hasPassword || (urlChanged && hasAuthForm),
    `activating the ${label} control did not lead to a ${label} view (url="${url}", ` +
    `urlMatches=${urlMatches}, passwordField=${hasPassword})`,
  ).toBeTruthy();
}

test('the app exposes a login flow that navigates to a login view', async ({ page }) => {
  const login = await findControl(page, LOGIN_TEXT);
  expect(login, 'no Login / Sign in control was found anywhere in the app').not.toBeNull();
  await assertLandsOnAuthView(page, login!, LOGIN_URL, 'login');
});

test('the app exposes a registration flow that navigates to a registration view', async ({ page }) => {
  const register = await findControl(page, REGISTER_TEXT);
  expect(register, 'no Register / Sign up control was found anywhere in the app').not.toBeNull();
  await assertLandsOnAuthView(page, register!, REGISTER_URL, 'registration');
});
