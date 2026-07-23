import { test, expect, type Page } from '@playwright/test';

// Verifies that an app generated from the "Mordor management" prompt exposes every view
// the prompt asks for, and that each one is built with Ignite UI components:
//
//   1. Battalion reports — per-battalion numbers, morale, health and primary race.
//   2. An org chart of generals and lieutenants.
//   3. Food suppliers — availability and food production.
//   4. Armory suppliers — smithing production by location.
//   5. Spy network reports — with highlights regarding the One Ring.
//
// Framework-agnostic: rendered text is collected through open shadow roots (the
// igc/igr/igb grids render headers and cells inside shadow DOM, where body.innerText
// can't see them), and "built with Ignite UI" means at least one visible element whose
// tag carries an igx-/igc-/igr-/igb- prefix on the same view as the domain content.
// Each view is looked for on the root (single-page dashboards), on routes advertised by
// the app's own nav, on common route spellings, and finally by clicking a matching nav
// entry (tab-style UIs that switch views without changing the URL).

interface RequiredView {
  name: string;
  nav: RegExp;       // matches a nav entry's visible text or href
  routes: string[];  // common dedicated-route spellings to probe
  content: RegExp[]; // domain evidence — ALL must appear in the view's rendered text
}

const VIEWS: RequiredView[] = [
  {
    name: 'battalion reports',
    nav: /battalion|garrison|legion|regiment|arm(y|ies)|forces|troops|military/i,
    routes: ['/battalions', '/battalion', '/army', '/armies', '/forces', '/troops', '/military', '/reports'],
    content: [
      /battalion|garrison|legion|regiment|cohort|warband|war\s?band/i,
      /morale/i,
      /health/i,
      /orc|uruk|troll|goblin|easterling|haradrim|nazg|warg|\brace\b/i,
    ],
  },
  {
    name: 'org chart of generals and lieutenants',
    nav: /org\s?-?chart|organi[sz]ation|hierarch|command|structure|leadership|generals?\b/i,
    routes: ['/org-chart', '/orgchart', '/organization', '/hierarchy', '/command', '/generals', '/leadership', '/command-structure'],
    content: [
      /general/i,
      /lieutenant|captain|commander/i,
    ],
  },
  {
    name: 'food suppliers and production',
    nav: /food|provision|ration|farm|harvest/i,
    routes: ['/food', '/food-suppliers', '/food-production', '/suppliers', '/supplies', '/provisions', '/logistics'],
    content: [
      /food|provision|ration|grain|harvest/i,
      /suppli|vendor|provider/i,
      /production|availab|output|stock|yield/i,
    ],
  },
  {
    name: 'armory suppliers and smithing production',
    nav: /armor|armour|weapon|smith|forge|\barms\b/i,
    routes: ['/armory', '/armoury', '/smithing', '/weapons', '/forges', '/arms', '/armory-suppliers'],
    content: [
      /armor|armour|weapon|smith|forge/i,
      /suppli|vendor|provider|production|output/i,
      /location|region|\bsite\b|isengard|barad|morgul|gorgoroth|mount\s?doom|minas|udun|nurn/i,
    ],
  },
  {
    name: 'spy network reports',
    nav: /sp(y|ies)|intelligence|intel\b|espionage/i,
    routes: ['/spies', '/spy-network', '/spy-reports', '/intelligence', '/intel', '/espionage', '/reports'],
    content: [
      /sp(y|ies)|intelligence|espionage|agent/i,
      /\bring\b/i,
    ],
  },
];

// Anything a user could click to switch views (native + Ignite UI controls).
const CLICKABLE = [
  'a', 'button', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  'igc-button', 'igx-button', 'igc-tab', 'igx-tab-header', 'igc-nav-drawer-item', 'igx-nav-drawer-item',
].join(', ');

async function settle(page: Page): Promise<void> {
  // NB: do NOT wait for 'networkidle' — framework dev servers (Vite/Angular) hold an
  // open HMR WebSocket, so the network never goes idle. A fixed pause lets custom
  // elements upgrade and SPA routes render instead.
  await page.waitForTimeout(1500);
}

async function goto(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  await settle(page);
}

