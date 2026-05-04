// End-to-end audit of the Freight Copilot dashboard.
// Walks every tab, exercises every recent feature, captures console
// errors / network failures / page errors. Writes a JSON + markdown
// report to scripts/audit-output/.
//
// Run with:  node scripts/e2e-audit.mjs
// Requires:  the dev server up at http://localhost:3000 (or set BASE_URL).

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'audit-output');
await mkdir(outDir, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Pull basic-auth creds from .env if present.
let creds = null;
try {
  const envText = readFileSync(resolve(here, '..', '.env'), 'utf8');
  const u = /^BASIC_AUTH_USER=(.+)$/m.exec(envText)?.[1]?.trim();
  const p = /^BASIC_AUTH_PASS=(.+)$/m.exec(envText)?.[1]?.trim();
  if (u && p) creds = { username: u, password: p };
} catch {
  /* no .env; assume no auth */
}

const findings = [];
function note(severity, area, message, detail = null) {
  findings.push({ severity, area, message, detail });
  console.log(`  [${severity.toUpperCase()}] ${area}: ${message}${detail ? '\n    ' + detail : ''}`);
}

const consoleErrors = [];
const networkErrors = [];
const pageErrors = [];

console.log(`[audit] launching browser, BASE_URL=${BASE_URL}`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  httpCredentials: creds || undefined,
  viewport: { width: 1600, height: 1000 },
  bypassCSP: true,
});
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleErrors.push({ type: msg.type(), text: msg.text(), url: page.url() });
  }
});
page.on('pageerror', (err) => {
  pageErrors.push({ message: err.message, stack: err.stack, url: page.url() });
});
page.on('response', (resp) => {
  if (resp.status() >= 400 && resp.status() !== 401) {
    networkErrors.push({
      url: resp.url(),
      status: resp.status(),
      statusText: resp.statusText(),
    });
  }
});

