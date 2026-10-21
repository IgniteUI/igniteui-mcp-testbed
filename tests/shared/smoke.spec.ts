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
  // innerText stops at shadow roots, and a Web Components app renders entirely inside
  // its root element's shadow DOM — so walk open shadow roots and collect the text.
  const text = await page.evaluate(() => {
    const parts: string[] = [];
    const walk = (root: Node) => {
      for (const n of Array.from(root.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent || '');
        else if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n as Element;
          if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
          if (el.shadowRoot) walk(el.shadowRoot);
          walk(el);
        }
      }
    };
    walk(document.body);
    return parts.join(' ').trim();
  });
  expect(text.length, 'app body rendered empty').toBeGreaterThan(0);
});