// All rendered text on the page, traversing open shadow roots (grid headers/cells live
// there in the WC-based frameworks) and picking up label-bearing attributes that some
// Ignite UI components render from (e.g. igc-column's `header`).
async function renderedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const out: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        if (t) out.push(t);
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (skip.has(el.tagName)) return;
        for (const attr of ['header', 'label', 'aria-label', 'title', 'placeholder']) {
          const v = el.getAttribute(attr);
          if (v) out.push(v);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
      node.childNodes.forEach(walk);
    };
    walk(document.body);
    return out.join(' ');
  });
}

// Tags of all visible Ignite UI elements (igx-/igc-/igr-/igb- prefixes cover Angular,
// Web Components, React and Blazor), traversing open shadow roots so components inside
// a shadow-DOM app shell are found too.
async function visibleIgTags(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tags = new Set<string>();
    const walk = (root: ParentNode): void => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        const tag = el.tagName.toLowerCase();
        if (/^ig[xcrb]-/.test(tag)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) tags.add(tag);
        }
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return [...tags].sort();
  });
}

interface CheckResult { ok: boolean; problems: string[] }

async function checkCurrentView(page: Page, view: RequiredView): Promise<CheckResult> {
  const text = await renderedText(page);
  const missing = view.content.filter((re) => !re.test(text));
  const igTags = await visibleIgTags(page);
  const problems: string[] = [];
  if (missing.length) problems.push(`missing content ${missing.map(String).join(', ')}`);
  if (!igTags.length) problems.push('no visible Ignite UI (igx-/igc-/igr-/igb-) elements');
  return { ok: problems.length === 0, problems };
}

// Routes the app's own navigation advertises for this view (href or visible text match).
async function harvestNavRoutes(page: Page, view: RequiredView): Promise<string[]> {
  const anchors = await page.$$eval('a[href]', (els) =>
    els.map((a) => ({ href: a.getAttribute('href') ?? '', text: a.textContent ?? '' })));
  const routes: string[] = [];
  for (const { href, text } of anchors) {
    if (!href || /^(https?:|mailto:|javascript:)/i.test(href) || href === '#') continue;
    if (view.nav.test(href) || view.nav.test(text)) routes.push(href);
  }
  return [...new Set(routes)].slice(0, 4);
}

// Tab-style UIs switch views without a URL change — click a matching nav entry instead.
async function clickNavEntry(page: Page, view: RequiredView): Promise<boolean> {
  const byRole = page.getByRole('link', { name: view.nav })
    .or(page.getByRole('button', { name: view.nav }))
    .or(page.getByRole('tab', { name: view.nav }));
  const byText = page.locator(CLICKABLE).filter({ hasText: view.nav });
  const entry = byRole.or(byText).first();
  if (!(await entry.count()) || !(await entry.isVisible().catch(() => false))) return false;
  await entry.scrollIntoViewIfNeeded().catch(() => {});
  await entry.click({ force: true }).catch(() => {});
  await settle(page);
  return true;
}

async function verifyRequiredView(page: Page, view: RequiredView): Promise<void> {
  const attempts: string[] = [];
  const tryHere = async (where: string): Promise<boolean> => {
    const res = await checkCurrentView(page, view);
    if (!res.ok) attempts.push(`  ${where} — ${res.problems.join('; ')}`);
    return res.ok;
  };

  // 1. The view may live on the root itself (single-page dashboard).
  await goto(page, '/');
  if (await tryHere('/')) return;

  // 2. Routes the app's own nav points at, then common route spellings.
  const seen = new Set(['/']);
  for (const route of [...(await harvestNavRoutes(page, view)), ...view.routes]) {
    const key = route.replace(/\/+$/, '') || '/';
    if (seen.has(key)) continue;
    seen.add(key);
    await goto(page, route);
    if (await tryHere(route)) return;
  }

  // 3. Click a matching nav entry from the root (covers tabs / drawers / hash-less views).
  await goto(page, '/');
  if (await clickNavEntry(page, view) && await tryHere('after clicking a nav entry')) return;

  expect(
    false,
    `required view "${view.name}" was not found with its required content and Ignite UI components.\n` +
    `Attempts:\n${attempts.join('\n')}`,
  ).toBeTruthy();
}

for (const view of VIEWS) {
  test(`the app provides the ${view.name} view, built with Ignite UI components`, async ({ page }) => {
    // Probing several routes at ~2s a piece doesn't fit the default 30s budget.
    test.setTimeout(60_000);
    await verifyRequiredView(page, view);
  });
}