async function shoot(name) {
  const file = resolve(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function clickTab(tabKey) {
  const tab = page.locator(`[data-tab="${tabKey}"]`);
  if (await tab.count() === 0) {
    note('bug', `tab:${tabKey}`, 'tab button missing');
    return false;
  }
  await tab.click();
  await page.waitForTimeout(400);
  return true;
}

async function exists(selector) {
  return (await page.locator(selector).count()) > 0;
}

async function testHomeLoad() {
  console.log('\n=== home / page load ===');
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  if (page.url() !== BASE_URL + '/' && !page.url().startsWith(BASE_URL)) {
    note('bug', 'load', `unexpected URL after load: ${page.url()}`);
  }
  const title = await page.title();
  if (!title) note('ux', 'load', 'page has no <title>');
  if (consoleErrors.length > 0) {
    note('bug', 'load', `console errors on initial load: ${consoleErrors.length}`,
      JSON.stringify(consoleErrors.slice(0, 3), null, 2));
  }
  await shoot('01-home');
}

async function testTabsAccessible() {
  console.log('\n=== tab availability ===');
  // Find all tab buttons and click each in turn. Confirm a pane appears.
  const tabs = await page.locator('button.tab[data-tab]').all();
  if (tabs.length === 0) {
    note('bug', 'tabs', 'no tab buttons found');
    return [];
  }
  const tabKeys = [];
  for (const tab of tabs) {
    const key = await tab.getAttribute('data-tab');
    if (key) tabKeys.push(key);
  }
  console.log(`  found ${tabKeys.length} tabs: ${tabKeys.join(', ')}`);
  for (const key of tabKeys) {
    const before = consoleErrors.length;
    const ok = await clickTab(key);
    if (!ok) continue;
    const pane = page.locator(`#tab-${key}.tab-pane.active`);
    if ((await pane.count()) === 0) {
      note('bug', `tab:${key}`, `pane #tab-${key} did not become active`);
    }
    const after = consoleErrors.length;
    if (after > before) {
      note('bug', `tab:${key}`, `${after - before} new console errors when opening tab`,
        JSON.stringify(consoleErrors.slice(before, after).slice(0, 3), null, 2));
    }
    await shoot(`02-tab-${key}`);
  }
  return tabKeys;
}

async function testShipmentsTab() {
  console.log('\n=== shipments tab ===');
  await clickTab('shipments');
  await page.waitForTimeout(800);

  // 1. Table rendered?
  const tableHasRows = await page.locator('#ship-table tbody tr').count();
  console.log(`  shipments rows: ${tableHasRows}`);

  // 2. Header band has both label row + filter row?
  if (!(await exists('#ship-table thead .ship-th-row'))) {
    note('bug', 'shipments:table', 'header label row missing');
  }
  if (!(await exists('#ship-table thead .ship-filter-row'))) {
    note('bug', 'shipments:table', 'filter row missing');
  }
  // 3. Status legend present?
  if (!(await exists('.status-legend'))) {
    note('ux', 'shipments:legend', 'status legend not visible at the bottom of the tab');
  } else {
    const legendItems = await page.locator('.status-legend-item').count();
    if (legendItems < 4) note('bug', 'shipments:legend', `legend has only ${legendItems} items`);
  }
  // 4. Sticky columns: status + ref should have position:sticky.
  await page.waitForSelector('#ship-table thead th', { state: 'attached' });
  const stickyStyle = await page.evaluate(() => {
    const el = document.querySelector('#ship-table thead .ship-th-row th:nth-child(1)');
    if (!el) return 'no-element';
    return window.getComputedStyle(el).position;
  });
  if (stickyStyle !== 'sticky') {
    note('bug', 'shipments:sticky', `status header position is ${stickyStyle}, expected sticky`);
  } else {
    console.log('  sticky-left position confirmed on status column ✓');
  }
  // 5. Column resize handles present on each th.
  const resizeHandles = await page.locator('#ship-table thead .col-resize-handle').count();
  if (resizeHandles === 0) {
    note('bug', 'shipments:resize', 'no column resize handles found');
  }
  // 6. PWA manifest linked.
  const manifest = await page.locator('link[rel="manifest"]').count();
  if (manifest === 0) note('bug', 'pwa', '<link rel="manifest"> missing');
  // 7. Service worker registered?
  const swReg = await page.evaluate(async () => {
    if (!navigator.serviceWorker) return 'no SW api';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'not registered';
  });
  if (swReg !== 'registered') note('ux', 'pwa', `service worker: ${swReg}`);

  if (tableHasRows > 0) {
    await testShipmentRowFeatures();
  } else {
    note('info', 'shipments:data', 'table is empty — skipping per-row feature tests');
  }
}

async function testShipmentRowFeatures() {
  console.log('  -- per-row features (status, copy, breakdown, drop) --');

  // Status icon: click first row's status cell, picker appears?
  const firstStatus = page.locator('#ship-table tbody tr:first-child td[data-kind="status"]');
  if ((await firstStatus.count()) > 0) {
    await firstStatus.click();
    await page.waitForTimeout(150);
    const picker = await page.locator('#ship-table tbody tr:first-child td[data-kind="status"] select').count();
    if (picker === 0) {
      note('bug', 'shipments:status-picker', 'single-click on status cell did not open the picker');
    } else {
      console.log('  status picker opens on single click ✓');
    }
    // Close picker by clicking elsewhere
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  } else {
    note('info', 'shipments:status', 'no status cell to test');
  }

  // Ref-cell click-to-copy: does clicking ref show a flash class?
  const firstRef = page.locator('#ship-table tbody tr:first-child td.ref-cell');
  if ((await firstRef.count()) > 0) {
    const refText = (await firstRef.textContent()).trim();
    await firstRef.click();
    await page.waitForTimeout(200);
    const flashed = await firstRef.evaluate((el) => el.classList.contains('is-copied'));
    if (!flashed) {
      note('ux', 'shipments:copy-ref', 'clicking ref cell did not produce green flash');
    } else {
      console.log(`  ref click-to-copy fires flash ✓ (${refText})`);
    }
  }

  // Breakdown panels: click cost-modal cell.
  const firstCost = page.locator('#ship-table tbody tr:first-child td[data-kind="cost-modal"]');
  if ((await firstCost.count()) > 0) {
    await firstCost.click();
    await page.waitForTimeout(350);
    const panel = await page.locator('.compact-panel .cost-breakdown').count();
    if (panel === 0) {
      note('bug', 'shipments:cost-panel', 'click on cost cell did not open breakdown panel');
    } else {
      // Check panel has add-form
      const addForm = await page.locator('.compact-panel .bd-add-form').count();
      if (addForm === 0) note('bug', 'shipments:cost-panel', 'add-form missing in cost panel');
      // Drag handle present?
      const dragHandle = await page.locator('.compact-panel .compact-panel-head.is-draggable').count();
      if (dragHandle === 0) note('ux', 'shipments:cost-panel', 'cost panel header not marked draggable');
      // Currency selector present?
      const currencySel = await page.locator('.compact-panel .bd-add-currency').count();
      if (currencySel === 0) note('bug', 'shipments:cost-panel', 'currency selector missing in add-form');
      console.log('  cost breakdown panel opens with add-form ✓');
      await shoot('03-cost-panel');
    }
    // Close panel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // Sell breakdown
  const firstSell = page.locator('#ship-table tbody tr:first-child td[data-kind="sell-modal"]');
  if ((await firstSell.count()) > 0) {
    await firstSell.click();
    await page.waitForTimeout(350);
    const panel = await page.locator('.compact-panel .cost-breakdown').count();
    if (panel === 0) {
      note('bug', 'shipments:sell-panel', 'click on sell cell did not open breakdown panel');
    } else {
      console.log('  sell breakdown panel opens ✓');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // Attachments badge — if any row has artifacts.
  const attachBtn = page.locator('button.ship-attach-badge').first();
  if ((await attachBtn.count()) > 0) {
    await attachBtn.click();
    await page.waitForTimeout(300);
    const panel = await page.locator('.compact-panel .attachments-list').count();
    if (panel === 0) {
      note('bug', 'shipments:attachments', 'attachments panel did not open');
    } else {
      const pasteZone = await page.locator('.compact-panel .attachments-paste-zone').count();
      if (pasteZone === 0) {
        note('bug', 'shipments:attachments', 'paste zone missing in attachments panel');
      }
      const dropZone = await page.locator('.compact-panel .attachments-dropzone').count();
      if (dropZone === 0) {
        note('bug', 'shipments:attachments', 'drop zone missing in attachments panel');
      }
      console.log('  attachments panel opens with drop + paste zones ✓');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  } else {
    note('info', 'shipments:attachments', 'no attachments badge found — skipping panel test');
  }

  // Filter inputs in header
  const refFilter = page.locator('#ship-table thead .ship-filter-row input[data-filter-key="refId"]').first();
  if ((await refFilter.count()) > 0) {
    const startCount = await page.locator('#ship-table tbody tr[data-ref]').count();
    await refFilter.fill('XYZ_NO_MATCH_TEST_STR');
    await page.waitForTimeout(200);
    const filteredCount = await page.locator('#ship-table tbody tr[data-ref]').count();
    if (filteredCount >= startCount && startCount > 0) {
      note('bug', 'shipments:filter', 'filter input did not narrow rows');
    } else {
      console.log(`  filter narrows ${startCount} → ${filteredCount} ✓`);
    }
    await refFilter.fill('');
    await page.waitForTimeout(200);
  }
}

async function testDrayageTab() {
  console.log('\n=== drayage tab ===');
  await clickTab('drayage');
  await page.waitForTimeout(800);

  // Rate library card present at top?
  if (!(await exists('#dr-lib-dropzone'))) {
    note('bug', 'drayage:lib', 'rate library dropzone missing');
  }
  if (!(await exists('#dr-lib-paste-zone'))) {
    note('bug', 'drayage:lib', 'paste zone missing');
  }
  // Calculator
  if (!(await exists('#dr-clear-btn'))) note('bug', 'drayage:calc', 'Clear button missing');
  if (!(await exists('#dr-run-btn'))) note('bug', 'drayage:calc', 'Run button missing');
  // Removed fields should NOT exist
  for (const id of ['dr-pickup-date', 'dr-delivery-date', 'dr-client', 'dr-notes', 'dr-special-dd', 'dr-accessorials-dd']) {
    if (await exists(`#${id}`)) {
      note('bug', `drayage:calc`, `removed field still in DOM: #${id}`);
    }
  }
  // Matches panel
  if (!(await exists('#dr-matches-table'))) note('bug', 'drayage:matches', 'matches table missing');
  // Saved rates DB at bottom
  if (!(await exists('#dr-lib-table'))) note('bug', 'drayage:lib-list', 'saved-rates table missing');
  const filterInputs = await page.locator('#dr-lib-table .filter-input.lib-filter').count();
  if (filterInputs === 0) {
    note('ux', 'drayage:lib-filters', 'no per-column filter inputs in saved-rates table (would render only after rows exist)');
  }

  // Click Run with empty form: should query with no filters and show all matches.
  const runBtn = page.locator('#dr-run-btn');
  await runBtn.click();
  await page.waitForTimeout(800);
  await shoot('04-drayage-after-run');

  // Click Clear
  await page.locator('#dr-clear-btn').click();
  await page.waitForTimeout(200);
  const intakeText = await page.locator('#dr-intake-text').inputValue();
  if (intakeText !== '') {
    note('bug', 'drayage:clear', 'Clear button did not blank intake textarea');
  }
}

async function testCrossTabConsole() {
  console.log('\n=== cross-tab smoke (open each tab once more, watch console) ===');
  // Real tabs in this app: new (Ocean), shipments, drayage, trucking, history
  const tabs = ['new', 'shipments', 'drayage', 'trucking', 'history'];
  for (const t of tabs) {
    const before = consoleErrors.length + pageErrors.length;
    const ok = await clickTab(t);
    if (!ok) continue;
    await page.waitForTimeout(400);
    const after = consoleErrors.length + pageErrors.length;
    if (after > before) {
      note('bug', `tab:${t}`, `${after - before} new console/page errors`);
    }
  }
}

async function testApiHealth() {
  console.log('\n=== api smoke ===');
  const tests = [
    { method: 'GET', url: '/api/shipments' },
    { method: 'GET', url: '/api/drayage-rate-library' },
    { method: 'GET', url: '/api/carriers' },
    { method: 'GET', url: '/api/sessions' },
    { method: 'GET', url: '/api/credentials' },
    { method: 'GET', url: '/manifest.json' },
    { method: 'GET', url: '/sw.js' },
  ];
  for (const t of tests) {
    const r = await page.request.fetch(BASE_URL + t.url, { method: t.method });
    if (!r.ok()) {
      note('bug', 'api', `${t.method} ${t.url} → ${r.status()}`);
    }
  }
}

async function testStatusPickerLatency() {
  console.log('\n=== status picker latency ===');
  await clickTab('shipments');
  await page.waitForTimeout(500);
  const cell = page.locator('#ship-table tbody tr:first-child td[data-kind="status"]');
  if ((await cell.count()) === 0) return;
  await cell.click();
  await page.waitForTimeout(150);
  const sel = page.locator('#ship-table tbody tr:first-child td[data-kind="status"] select');
  if ((await sel.count()) === 0) {
    note('bug', 'shipments:picker', 'select did not appear');
    return;
  }
  // Pick an option, measure how long until icon paints.
  const t0 = Date.now();
  await sel.selectOption('loaded');
  // Optimistic: icon should swap immediately (within 50ms).
  let painted = -1;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(20);
    const iconText = await page
      .locator('#ship-table tbody tr:first-child td[data-kind="status"] .status-icon')
      .textContent()
      .catch(() => null);
    if (iconText && iconText.trim() !== '') {
      painted = Date.now() - t0;
      break;
    }
  }
  if (painted === -1) {
    note('bug', 'shipments:picker-latency', 'icon never painted after status pick');
  } else if (painted > 200) {
    note('ux', 'shipments:picker-latency', `icon paint took ${painted}ms (expected <100ms with optimistic update)`);
  } else {
    console.log(`  status icon paints in ${painted}ms ✓`);
  }
  await page.waitForTimeout(800);
}

async function testColumnResizePersistence() {
  console.log('\n=== column resize persistence ===');
  await clickTab('shipments');
  await page.waitForTimeout(500);
  // Wipe any existing widths.
  await page.evaluate(() => localStorage.removeItem('freight.shipments.colWidths'));
  // Drag the resize handle on the Ref column to widen it by 60px.
  const handle = page.locator('#ship-table thead .ship-th-row th:nth-child(2) .col-resize-handle');
  if ((await handle.count()) === 0) {
    note('bug', 'shipments:resize', 'ref column resize handle missing');
    return;
  }
  const box = await handle.boundingBox();
  if (!box) { note('bug', 'shipments:resize', 'cannot find resize handle bbox'); return; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const stored = await page.evaluate(() =>
    localStorage.getItem('freight.shipments.colWidths')
  );
  if (!stored || !stored.includes('"refId"')) {
    note('bug', 'shipments:resize-persist', 'column width was not saved to localStorage');
  } else {
    console.log(`  width saved ✓ (${stored.length} bytes in localStorage)`);
  }
  // Reload, make sure width is restored from storage.
  await page.reload({ waitUntil: 'networkidle' });
  await clickTab('shipments');
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => {
    const col = document.querySelector('#ship-table colgroup col[data-col-key="refId"]');
    return col ? col.style.width : null;
  });
  if (!restored) {
    note('bug', 'shipments:resize-persist', 'width not restored on reload');
  } else {
    console.log(`  width restored on reload: ${restored} ✓`);
  }
}

async function testBreakdownEndpoint() {
  console.log('\n=== breakdown endpoint round-trip ===');
  // Create a blank shipment, add a cost line, update it, delete it.
  const baseUrl = BASE_URL;
  const headers = { 'Content-Type': 'application/json' };
  const createR = await page.request.post(baseUrl + '/api/shipments', {
    headers, data: {},
  });
  const created = await createR.json();
  if (!createR.ok()) {
    note('bug', 'breakdown:create-shipment', `failed: ${createR.status()}`); return;
  }
  const refId = created.refId;
  console.log(`  created test shipment ${refId}`);

  // Add a cost item
  const addR = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers,
    data: { side: 'cost', op: 'add', item: { name: 'Audit test item', amount: 100, currency: 'USD' } },
  });
  const added = await addR.json();
  if (!addR.ok()) note('bug', 'breakdown:add', `failed: ${addR.status()}: ${JSON.stringify(added)}`);
  if (added.shipment?.ourCost !== 100) {
    note('bug', 'breakdown:add', `total mismatch after add: expected 100, got ${added.shipment?.ourCost}`);
  } else console.log(`  add: total = $${added.shipment.ourCost} ✓`);

  // Update it
  const updR = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers,
    data: { side: 'cost', op: 'update', index: 0, item: { name: 'Audit test (renamed)', amount: 250, currency: 'USD' } },
  });
  const upd = await updR.json();
  if (!updR.ok()) note('bug', 'breakdown:update', `failed: ${updR.status()}`);
  if (upd.shipment?.ourCost !== 250) {
    note('bug', 'breakdown:update', `total mismatch after update: expected 250, got ${upd.shipment?.ourCost}`);
  } else console.log(`  update: total = $${upd.shipment.ourCost} ✓`);

  // Set-total
  const setR = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers, data: { side: 'cost', op: 'set-total', amount: 500 },
  });
  const setRes = await setR.json();
  if (setRes.shipment?.ourCost !== 500) {
    note('bug', 'breakdown:set-total', `total mismatch after set-total: expected 500, got ${setRes.shipment?.ourCost}`);
  } else console.log(`  set-total: total = $${setRes.shipment.ourCost} ✓`);
  // Items should be 1 (single override item)
  if (setRes.shipment?.costBreakdownJson?.length !== 1) {
    note('bug', 'breakdown:set-total', `expected 1 item after set-total, got ${setRes.shipment?.costBreakdownJson?.length}`);
  }

  // Remove
  const remR = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers, data: { side: 'cost', op: 'remove', index: 0 },
  });
  const rem = await remR.json();
  if (rem.shipment?.ourCost != null) {
    note('bug', 'breakdown:remove', `total should be null after removing only item, got ${rem.shipment?.ourCost}`);
  } else console.log(`  remove: total cleared ✓`);

  // Test FX conversion: add a CAD item, expect USD storage.
  const fxR = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers,
    data: {
      side: 'cost', op: 'add',
      item: { name: 'Drayage', amount: 1000, currency: 'CAD' },
      fxRates: { CAD: 0.73 },
    },
  });
  const fx = await fxR.json();
  if (fx.shipment?.ourCost !== 730) {
    note('bug', 'breakdown:fx', `1000 CAD @ 0.73 should be 730 USD; got ${fx.shipment?.ourCost}`);
  } else console.log(`  fx CAD→USD: 1000 → $${fx.shipment.ourCost} ✓`);

  // Cleanup test shipment
  await page.request.delete(`${baseUrl}/api/shipments/${refId}`);
  console.log(`  cleaned up ${refId}`);
}

