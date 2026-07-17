import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name: string) => resolve(process.cwd(), 'src/server/public', name);

test('universal importer asks the user when classification is ambiguous', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.route('**/api/rates/classify', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rateType: 'ambiguous',
        confidence: 'low',
        reason: 'The batch contains ocean and trucking charges.',
        alternatives: ['ocean', 'trucking'],
      }),
    });
  });
  await page.addScriptTag({ path: publicFile('universal-rate-ingestion-ui.js') });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('universal-rate-import-open')));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#universal-rate-files').setInputFiles({
    name: 'mixed.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ocean freight and truck delivery'),
  });
  await page.getByRole('button', { name: 'Detect and open reviewer' }).click();
  await expect(page.getByText('Choose the rate type')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ocean' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drayage' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trucking' })).toBeVisible();
});
