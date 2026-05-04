// Generate PWA PNG icons (192px + 512px) from the SVG source.
// Playwright's headless browser renders the SVG and screenshots it —
// no native image deps, no extra packages.
//
// Run with:  node scripts/generate-icons.mjs

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'src', 'server', 'public');

const sources = [
  { svg: 'icon-512.svg', out: 'icon-512.png', size: 512 },
  { svg: 'icon-512.svg', out: 'icon-192.png', size: 192 },
];

const browser = await chromium.launch();
try {
  for (const { svg, out, size } of sources) {
    const svgText = await readFile(resolve(publicDir, svg), 'utf8');
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>
         html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
         svg{display:block;width:${size}px;height:${size}px}
       </style></head><body>${svgText}</body></html>`
    );
    const png = await page.screenshot({
      omitBackground: false,
      type: 'png',
      clip: { x: 0, y: 0, width: size, height: size },
    });
    await writeFile(resolve(publicDir, out), png);
    console.log(`[icons] wrote ${out} (${png.length} bytes)`);
    await page.close();
  }
} finally {
  await browser.close();
}