async function testDrayageRateLibraryEndpoints() {
  console.log('\n=== drayage rate library endpoints ===');
  const baseUrl = BASE_URL;
  // GET should return an array.
  const r = await page.request.get(baseUrl + '/api/drayage-rate-library');
  const data = await r.json();
  if (!r.ok() || !Array.isArray(data.rates)) {
    note('bug', 'drayage:lib:get', 'list endpoint did not return rates array');
  } else {
    console.log(`  GET /api/drayage-rate-library: ${data.rates.length} rates ✓`);
  }
  // Filter params accepted (no 500)
  const fr = await page.request.get(
    baseUrl + '/api/drayage-rate-library?from=newark&to=chicago&cntr=40HC'
  );
  if (!fr.ok()) note('bug', 'drayage:lib:filter', `filtered list errored ${fr.status()}`);
  // /save with empty rates → 400
  const saveR = await page.request.post(baseUrl + '/api/drayage-rate-library/save', {
    headers: { 'Content-Type': 'application/json' },
    data: { rates: [] },
  });
  if (saveR.status() !== 400) {
    note('bug', 'drayage:lib:save', `empty rates should 400, got ${saveR.status()}`);
  }
}

async function testFxModule() {
  console.log('\n=== fxRates module ===');
  // No direct endpoint, but breakdown round-trip already covers it.
  // Test inverse: providing override should win over defaults.
  const baseUrl = BASE_URL;
  const createR = await page.request.post(baseUrl + '/api/shipments', {
    headers: { 'Content-Type': 'application/json' }, data: {},
  });
  const { refId } = await createR.json();
  const r = await page.request.post(`${baseUrl}/api/shipments/${refId}/breakdown`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      side: 'sold', op: 'add',
      item: { name: 'Test', amount: 100, currency: 'EUR' },
      fxRates: { EUR: 2 }, // Forced 1 EUR = 2 USD
    },
  });
  const out = await r.json();
  if (out.shipment?.soldRate !== 200) {
    note('bug', 'fx:override', `EUR 100 @ override 2 = USD 200 expected, got ${out.shipment?.soldRate}`);
  } else console.log(`  fx override respected ✓`);
  await page.request.delete(`${baseUrl}/api/shipments/${refId}`);
}

