import { test, expect } from '@playwright/test';

// Baseline smoke tests that run for every platform. They target the app's dev server
// through Playwright's configured `baseURL`, so navigation uses relative paths.

test('app root responds without an error status', async ({ page }) => {
  const res = await page.goto('/');
  expect(res, 'no response from the app root').not.toBeNull();
  expect(res!.status(), `app root returned HTTP ${res!.status()}`).toBeLessThan(400);
});

test('app renders a non-empty body', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // NB: avoid waitForLoadState('networkidle') — framework dev servers keep an HMR
  // WebSocket open, so the network never goes idle. A fixed pause lets custom elements
  // upgrade before we read the rendered text.
  await page.waitForTimeout(2500);
  // innerText stops at shadow roots, and a Web Components app renders entirely inside its
  // root element's shadow DOM — so walk the rendered (composed) tree and collect visible text.
  const text = await page.evaluate(() => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const parts: string[] = [];
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.nodeType === Node.TEXT_NODE) { parts.push(n.textContent || ''); continue; }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const el = n as Element;
        if (SKIP.has(el.tagName)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (el instanceof HTMLSlotElement) {
          const assigned = el.assignedNodes({ flatten: true });
          walk(assigned.length ? assigned : Array.from(el.childNodes));
        } else {
          // A shadow host renders its shadow tree; its light children only appear via slots.
          walk(Array.from((el.shadowRoot ?? el).childNodes));
        }
      }
    };
    walk(Array.from(document.body.childNodes));
    return parts.join(' ').trim();
  });
  expect(text.length, 'app body rendered empty').toBeGreaterThan(0);
});
