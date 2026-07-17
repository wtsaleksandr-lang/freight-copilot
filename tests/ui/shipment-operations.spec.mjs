import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name) => resolve(process.cwd(), 'src/server/public', name);

test('shipment operations load, add and save container milestones and follow-ups', async ({ page }) => {
  let savedBody = null;
  await page.setContent('<!doctype html><html><head><base href="http://freight.test/"></head><body><section id="tab-shipments"></section></body></html>');
  await page.route('**/api/shipments/S00042/operations', async (route) => {
    if (route.request().method() === 'PUT') {
      savedBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ refId: 'S00042', ...savedBody }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        refId: 'S00042',
        containers: [{ containerNumber: 'MSCU1234567', status: 'in_transit', eta: '2026-08-10' }],
        followUps: [{ title: 'Confirm last free day', dueDate: '2026-08-08', priority: 'high', completed: false }],
      }),
    });
  });
  await page.route('**/api/shipments/follow-ups/open', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ followUps: [{ shipmentRefId: 'S00042', title: 'Confirm last free day', dueDate: '2026-08-08', priority: 'high' }] }) });
  });
  await page.addScriptTag({ path: publicFile('shipment-operations-ui.js') });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('shipment-operations-for-ref', { detail: { refId: 'S00042' } })));
  await expect(page.locator('#ship-ops-ref')).toHaveValue('S00042');
  await expect(page.locator('[data-container-index="0"] [data-k="containerNumber"]')).toHaveValue('MSCU1234567');
  await expect(page.locator('[data-task-index="0"] [data-k="title"]')).toHaveValue('Confirm last free day');
  await page.getByRole('button', { name: 'Add container' }).click();
  await page.locator('[data-container-index="1"] [data-k="containerNumber"]').fill('OOLU7654321');
  await page.getByRole('button', { name: 'Add follow-up' }).click();
  await page.locator('[data-task-index="1"] [data-k="title"]').fill('Request empty return receipt');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => savedBody).not.toBeNull();
  expect(savedBody.containers).toHaveLength(2);
  expect(savedBody.followUps).toHaveLength(2);
  await page.getByRole('button', { name: 'Open follow-ups' }).click();
  await expect(page.getByText('S00042 · Confirm last free day')).toBeVisible();
});