async function testStatusPickerOnLegacyValue() {
  console.log('\n=== status picker on legacy value (regression) ===');
  // Manually set a legacy status value via PATCH and verify the picker
  // pre-selects the mapped option. Use one of the existing shipments.
  const baseUrl = BASE_URL;
  const list = await (await page.request.get(baseUrl + '/api/shipments')).json();
  if (!list.shipments?.length) { console.log('  no shipments to test'); return; }
  const refId = list.shipments[0].refId;
  // Set legacy 'pending_invoice'
  await page.request.patch(`${baseUrl}/api/shipments/${refId}`, {
    headers: { 'Content-Type': 'application/json' },
    data: { operationalStatus: 'pending_invoice' },
  });
  await page.reload({ waitUntil: 'networkidle' });
  await clickTab('shipments');
  await page.waitForTimeout(500);
  const cell = page.locator(`#ship-table tbody tr[data-ref="${refId}"] td[data-kind="status"]`);
  if ((await cell.count()) === 0) { note('info', 'legacy', 'test row not visible'); return; }
  // The icon should be the "sailed" mapping for legacy pending_invoice.
  const iconText = (await cell.locator('.status-icon').textContent()).trim();
  if (iconText !== '🚢') {
    note('bug', 'shipments:legacy-mapping',
      `pending_invoice should map to 🚢 (sailed), rendered as "${iconText}"`);
  } else console.log(`  legacy pending_invoice → 🚢 ✓`);
  // Now click to open picker and verify the right option is pre-selected.
  await cell.click();
  await page.waitForTimeout(150);
  const sel = cell.locator('select');
  const value = await sel.inputValue();
  if (value !== 'sailed') {
    note('bug', 'shipments:legacy-mapping',
      `picker pre-selected "${value}" instead of "sailed" for legacy pending_invoice`);
  } else console.log(`  picker pre-selects "sailed" for legacy ✓`);
  await page.keyboard.press('Escape');
}

