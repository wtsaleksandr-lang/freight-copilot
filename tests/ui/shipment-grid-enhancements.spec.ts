import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const script = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements-ui.js');
const css = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements.css');

function pageHtml(): string {
  return `<!doctype html><html><body>
    <section id="tab-shipments" class="tab-pane active">
      <div class="card"><div class="table-wrap"><table id="ship-table">
        <thead><tr><th>Status</th><th>Ref</th><th>Shipper</th><th>Customer</th><th></th></tr><tr><th></th><th></th><th></th><th></th><th></th></tr></thead>
        <tbody><tr data-ref="S00001"><td data-field="operationalStatus">📝</td><td data-field="refId">S00001</td><td data-field="shipperName">Alpha</td><td data-field="customerName">Client A</td><td class="actions-cell"></td></tr></tbody>
      </table></div></div>
    </section>
  </body></html>`;
}

test('shipment grid exposes spreadsheet controls and stores hidden columns', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.addStyleTag({ path: css });
  await page.addScriptTag({ path: script });

  await expect(page.getByText('Shipment spreadsheet')).toBeVisible();
  await page.getByRole('button', { name: 'Columns' }).click();
  const shipper = page.locator('#shipment-columns-menu input[data-column="shipperName"]');
  await expect(shipper).toBeChecked();
  await shipper.uncheck();
  await expect(page.locator('td[data-field="shipperName"]')).toHaveClass(/shipment-column-hidden/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('loadmode.shipmentGrid.preferences.v1') || '{}'));
  expect(stored.hidden).toContain('shipperName');
});

test('Excel-style paste updates editable shipment cells', async ({ page }) => {
  await page.setContent(pageHtml());
  const requests: unknown[] = [];
  await page.route('**/api/shipments/S00001', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addScriptTag({ path: script });

  const shipper = page.locator('td[data-field="shipperName"]');
  await shipper.click();
  await shipper.focus();
  await page.evaluate(() => {
    const target = document.querySelector('td[data-field="shipperName"]')!;
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'New Shipper\tNew Customer' } });
    target.dispatchEvent(event);
  });

  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual([{ shipperName: 'New Shipper' }, { customerName: 'New Customer' }]);
  await expect(shipper).toHaveText('New Shipper');
  await expect(page.locator('td[data-field="customerName"]')).toHaveText('New Customer');
});
