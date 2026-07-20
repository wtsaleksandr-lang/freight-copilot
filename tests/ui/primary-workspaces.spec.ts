import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const scriptFile = resolve(process.cwd(), 'src/server/public/usability-shell.js');
const cssFile = resolve(process.cwd(), 'src/server/public/usability-shell.css');

test('shipments is default and core freight workspaces stay visible', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <header><a class="brand">LoadMode</a><nav><button class="tab active" data-tab="new">Ocean</button></nav></header>
    <main>
      <section id="tab-new" class="tab-pane active"><div id="sheet-dropzone"></div></section>
      <section id="tab-shipments" class="tab-pane"><div id="shipment-board"></div></section>
      <section id="tab-drayage" class="tab-pane"><div id="drayage-form"></div></section>
      <section id="tab-trucking" class="tab-pane"><div id="trucking-form"></div></section>
      <section id="tab-history" class="tab-pane"></section>
      <section id="tab-delaypredict" class="tab-pane"></section>
      <section id="tab-intellcluster" class="tab-pane"></section>
    </main>
  </body></html>`);
  await page.addStyleTag({ path: cssFile });
  await page.addScriptTag({ path: scriptFile });

  const nav = page.locator('#simple-nav');
  await expect(nav.getByRole('button', { name: 'Shipments' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Ocean freight' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Drayage' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Customs clearance' })).toBeVisible();
  await expect(page.locator('#tab-shipments')).toHaveClass(/active/);
  await expect(page.locator('#tab-new')).not.toHaveClass(/active/);
});

test('regular trucking is nested inside drayage and customs opens a prepared quote', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body>
    <header><nav><button class="tab active" data-tab="new">Ocean</button></nav></header>
    <main>
      <section id="tab-new" class="tab-pane active"></section>
      <section id="tab-shipments" class="tab-pane"></section>
      <section id="tab-drayage" class="tab-pane"><div>Drayage calculator</div></section>
      <section id="tab-trucking" class="tab-pane"><div id="trucking-form">Truck form</div></section>
      <section id="tab-history" class="tab-pane"></section>
      <section id="tab-delaypredict" class="tab-pane"></section>
      <section id="tab-intellcluster" class="tab-pane"></section>
    </main>
    <script>window.quoteDetail=null;document.addEventListener('client-quote-open',(event)=>window.quoteDetail=event.detail);</script>
  </body></html>`);
  await page.addScriptTag({ path: scriptFile });

  await expect(page.locator('#tab-trucking')).toHaveCount(0);
  await expect(page.locator('#drayage-trucking-section #trucking-form')).toHaveCount(1);

  await page.getByRole('button', { name: 'Customs clearance' }).click();
  await page.getByRole('button', { name: 'Import clearance', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.quoteDetail)).toMatchObject({
    template: 'import_usa',
    title: 'Import customs clearance quotation',
  });
});
