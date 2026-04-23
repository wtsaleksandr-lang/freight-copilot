import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Default state (fresh with new features)
  await page.screenshot({ path: './samples/dashboard-01-fresh.png', fullPage: true });

  // Agent tab
  await page.getByRole('button', { name: 'Agent' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: './samples/dashboard-agent.png', fullPage: true });

  // Back to new quote for more coverage
  await page.getByRole('button', { name: 'New quote' }).click();
  await page.waitForTimeout(300);

  // Fill intake with a sample request
  await page.getByPlaceholder(/Paste text here/).fill(
    'Hi Alex, please quote ocean freight Shanghai to Rotterdam, 40HC container, electronics, about 15 tons. Ready to ship next week. Thanks!'
  );
  await page.screenshot({ path: './samples/dashboard-02-pasted.png', fullPage: true });

  // Click Extract and wait for form fill
  await page.getByRole('button', { name: /^Extract$/ }).click();
  await page.waitForFunction(
    () => /extracted/i.test(document.getElementById('intake-status')?.textContent || ''),
    { timeout: 20000 }
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: './samples/dashboard-03-extracted.png', fullPage: true });

  await browser.close();
  console.log('3 screenshots saved to ./samples/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