async function testTabPersistence() {
  console.log('\n=== tab persistence (refresh restores last tab) ===');
  await clickTab('drayage');
  await page.waitForTimeout(150);
  const stored = await page.evaluate(() => localStorage.getItem('freight.lastTab'));
  if (stored !== 'drayage') {
    note('bug', 'tab-persistence', `expected localStorage.freight.lastTab='drayage', got '${stored}'`);
    return;
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const activeTab = await page.evaluate(() => {
    const a = document.querySelector('.tab-pane.active');
    return a ? a.id : null;
  });
  if (activeTab !== 'tab-drayage') {
    note('bug', 'tab-persistence', `after reload expected tab-drayage active, got ${activeTab}`);
  } else {
    console.log('  drayage tab restored on reload ✓');
  }
}

async function testKeyboardShortcuts() {
  console.log('\n=== keyboard shortcuts (Alt+1..5, ?) ===');
  await page.evaluate(() => localStorage.removeItem('freight.lastTab'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  // Focus body so shortcuts aren't blocked by an input.
  await page.locator('body').click();
  await page.keyboard.down('Alt');
  await page.keyboard.press('2');
  await page.keyboard.up('Alt');
  await page.waitForTimeout(200);
  const onShipments = await page.evaluate(() => {
    return document.getElementById('tab-shipments')?.classList.contains('active');
  });
  if (!onShipments) {
    note('bug', 'shortcut:alt-2', 'Alt+2 did not switch to Shipments tab');
  } else console.log('  Alt+2 → Shipments ✓');

  // ? opens help. Try both methods to be browser-portable.
  await page.locator('body').click();
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
  });
  await page.waitForTimeout(200);
  const helpOpen = await page.locator('.shortcuts-help-overlay').count();
  if (helpOpen === 0) {
    note('bug', 'shortcut:?', '? did not open the help overlay');
  } else console.log('  ? → help overlay ✓');
  await page.keyboard.press('Escape');
}

async function testToastSystem() {
  console.log('\n=== toast notifications ===');
  const installed = await page.evaluate(() => typeof window.toast === 'function');
  if (!installed) { note('bug', 'toast', 'window.toast not installed'); return; }
  await page.evaluate(() => window.toast('audit toast test', 'success', 1000));
  await page.waitForTimeout(150);
  const visible = await page.locator('#toast-stack .toast').count();
  if (visible === 0) {
    note('bug', 'toast', 'toast did not render');
  } else console.log('  toast renders ✓');
  // Wait for auto-dismiss
  await page.waitForTimeout(1400);
  const stillVisible = await page.locator('#toast-stack .toast').count();
  if (stillVisible > 0) {
    note('bug', 'toast', 'toast did not auto-dismiss');
  } else console.log('  toast auto-dismisses ✓');
}

async function testCsvExport() {
  console.log('\n=== CSV export button ===');
  await clickTab('shipments');
  await page.waitForTimeout(400);
  const btn = page.locator('#ship-export-csv-btn');
  if ((await btn.count()) === 0) {
    note('bug', 'csv', 'export button missing');
    return;
  }
  // Trigger and verify a download is produced. We rely on the
  // dispatched download event since `a.click()` synthesises one.
  const dlPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await btn.click();
  const dl = await dlPromise;
  if (!dl) {
    note('bug', 'csv', 'no download triggered');
    return;
  }
  const fname = dl.suggestedFilename();
  if (!/^shipments-\d{4}-\d{2}-\d{2}\.csv$/.test(fname)) {
    note('bug', 'csv', `unexpected filename: ${fname}`);
  } else console.log(`  CSV download triggered: ${fname} ✓`);
}

async function run() {
  try {
    await testHomeLoad();
    const tabs = await testTabsAccessible();
    if (tabs.includes('shipments')) {
      await testShipmentsTab();
      await testColumnResizePersistence();
      await testStatusPickerOnLegacyValue();
    }
    if (tabs.includes('drayage')) {
      await testDrayageTab();
      await testDrayageRateLibraryEndpoints();
    }
    await testStatusPickerLatency();
    await testBreakdownEndpoint();
    await testFxModule();
    await testTabPersistence();
    await testKeyboardShortcuts();
    await testToastSystem();
    await testCsvExport();
    await testCrossTabConsole();
    await testApiHealth();
  } catch (err) {
    note('bug', 'audit-script', `audit script crashed: ${err.message}`, err.stack);
  } finally {
    await browser.close();
  }
}

await run();

// Aggregate console / network / page errors into findings.
for (const e of consoleErrors) {
  // De-duplicate by message; ignore noise (favicon, font preload, etc.)
  if (/favicon|font|sourcemap|GenericFont/i.test(e.text)) continue;
  note('bug', 'console', `${e.type}: ${e.text.slice(0, 200)}`, `at ${e.url}`);
}
for (const e of networkErrors) {
  note('bug', 'network', `${e.status} ${e.statusText} on ${e.url}`);
}
for (const e of pageErrors) {
  note('bug', 'page-error', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
}

// Dedup duplicate findings.
const seen = new Set();
const unique = findings.filter((f) => {
  const k = `${f.severity}|${f.area}|${f.message}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const summary = {
  base_url: BASE_URL,
  ran_at: new Date().toISOString(),
  total_findings: unique.length,
  by_severity: unique.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {}),
  findings: unique,
};

await writeFile(
  resolve(outDir, 'report.json'),
  JSON.stringify(summary, null, 2)
);

// Markdown report
const md = [];
md.push(`# Freight Copilot — E2E Audit Report`);
md.push(``);
md.push(`Run: \`${summary.ran_at}\``);
md.push(`Base URL: \`${BASE_URL}\``);
md.push(`Total findings: **${summary.total_findings}**`);
md.push(`By severity: ${JSON.stringify(summary.by_severity)}`);
md.push(``);
for (const sev of ['bug', 'ux', 'info']) {
  const items = unique.filter((f) => f.severity === sev);
  if (items.length === 0) continue;
  md.push(`## ${sev.toUpperCase()} (${items.length})`);
  for (const it of items) {
    md.push(`- **[${it.area}]** ${it.message}`);
    if (it.detail) md.push(`  \`\`\`\n  ${it.detail.slice(0, 500).replace(/\n/g, '\n  ')}\n  \`\`\``);
  }
  md.push(``);
}
await writeFile(resolve(outDir, 'report.md'), md.join('\n'));

console.log(`\n[audit] DONE — ${summary.total_findings} findings`);
console.log(`        report: ${resolve(outDir, 'report.md')}`);
