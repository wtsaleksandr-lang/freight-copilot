import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name) => resolve(process.cwd(), 'src/server/public', name);

test('simple navigation exposes four daily choices and opens quote chooser', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <header><div>LoadMode</div><nav><button class="tab active" data-tab="new">Ocean</button><button class="tab" data-tab="shipments">Shipments</button><button class="tab" data-tab="drayage">Drayage</button><button class="tab" data-tab="trucking">Trucking</button><button class="tab" data-tab="history">History</button><button class="tab" data-tab="delaypredict">DelayPredict</button><button class="tab" data-tab="intellcluster">IntellCluster</button><button id="help-btn">?</button></nav></header>
    <section id="tab-new" class="tab-pane active"><div id="sheet-dropzone"><button>Upload</button></div></section>
    <section id="tab-shipments" class="tab-pane"></section><section id="tab-drayage" class="tab-pane"><form id="dr-form"></form></section><section id="tab-trucking" class="tab-pane"><form id="tr-form"></form></section><section id="tab-history" class="tab-pane"></section><section id="tab-delaypredict" class="tab-pane"></section><section id="tab-intellcluster" class="tab-pane"></section>
    <script>document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));document.getElementById('tab-'+b.dataset.tab)?.classList.add('active')}));</script>
  </body></html>`);
  await page.addScriptTag({ path: publicFile('usability-shell.js') });
  await expect(page.locator('#simple-nav > button, #simple-nav .simple-more-wrap > button')).toHaveCount(4);
  await expect(page.locator('header nav').first()).toHaveClass(/legacy-nav-hidden/);
  await page.getByRole('button', { name: 'Get a quote' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /Drayage quote/ }).click();
  await expect(page.locator('#tab-drayage')).toHaveClass(/active/);
});

test('one compact action menu fills shipment tools without duplicate buttons', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <div id="shipment-report-card"></div><div id="shipment-email-card"><input id="ship-email-ref"><textarea></textarea></div><div id="shipment-update-card"><input id="ship-update-ref"><textarea></textarea></div>
    <table id="ship-table"><thead><tr><th>Ref</th><th>Status</th></tr></thead><tbody><tr><td><code>S00042</code></td><td>Processing</td></tr></tbody></table>
  </body></html>`);
  await page.addScriptTag({ path: publicFile('shipment-actions-ui.js') });
  await expect(page.getByRole('button', { name: 'Actions' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Create email' }).click();
  await expect(page.locator('#ship-email-ref')).toHaveValue('S00042');
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Update from message' }).click();
  await expect(page.locator('#ship-update-ref')).toHaveValue('S00042');
  await page.locator('#ship-table tbody').evaluate((body) => body.innerHTML = body.innerHTML);
  await expect(page.getByRole('button', { name: 'Actions' })).toHaveCount(1);
});