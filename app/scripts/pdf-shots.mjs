// Renders a PDF's pages to PNG with pdf.js in Chromium (via the dev server), for checking the report.
// Usage: node scripts/pdf-shots.mjs <file.pdf> [outPrefix] [baseUrl]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, prefix = 'report', base = 'http://localhost:5173'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
await page.goto(base + '/scripts/pdf-preview.html');
await page.waitForFunction(() => window.ready === true);
const n = await page.evaluate((b64) => window.renderPdf(b64), readFileSync(file).toString('base64'));
for (let i = 1; i <= n; i++) await page.locator('#p' + i).screenshot({ path: new URL(`../../tools/hostsim/out/${prefix}-p${i}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1').replace(/%20/g, ' ') });
console.log(`${n} pages rendered`);
await browser.close();
