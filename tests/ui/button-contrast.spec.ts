import { test, expect } from 'playwright/test';
import { resolve } from 'node:path';

const cssFile = resolve(process.cwd(), 'src/server/public/usability-shell.css');

function rgb(value: string): [number, number, number] {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Unsupported color: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
  const values = [r, g, b].map((n) => {
    const v = n / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('dark navigation buttons retain readable text on hover', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body style="background:#0f172a"><header><nav class="simple-nav"><button id="shipments">Shipments</button><div class="simple-more-wrap"><button id="more">More</button></div></nav></header></body></html>`);
  await page.addStyleTag({ path: cssFile });
  await page.locator('#shipments').hover();
  const colors = await page.locator('#shipments').evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.color, background: style.backgroundColor };
  });
  expect(contrast(rgb(colors.color), rgb(colors.background))).toBeGreaterThanOrEqual(4.5);
});

test('dialog close and choice controls retain readable hover states', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body><section class="simple-dialog"><button class="simple-dialog-close">×</button><button class="simple-choice"><strong>Ocean quote</strong><span>Carrier sheets and ocean rates</span></button></section></body></html>`);
  await page.addStyleTag({ path: cssFile });
  for (const selector of ['.simple-dialog-close', '.simple-choice']) {
    const target = page.locator(selector);
    await target.hover();
    const colors = await target.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor };
    });
    expect(contrast(rgb(colors.color), rgb(colors.background))).toBeGreaterThanOrEqual(4.5);
  }
});
