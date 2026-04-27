import { type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Save a forensics bundle when a carrier adapter throws: full-page
 * screenshot + page HTML + final URL. Lets us diagnose selector breakage
 * without another guess-and-restart cycle.
 *
 * Best-effort: never throws. Returns the absolute paths so the calling
 * code can mention them in its re-thrown error message.
 */
export interface FailureArtifacts {
  screenshotPath: string;
  htmlPath: string;
  finalUrl: string;
}

export async function captureFailure(
  page: Page,
  carrierCode: string,
  context: string
): Promise<FailureArtifacts | null> {
  try {
    const dir = resolve(`./samples/${carrierCode.toLowerCase()}`);
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeContext = context.replace(/[^a-z0-9]+/gi, '-').slice(0, 30);
    const screenshotPath = resolve(dir, `failure-${safeContext}-${ts}.png`);
    const htmlPath = resolve(dir, `failure-${safeContext}-${ts}.html`);
    const finalUrl = page.url();
    await page
      .screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 })
      .catch(() => undefined);
    const html = await page.content().catch(() => '');
    if (html) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(htmlPath, html).catch(() => undefined);
    }
    console.error(
      `[${carrierCode}] failure forensics:\n  url:        ${finalUrl}\n  screenshot: ${screenshotPath}\n  html:       ${htmlPath}`
    );
    return { screenshotPath, htmlPath, finalUrl };
  } catch {
    return null;
  }
}
