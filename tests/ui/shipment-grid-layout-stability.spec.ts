import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const guardScript = resolve(process.cwd(), 'src/server/public/shipment-grid-stability-guard.js');
const gridScript = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements-ui.js');
const gridCss = resolve(process.cwd(), 'src/server/public/shipment-grid-enhancements.css');

function pageHtml(): string {
  return `<!doctype html><html><body>
    <section id="tab-shipments" class="tab-pane active">
      <div class="card"><div class="table-wrap" style="width:720px"><table id="ship-table">
        <thead><tr><th>Status</th><th>Ref</th><th>Shipper</th><th>Customer</th><th>Qty</th><th></th></tr></thead>
        <tbody>
          <tr data-ref="S00001"><td data-field="operationalStatus">Active</td><td data-field="refId">S00001</td><td data-field="shipperName">Alpha Manufacturing Corporation</td><td data-field="customerName">Client A</td><td data-field="containerQuantity">1</td><td class="actions-cell"></td></tr>
          <tr data-ref="S00002"><td data-field="operationalStatus">Booked</td><td data-field="refId">S00002</td><td data-field="shipperName">Beta Export</td><td data-field="customerName">Client B</td><td data-field="containerQuantity">2</td><td class="actions-cell"></td></tr>
        </tbody>
      </table></div></div>
    </section>
  </body></html>`;
}

test('grid observer ignores enhancement-owned column moves but detects shipment rows', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.addScriptTag({ path: guardScript });

  const counts = await page.evaluate(async () => {
    const table = document.getElementById('ship-table')!;
    let callbacks = 0;
    const observer = new MutationObserver(() => { callbacks++; });
    observer.observe(table, { childList: true, subtree: true });

    const row = table.querySelector('tbody tr')!;
    row.insertBefore(row.children[3]!, row.children[1]!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterColumnMove = callbacks;

    const newRow = document.createElement('tr');
    newRow.dataset.ref = 'S00003';
    newRow.innerHTML = '<td data-field="operationalStatus">New</td>';
    table.querySelector('tbody')!.appendChild(newRow);
    await new Promise((resolve) => setTimeout(resolve, 30));
    observer.disconnect();

    return { afterColumnMove, afterNewRow: callbacks };
  });

  expect(counts.afterColumnMove).toBe(0);
  expect(counts.afterNewRow).toBe(1);
});

test('shipment table columns and horizontal scroll remain stable while idle', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.addStyleTag({ path: gridCss });
  await page.evaluate(() => {
    localStorage.setItem('loadmode.shipmentGrid.preferences.v1', JSON.stringify({
      order: ['operationalStatus', 'refId', 'customerName', 'shipperName', 'containerQuantity'],
      hidden: [],
      widths: { operationalStatus: 130, refId: 120, customerName: 180, shipperName: 240, containerQuantity: 100 },
    }));
  });
  await page.addScriptTag({ path: guardScript });
  await page.addScriptTag({ path: gridScript });
  await expect(page.getByText('Shipment spreadsheet')).toBeVisible();

  const samples = await page.evaluate(async () => {
    const wrap = document.querySelector('.table-wrap')!;
    const read = () => ({
      scrollLeft: wrap.scrollLeft,
      headers: Array.from(document.querySelectorAll('#ship-table thead th')).map((th) => {
        const box = th.getBoundingClientRect();
        return [Math.round(box.left), Math.round(box.width)];
      }),
    });
    const values = [read()];
    for (let index = 0; index < 8; index++) {
      await new Promise(requestAnimationFrame);
      values.push(read());
    }
    return values;
  });

  expect(samples.every((sample) => sample.scrollLeft === samples[0]!.scrollLeft)).toBe(true);
  expect(samples.every((sample) => JSON.stringify(sample.headers) === JSON.stringify(samples[0]!.headers))).toBe(true);
});
