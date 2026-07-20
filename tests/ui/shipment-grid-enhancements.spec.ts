import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const script = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements-ui.js');
const css = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements.css');

function pageHtml(active = true): string {
  return `<!doctype html><html><body>
    <section id="tab-shipments" class="tab-pane${active ? ' active' : ''}">
      <textarea id="outside-input"></textarea>
      <div class="card"><div class="table-wrap"><table id="ship-table">
        <thead><tr><th>Status</th><th>Ref</th><th>Shipper</th><th>Customer</th><th>Qty</th><th></th></tr><tr><th></th><th></th><th></th><th></th><th></th><th></th></tr></thead>
        <tbody><tr data-ref="S00001"><td data-field="operationalStatus">📝</td><td data-field="refId">S00001</td><td data-field="shipperName">Alpha</td><td data-field="customerName">Client A</td><td data-field="containerQuantity">1</td><td class="actions-cell"></td></tr></tbody>
      </table></div></div>
    </section>
    <section id="tab-new" class="tab-pane${active ? '' : ' active'}"><textarea id="ocean-text"></textarea></section>
  </body></html>`;
}

async function dispatchPaste(page: import('playwright/test').Page, selector: string, value: string): Promise<void> {
  await page.evaluate(({ selector, value }) => {
    const target = document.querySelector(selector)!;
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => value } });
    target.dispatchEvent(event);
  }, { selector, value });
}

test('shipment grid exposes spreadsheet controls and stores hidden columns', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.addStyleTag({ path: css });
  await page.addScriptTag({ path: script });

  await expect(page.getByText('Shipment spreadsheet')).toBeVisible();
  const columnsButton = page.getByRole('button', { name: 'Columns' });
  await expect(columnsButton).toHaveAttribute('aria-expanded', 'false');
  await columnsButton.click();
  await expect(columnsButton).toHaveAttribute('aria-expanded', 'true');
  const shipper = page.locator('#shipment-columns-menu input[data-column="shipperName"]');
  await expect(shipper).toBeChecked();
  await shipper.uncheck();
  await expect(page.locator('td[data-field="shipperName"]')).toHaveClass(/shipment-column-hidden/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('loadmode.shipmentGrid.preferences.v1') || '{}'));
  expect(stored.hidden).toContain('shipperName');
  await page.keyboard.press('Escape');
  await expect(columnsButton).toHaveAttribute('aria-expanded', 'false');
});

test('Excel-style paste updates editable shipment cells and preserves numeric types', async ({ page }) => {
  await page.setContent(pageHtml());
  const requests: unknown[] = [];
  await page.route('**/api/shipments/S00001', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addScriptTag({ path: script });

  const shipper = page.locator('td[data-field="shipperName"]');
  await shipper.focus();
  await dispatchPaste(page, 'td[data-field="shipperName"]', 'New Shipper\tNew Customer\t2');

  await expect.poll(() => requests.length).toBe(3);
  expect(requests).toEqual([
    { shipperName: 'New Shipper' },
    { customerName: 'New Customer' },
    { containerQuantity: 2 },
  ]);
  await expect(shipper).toHaveText('New Shipper');
  await expect(page.locator('td[data-field="customerName"]')).toHaveText('New Customer');
  await expect(page.locator('td[data-field="containerQuantity"]')).toHaveText('2');
});

test('shipment paste cannot hijack text fields or another workspace', async ({ page }) => {
  await page.setContent(pageHtml(false));
  let requestCount = 0;
  await page.route('**/api/shipments/S00001', async (route) => {
    requestCount++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addScriptTag({ path: script });

  await page.locator('td[data-field="shipperName"]').focus();
  await page.locator('#ocean-text').focus();
  await dispatchPaste(page, '#ocean-text', 'Ocean\tRate');
  await page.waitForTimeout(100);
  expect(requestCount).toBe(0);
  await expect(page.locator('td[data-field="shipperName"]')).toHaveText('Alpha');
});

test('keyboard movement focuses cells without firing their click actions', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.addScriptTag({ path: script });
  await page.evaluate(() => {
    (window as unknown as { clickCount: number }).clickCount = 0;
    document.querySelector('td[data-field="customerName"]')?.addEventListener('click', () => {
      (window as unknown as { clickCount: number }).clickCount++;
    });
  });

  await page.locator('td[data-field="shipperName"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('td[data-field="customerName"]')).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { clickCount: number }).clickCount)).toBe(0);
});

test('malformed saved preferences fall back safely', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.evaluate(() => localStorage.setItem('loadmode.shipmentGrid.preferences.v1', '{broken'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addScriptTag({ path: script });
  await expect(page.getByText('Shipment spreadsheet')).toBeVisible();
  expect(errors).toEqual([]);
});
