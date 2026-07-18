import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name: string) => resolve(process.cwd(), 'src/server/public', name);

test('saved trucking result opens client quote with its reference', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body>
    <div id="tr-result-card" class="card" hidden><h2>Trucking result</h2></div>
    <script>
      window.openedQuote = null;
      document.addEventListener('client-quote-open', (event) => { window.openedQuote = event.detail; });
    </script>
  </body></html>`);
  await page.route('**/api/trucking/quote', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ refId: 'T00042', ranked: [] }) });
  });
  await page.addScriptTag({ path: publicFile('client-quote-actions-ui.js') });
  await page.evaluate(() => fetch('/api/trucking/quote', { method: 'POST' }));
  const button = page.getByRole('button', { name: 'Create client quote' });
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(() => page.evaluate(() => window.openedQuote)).toEqual({ type: 'trucking', refId: 'T00042' });
});

test('result action updates instead of duplicating buttons', async ({ page }) => {
  await page.setContent('<!doctype html><html><body><div id="sheet-results-card" class="card" hidden><div class="card-header"><h2>Ocean rates</h2></div></div></body></html>');
  await page.addScriptTag({ path: publicFile('client-quote-actions-ui.js') });
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('quote-result-ready', { detail: { type: 'ocean', refId: 'SH00001' } }));
    document.dispatchEvent(new CustomEvent('quote-result-ready', { detail: { type: 'ocean', refId: 'SH00002' } }));
  });
  await expect(page.locator('[data-client-quote-action]')).toHaveCount(1);
  await expect(page.locator('[data-client-quote-action]')).toHaveAttribute('data-quote-ref', 'SH00002');
});
