// Portrait and landscape tablet captures of the main screens (checks the layout between phone and desktop widths).
// Needs the app running (npm run dev). Usage: node scripts/tablet-shots.mjs [baseUrl] [width] [height]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const base = process.argv[2] ?? 'http://localhost:5173';
const w = Number(process.argv[3] ?? 800), h = Number(process.argv[4] ?? 1280);
const out = (n) => fileURLToPath(new URL(`../../docs/screenshots/tablet-${w}x${h}-${n}.png`, import.meta.url));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto(base + '/#/live');
await page.getByRole('button', { name: /Change connection/ }).click();
await page.getByRole('button', { name: /Demo mode/ }).click();
await page.getByRole('button', { name: 'Manual' }).click();
await page.getByRole('button', { name: 'Turn', exact: true }).click();
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: out('live') });
for (const r of ['trends', 'settings', 'cloud']) { await page.goto(`${base}/#/${r}`); await page.waitForTimeout(800); await page.screenshot({ path: out(r) }); }
const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('horizontal overflow:', o);
await browser.close();
