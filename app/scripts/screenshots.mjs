// Captures key screens at phone and desktop width into docs/screenshots/, and fails on page errors
// or horizontal overflow. Start the app first (npm run dev), then: node scripts/screenshots.mjs [baseUrl]
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
  const file = (f) => fileURLToPath(new URL(`${name}-${f}.png`, out));
  const shot = async (f, full = false) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(150); await page.screenshot({ path: file(f), fullPage: full }); };
  const shotAt = async (f, selector) => { await page.locator(selector).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(200); await page.screenshot({ path: file(f) }); };

  await page.goto(base + '/#/live');
  await page.waitForTimeout(800);
  await shot('01-not-connected');
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.waitForTimeout(300);
  await shot('02-connect-sheet');
  await page.getByRole('button', { name: /Demo mode/ }).click();
  await page.getByRole('button', { name: 'Manual' }).click();
  await page.waitForTimeout(2500);
  await shot('03-live-steady');
  await page.getByRole('button', { name: 'Turn', exact: true }).click();
  await page.waitForTimeout(2600);
  await shot('04-live-tremor');
  await page.getByRole('button', { name: 'Nod', exact: true }).click();
  await page.waitForTimeout(2500);
  await shot('04b-live-combined');
  await shotAt('04c-live-combined-axes', '[aria-label="Shaking by axis"]');
  await page.getByRole('button', { name: /2D/ }).click();
  await page.waitForTimeout(800);
  await shot('05-live-2d-tremor');
  await page.getByRole('button', { name: /3D/ }).click();
  // posture: stop the tremor, hold still, calibrate, then lean forward
  await page.getByRole('button', { name: 'Turn', exact: true }).click();
  await page.getByRole('button', { name: 'Nod', exact: true }).click();
  await page.getByRole('button', { name: 'Hold still' }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /Calibrate neutral position/ }).click();
  await page.waitForTimeout(3800);
  await page.getByRole('button', { name: 'Head forward' }).click();
  await page.waitForTimeout(3000);
  await shotAt('05b-live-posture', '[aria-label="Posture and stillness"]');
  await page.getByRole('button', { name: 'Head forward' }).click();
  // fall
  await page.getByRole('button', { name: 'Simulate a fall' }).click();
  await page.getByRole('alertdialog').waitFor({ timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: file('05c-fall-alert') });
  await page.getByRole('button', { name: "I'm OK" }).click();
  await page.getByRole('button', { name: 'Get up' }).click();
  // trends with sample history
  await page.goto(base + '/#/settings');
  await page.getByRole('button', { name: 'Load 4 weeks of sample history' }).click();
  await page.waitForTimeout(800);
  await shot('10-settings', true);
  await page.goto(base + '/#/trends');
  await page.waitForTimeout(1500);
  await shot('07-trends');
  await shot('07b-trends-full', true);
  await shotAt('08-trends-resting', '[aria-label="Resting heart rate and SpO2"]');
  await shotAt('08b-trends-falls', '[aria-label="Impact events"]');
  const combined = page.locator('.ep-row', { hasText: 'Nod + Turn' }).first();
  if (await combined.count()) { await combined.click(); await page.waitForTimeout(300); await page.screenshot({ path: file('09-episode-sheet-combined') }); await page.keyboard.press('Escape'); }
  await page.goto(base + '/#/log');
  await page.waitForTimeout(1200);
  await shot('11-log');
  await shot('11b-log-full', true);
  await page.goto(base + '/#/insights');
  await page.waitForTimeout(2000);
  await shot('12-insights');
  await shot('12b-insights-full', true);
  await shotAt('12c-insights-tags', '[aria-label="Tags and tremor"]');
  await page.goto(base + '/#/report');
  await page.waitForTimeout(1500);
  await shot('13-report', true);
  for (const r of ['live', 'trends', 'log', 'insights', 'report', 'settings', 'about']) {
    await page.goto(base + '/#/' + r);
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) errors.push(`${name}: horizontal overflow ${over}px on #/${r}`);
  }
  await ctx.close();
}

await session('phone', { width: 390, height: 844 }, 2);
await session('desktop', { width: 1440, height: 900 }, 1);
await browser.close();
console.log(errors.length ? 'PROBLEMS:\n' + errors.join('\n') : 'no page errors, no horizontal overflow');
if (errors.length) process.exit(1);
