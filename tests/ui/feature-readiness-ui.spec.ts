import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const shellScript = resolve(process.cwd(), 'src/server/public/usability-shell.js');
const systemScript = resolve(process.cwd(), 'src/server/public/system-check-ui.js');
const shellCss = resolve(process.cwd(), 'src/server/public/usability-shell.css');

function html(): string {
  return `<!doctype html><html><body>
    <header><a class="brand" href="#">LoadMode</a><nav><button id="help-btn">?</button></nav></header>
    <main>
      <section id="tab-new" class="tab-pane"><div class="card">Ocean</div></section>
      <section id="tab-shipments" class="tab-pane"><div class="card">Board</div></section>
      <section id="tab-drayage" class="tab-pane"><div class="card">Drayage</div></section>
      <section id="tab-trucking" class="tab-pane"><div class="card">Trucking</div></section>
      <section id="tab-history" class="tab-pane"><div class="card">History</div></section>
      <section id="tab-delaypredict" class="tab-pane"><div class="card">Delay</div></section>
      <section id="tab-intellcluster" class="tab-pane"><div class="card">Intel</div></section>
    </main>
  </body></html>`;
}

const readiness = {
  status: 'ready', database: 'connected', latencyMs: 12, checkedAt: new Date().toISOString(),
  tables: { shipments: true, quote_bundles: true, drayage_quotes: true, trucking_quotes: true, shipment_containers: true, shipment_follow_ups: true },
  configuration: { aiProvider: 'anthropic', aiConfigured: true, realChrome: false, delayPredict: false, basicAuth: true },
  features: [
    { id: 'shipments', name: 'Shipment spreadsheet', area: 'Shipments', state: 'ready', summary: 'Manage shipments.' },
    { id: 'shipment-ai-intake', name: 'AI shipment document extraction', area: 'Shipments', state: 'review_required', summary: 'Extract shipment data.', action: 'Review extracted fields.' },
    { id: 'ocean-live', name: 'Live carrier portal automation', area: 'Ocean freight', state: 'setup_required', summary: 'Run portals.', action: 'Enable real Chrome.' },
  ],
};

async function install(page: import('playwright/test').Page, response = readiness): Promise<void> {
  await page.setContent(html());
  await page.route('**/api/health/ready', (route) => route.fulfill({ status: response.status === 'unavailable' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.addStyleTag({ path: shellCss });
  await page.addScriptTag({ path: systemScript });
  await page.addScriptTag({ path: shellScript });
}

test('core workflows are visible and explain how to start', async ({ page }) => {
  await install(page);
  await expect(page.getByRole('button', { name: 'Shipments' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ocean freight' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Drayage' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Customs clearance' })).toBeVisible();
  await expect(page.locator('#tab-shipments > .workspace-guide')).toContainText('drop shipment documents');
  await page.getByRole('button', { name: 'Drayage' }).click();
  await expect(page.locator('#tab-drayage > .workspace-guide')).toContainText('Historical estimates are guidance only');
});

test('readiness is permanently discoverable and reports feature states', async ({ page }) => {
  await install(page);
  const button = page.getByRole('button', { name: 'Open feature readiness' });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('data-state', 'degraded');
  await button.click();
  await expect(page.getByRole('heading', { name: 'Feature readiness' })).toBeVisible();
  await expect(page.getByText('Shipment spreadsheet')).toBeVisible();
  await expect(page.getByText('Ready · review required')).toBeVisible();
  await expect(page.getByText('Setup required')).toBeVisible();
  await expect(page.getByText('Enable real Chrome.')).toBeVisible();
});

test('database outage does not falsely report configured credentials as missing', async ({ page }) => {
  await install(page, {
    status: 'unavailable',
    database: 'unavailable',
    latencyMs: 2200,
    checkedAt: new Date().toISOString(),
    tables: null,
    configuration: { aiProvider: 'anthropic', aiConfigured: true, realChrome: false, delayPredict: false, basicAuth: true },
    error: 'The Neon database project has exceeded its compute-time quota.',
    action: 'Restore or upgrade the Neon project, then run the readiness check again.',
    features: readiness.features,
  } as typeof readiness & { tables: null; error: string; action: string });

  await page.getByRole('button', { name: 'Open feature readiness' }).click();
  await expect(page.getByText('The Neon database project has exceeded its compute-time quota.')).toBeVisible();
  await expect(page.getByText('Database tables could not be checked. This does not mean they were deleted.')).toBeVisible();
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
  await expect(page.getByText('unknown', { exact: true })).toHaveCount(0);
});

test('readiness dialog closes with Escape and restores focus', async ({ page }) => {
  await install(page);
  const button = page.getByRole('button', { name: 'Open feature readiness' });
  await button.focus();
  await button.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#system-check-dialog')).toHaveCount(0);
  await expect(button).toBeFocused();
});
