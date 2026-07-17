import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name: string) => resolve(process.cwd(), 'src/server/public', name);

test('system check stays under More and reports readiness', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><base href="http://freight.test/"></head><body>
    <header><div>Freight Copilot</div><nav><button class="tab" data-tab="new">Ocean</button><button class="tab" data-tab="shipments">Shipments</button><button class="tab" data-tab="history">History</button><button class="tab" data-tab="delaypredict">DelayPredict</button><button class="tab" data-tab="intellcluster">IntellCluster</button><button id="help-btn">?</button></nav></header>
    <section id="tab-new" class="tab-pane"></section><section id="tab-shipments" class="tab-pane"></section><section id="tab-history" class="tab-pane"></section><section id="tab-delaypredict" class="tab-pane"></section><section id="tab-intellcluster" class="tab-pane"></section>
  </body></html>`);
  await page.route('**/api/health/ready', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        database: 'connected',
        latencyMs: 17,
        tables: { shipments: true, quote_bundles: true, drayage_quotes: true, trucking_quotes: true, shipment_containers: true, shipment_follow_ups: true },
        missingTables: [],
      }),
    });
  });
  await page.addScriptTag({ path: publicFile('system-check-ui.js') });
  await page.addScriptTag({ path: publicFile('usability-shell.js') });
  await expect(page.locator('#simple-nav > button, #simple-nav .simple-more-wrap > button')).toHaveCount(4);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'System check' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Database: connected · 17 ms')).toBeVisible();
});
