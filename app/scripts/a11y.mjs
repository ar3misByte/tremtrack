// Automated accessibility audit (axe-core) of every screen at phone width, normal and large text, plus the
// connect sheet, the Cloud screens and the Headset card. Fails on any violation of WCAG 2.1 A/AA rules axe can check.
// Needs the app running (npm run dev). Usage: node scripts/a11y.mjs [baseUrl]
// Axe cannot judge everything (reading order, meaning of labels, motion): see docs/ACCESSIBILITY.md for the manual checks.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let bad = 0;
const audit = async (page, name) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const v = r.violations;
  console.log(`${v.length ? '✗' : '✓'} ${name}${v.length ? '' : ` (${r.passes.length} rules passed)`}`);
  for (const x of v) { bad++; console.log(`   [${x.impact}] ${x.id}: ${x.help}\n     ${x.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n')[1]).join('\n     ')}`); }
};

for (const text of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(base + '/#/live');
  await page.evaluate((large) => { const k = 'htm.settings.v1'; const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{},"version":0}'); s.state.largeText = large; s.state.viewMode = '2d'; localStorage.setItem(k, JSON.stringify(s)); }, text);
  await page.reload();
  const tag = text ? ' (large text)' : '';
  // live with data: demo mode shows the tremor state and vitals
  await page.getByRole('button', { name: /Change connection/ }).click();
  await audit(page, 'Connect sheet' + tag);
  await page.getByRole('button', { name: /Demo mode/ }).click();
  await page.getByRole('button', { name: 'Manual' }).click().catch(() => {});
  await page.waitForTimeout(1500);
  await audit(page, 'Live (demo)' + tag);
  for (const r of ['trends', 'log', 'insights', 'report', 'settings', 'about', 'cloud']) {
    await page.goto(`${base}/#/${r}`);
    await page.waitForTimeout(700);
    await audit(page, `${r}${tag}`);
  }
  await ctx.close();
}
await browser.close();
console.log(bad ? `\n${bad} violation(s)` : '\nNo violations axe can detect.');
process.exit(bad ? 1 : 0);
