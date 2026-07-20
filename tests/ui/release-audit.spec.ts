import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const publicFile = (name: string) => resolve(process.cwd(), 'src/server/public', name);

function shellHtml(): string {
  return `<!doctype html><html><body>
    <header><a class="brand" href="#">LoadMode</a><nav>
      <button class="tab active" data-tab="new">Ocean</button>
      <button class="tab" data-tab="shipments">Shipments</button>
      <button class="tab" data-tab="drayage">Drayage</button>
      <button class="tab" data-tab="trucking">Trucking</button>
      <button class="tab" data-tab="history">History</button>
      <button class="tab" data-tab="delaypredict">DelayPredict</button>
      <button class="tab" data-tab="intellcluster">IntellCluster</button>
      <button id="help-btn">Help</button>
    </nav></header>
    <main>
      <section id="tab-new" class="tab-pane active"></section>
      <section id="tab-shipments" class="tab-pane"><div id="shipment-board"></div></section>
      <section id="tab-drayage" class="tab-pane"><div id="drayage-form"></div></section>
      <section id="tab-trucking" class="tab-pane"><div id="trucking-form"></div></section>
      <section id="tab-history" class="tab-pane"></section>
      <section id="tab-delaypredict" class="tab-pane"></section>
      <section id="tab-intellcluster" class="tab-pane"></section>
    </main>
  </body></html>`;
}

test('primary navigation remains usable by mouse and keyboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(shellHtml());
  await page.addScriptTag({ path: publicFile('usability-shell.js') });

  await expect(page.locator('#tab-shipments')).toHaveClass(/active/);
  await page.getByRole('button', { name: 'Ocean freight' }).click();
  await expect(page.locator('#tab-new')).toHaveClass(/active/);
  await page.getByRole('link', { name: 'LoadMode' }).click();
  await expect(page.locator('#tab-shipments')).toHaveClass(/active/);

  const more = page.getByRole('button', { name: 'More' });
  await more.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Import rate files' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Help' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

test('export clearance opens the real export template with starter services', async ({ page }) => {
  await page.setContent(shellHtml());
  await page.addScriptTag({ path: publicFile('usability-shell.js') });
  const detailPromise = page.evaluate(() => new Promise((resolve) => {
    document.addEventListener('client-quote-open', (event) => resolve((event as CustomEvent).detail), { once: true });
  }));

  await page.getByRole('button', { name: 'Customs clearance' }).click();
  await page.locator('#clearance-hs').fill('8703.80');
  await page.getByRole('button', { name: 'Export clearance', exact: true }).click();
  await expect(detailPromise).resolves.toMatchObject({
    template: 'export_clearance',
    title: 'Export customs clearance quotation',
    hsCode: '8703.80',
  });
  const detail = await detailPromise as { services: unknown[] };
  expect(detail.services.length).toBeGreaterThan(0);
});

test('client quote dialog is keyboard dismissible and restores focus', async ({ page }) => {
  await page.setContent('<!doctype html><html><body><button id="open">Open quote</button></body></html>');
  await page.addScriptTag({ path: publicFile('client-quote-ui.js') });
  const openButton = page.locator('#open');
  await openButton.focus();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('client-quote-open', {
    detail: {
      template: 'export_clearance',
      title: 'Export customs clearance quotation',
      services: [{ label: 'AES filing', amount: 95, basis: 'per shipment', category: 'firm' }],
    },
  })));

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#cq-template')).toHaveValue('export_clearance');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(openButton).toBeFocused();
});

test('quote preview reports a blocked popup instead of throwing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addInitScript(() => { window.open = () => null; });
  await page.addScriptTag({ path: publicFile('client-quote-ui.js') });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('client-quote-open', {
    detail: {
      template: 'export_clearance',
      services: [{ label: 'AES filing', amount: 95, basis: 'per shipment', category: 'firm' }],
    },
  })));
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#cq-status')).toContainText('blocked');
  expect(errors).toEqual([]);
});
