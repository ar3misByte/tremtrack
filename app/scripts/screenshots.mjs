// Captures key screens at phone and desktop width into docs/screenshots/.
// Usage: start the app (npm run dev, or npm run preview), then: node scripts/screenshots.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = new URL('../../docs/screenshots/', import.meta.url);
mkdirSync(fileURLToPath(out), { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

async function session(name, viewport, scale) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(base + '/#/live');
  await page.waitForTimeout(800);
  const shot = async (file, full = false) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150); return page.screenshot({ path: fileURLToPath(new URL(`${name}-${file}.png`, out)), fullPage: full }); };
  await shot('01-not-connected');
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.waitForTimeout(300);
  await shot('02-connect-sheet');
  await page.getByRole('button', { name: /Demo mode/ }).click();
  await page.getByRole('button', { name: 'Manual' }).click();
  await page.waitForTimeout(2500);
  await shot('03-live-steady');
  await shot('03b-live-steady-full', true);
  await page.getByRole('button', { name: 'Turn tremor' }).click();
  await page.waitForTimeout(2600);
  await shot('04-live-tremor');
  await page.getByRole('button', { name: /2D/ }).click();
  await page.waitForTimeout(800);
  await shot('05-live-2d-tremor');
  await page.getByRole('button', { name: /3D/ }).click();
  await page.goto(base + '/#/trends');
  await page.waitForTimeout(500);
  await shot('06-trends-after-demo');
  await page.goto(base + '/#/settings');
  await page.getByRole('button', { name: 'Load 4 weeks of sample history' }).click();
  await page.waitForTimeout(800);
  await page.goto(base + '/#/trends');
  await page.waitForTimeout(1200);
  await shot('07-trends');
  await shot('07b-trends-full', true);
  await page.locator('.chart-wrap').hover({ position: { x: 200, y: 90 } });
  await page.waitForTimeout(200);
  await page.locator('.chart-wrap').screenshot({ path: fileURLToPath(new URL(`${name}-08-chart-tooltip.png`, out)) });
  await page.locator('.ep-row').first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}-09-episode-sheet.png`, out)) });
  await page.keyboard.press('Escape');
  await page.goto(base + '/#/settings');
  await page.waitForTimeout(500);
  await shot('10-settings', true);
  await page.goto(base + '/#/live');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}-11-live-today.png`, out)) });
  // horizontal overflow check
  for (const r of ['live', 'trends', 'settings', 'about']) {
    await page.goto(base + '/#/' + r);
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) errors.push(`${name}: horizontal overflow ${over}px on #/${r}`);
  }
  await ctx.close();
}

await session('phone', { width: 390, height: 844 }, 2);
await session('desktop', { width: 1440, height: 900 }, 1);
await browser.close();
console.log(errors.length ? 'PROBLEMS:\n' + errors.join('\n') : 'no page errors, no horizontal overflow');
