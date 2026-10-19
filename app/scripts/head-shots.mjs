// Screenshots of the 3D head from the three camera views (for checking the model).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const base = process.argv[2] ?? 'http://localhost:5173';
const out = (n) => fileURLToPath(new URL(`../../docs/screenshots/head-${n}.png`, import.meta.url));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
for (const v of ['three-quarter', 'front', 'side']) {
  await page.goto(base + '/#/live');
  await page.evaluate((view) => { const k = 'htm.settings.v1'; const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{},"version":0}'); s.state.cameraView = view; s.state.viewMode = '3d'; localStorage.setItem(k, JSON.stringify(s)); }, v);
  await page.reload();
  await page.waitForTimeout(2500);
  await page.locator('.stage').screenshot({ path: out(v) });
}
await browser.close();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'ok');
