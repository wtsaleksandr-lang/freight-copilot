import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name: string) => resolve(process.cwd(), 'src/server/public', name);

test('universal importer classifies and routes trucking files', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body>
    <header><nav><button class="tab" data-tab="new">Ocean</button><button class="tab" data-tab="drayage">Drayage</button><button class="tab" data-tab="trucking">Trucking</button></nav></header>
    <section id="tab-new" class="tab-pane"><input id="sheet-files" type="file" multiple><button id="sheet-parse-btn">Parse</button><div id="sheet-dropzone"></div></section>
    <section id="tab-drayage" class="tab-pane"><div id="dr-ingest-card"><input id="dr-ingest-files" type="file" multiple><button id="dr-ingest-extract">Extract</button></div></section>
    <section id="tab-trucking" class="tab-pane"><div id="tr-ingest-card"><input id="tr-ingest-files" type="file" multiple><button id="tr-ingest-btn">Extract</button></div></section>
    <script>
      window.truckingClicked = false;
      document.getElementById('tr-ingest-btn').addEventListener('click', () => { window.truckingClicked = true; });
      document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
        document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
        document.getElementById('tab-' + button.dataset.tab)?.classList.add('active');
      }));
    </script>
  </body></html>`);
  await page.route('**/api/rates/classify', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rateType: 'trucking', confidence: 'high', reason: 'FTL dry van lane pricing', alternatives: [] }) });
  });
  await page.addScriptTag({ path: publicFile('universal-rate-ingestion-ui.js') });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('universal-rate-import-open')));
  await page.locator('#universal-rate-files').setInputFiles({ name: 'truck-rate.txt', mimeType: 'text/plain', buffer: Buffer.from('FTL dry van Toronto to Chicago USD 2500') });
  await page.getByRole('button', { name: 'Detect and open reviewer' }).click();
  await expect(page.locator('#tab-trucking')).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.truckingClicked)).toBe(true);
  await expect(page.locator('#tr-ingest-files')).toHaveJSProperty('files.length', 1);
});

test('ambiguous classification asks the user instead of guessing', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.route('**/api/rates/classify', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rateType: 'ambiguous', confidence: 'low', reason: 'The batch contains ocean and trucking charges.', alternatives: ['ocean', 'trucking'] }) });
  });
  await page.addScriptTag({ path: publicFile('universal-rate-ingestion-ui.js') });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('universal-rate-import-open')));
  await page.locator('#universal-rate-files').setInputFiles({ name: 'mixed.txt', mimeType: 'text/plain', buffer: Buffer.from('ocean freight and truck delivery') });
  await page.getByRole('button', { name: 'Detect and open reviewer' }).click();
  await expect(page.getByText('Choose the rate type')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ocean' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drayage' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trucking' })).toBeVisible();
});
