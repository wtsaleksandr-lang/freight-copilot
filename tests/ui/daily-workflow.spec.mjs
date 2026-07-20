import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name) => resolve(process.cwd(), 'src/server/public', name);

test('primary navigation exposes shipments and core quote workspaces', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <header><div>LoadMode</div><nav><button class="tab active" data-tab="new">Ocean</button><button class="tab" data-tab="shipments">Shipments</button><button class="tab" data-tab="drayage">Drayage</button><button class="tab" data-tab="trucking">Trucking</button><button class="tab" data-tab="history">History</button><button class="tab" data-tab="delaypredict">DelayPredict</button><button class="tab" data-tab="intellcluster">IntellCluster</button><button id="help-btn">?</button></nav></header>
    <main><section id="tab-new" class="tab-pane active"><div id="sheet-dropzone"><button>Upload</button></div></section>
    <section id="tab-shipments" class="tab-pane"></section><section id="tab-drayage" class="tab-pane"><form id="dr-form"></form></section><section id="tab-trucking" class="tab-pane"><form id="tr-form"></form></section><section id="tab-history" class="tab-pane"></section><section id="tab-delaypredict" class="tab-pane"></section><section id="tab-intellcluster" class="tab-pane"></section></main>
  </body></html>`);
  await page.addScriptTag({ path: publicFile('usability-shell.js') });
  await expect(page.locator('#simple-nav > button, #simple-nav .simple-more-wrap > button')).toHaveCount(5);
  await expect(page.locator('header nav').first()).toHaveClass(/legacy-nav-hidden/);
  await expect(page.locator('#tab-shipments')).toHaveClass(/active/);
  await page.getByRole('button', { name: 'Drayage' }).click();
  await expect(page.locator('#tab-drayage')).toHaveClass(/active/);
  await expect(page.locator('#drayage-trucking-section #tr-form')).toHaveCount(1);
  await page.getByRole('button', { name: 'Customs clearance' }).click();
  await expect(page.locator('#tab-clearance')).toHaveClass(/active/);
});

test('one compact action menu opens shipment tools without duplicate buttons', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <section id="tab-shipments"><div id="shipment-operations-card" class="card"></div><div id="shipment-report-card" class="card"></div><div id="shipment-email-card" class="card"><input id="ship-email-ref"><textarea></textarea></div><div id="shipment-update-card" class="card"><input id="ship-update-ref"><textarea></textarea></div></section>
    <table id="ship-table"><thead><tr><th>Ref</th><th>Status</th></tr></thead><tbody><tr><td><code>S00042</code></td><td>Processing</td></tr></tbody></table>
  </body></html>`);
  await page.addScriptTag({ path: publicFile('progressive-disclosure-ui.js') });
  await page.addScriptTag({ path: publicFile('shipment-actions-ui.js') });
  await expect(page.locator('#shipment-tools-details')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Actions' })).toHaveCount(1);
  const operationEvent = page.evaluate(() => new Promise((resolve) => document.addEventListener('shipment-operations-for-ref', (event) => resolve(event.detail.refId), { once: true })));
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Containers & follow-ups' }).click();
  await expect(operationEvent).resolves.toBe('S00042');
  await expect(page.locator('#shipment-tools-details')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Create email' }).click();
  await expect(page.locator('#ship-email-ref')).toHaveValue('S00042');
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Update from message' }).click();
  await expect(page.locator('#ship-update-ref')).toHaveValue('S00042');
  await page.locator('#ship-table tbody').evaluate((body) => body.innerHTML = body.innerHTML);
  await expect(page.getByRole('button', { name: 'Actions' })).toHaveCount(1);
});

test('import cards stay hidden until that import workflow is selected', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <div id="dr-ingest-card" class="card"><button>Upload drayage rates</button></div>
    <div id="tr-ingest-card" class="card"><button>Upload trucking rates</button></div>
  </body></html>`);
  await page.addScriptTag({ path: publicFile('progressive-disclosure-ui.js') });
  await expect(page.locator('#dr-ingest-card')).toHaveClass(/workflow-hidden/);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workflow-selected', { detail: { kind: 'import', tab: 'drayage' } })));
  await expect(page.locator('#dr-ingest-card')).not.toHaveClass(/workflow-hidden/);
  await expect(page.locator('#tr-ingest-card')).toHaveClass(/workflow-hidden/);
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('workflow-show-all')));
  await expect(page.locator('#tr-ingest-card')).not.toHaveClass(/workflow-hidden/);
});
