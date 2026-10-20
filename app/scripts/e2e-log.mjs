// End-to-end, Log + reminders + Insights: add a medication due now -> reminder banner -> "Taken" ->
// shown as taken; log a tag; load sample history -> Insights shows comparisons with counts and intervals.
// Needs the app running (npm run dev). Usage: node scripts/e2e-log.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = async (m) => { console.error('FAIL: ' + m); await browser.close(); process.exit(1); };
const pad = (n) => String(n).padStart(2, '0');
try {
  await page.goto(base + '/#/log');
  await page.waitForLoadState('networkidle');
  // a medication scheduled for the current minute
  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  await page.getByRole('button', { name: 'Add medication' }).click();
  await page.getByLabel('Name').fill('Test medication');
  await page.getByLabel('Dose (as written on your prescription)').fill('1 tablet');
  await page.getByLabel('Time 1').fill(hhmm);
  await page.getByRole('button', { name: 'Save' }).click();
  const banner = page.locator('.reminder');
  await banner.waitFor({ timeout: 40000 });
  console.log('reminder banner: ' + (await banner.textContent()).replace(/\s+/g, ' ').trim());
  await banner.getByRole('button', { name: 'Taken' }).click();
  await page.locator('.dose-row', { hasText: 'Test medication' }).getByText('Taken', { exact: true }).waitFor({ timeout: 5000 });
  await banner.waitFor({ state: 'detached', timeout: 3000 }).catch(() => fail('banner still shown after Taken'));
  console.log('dose shown as taken; banner gone');

  await page.getByRole('button', { name: 'Coffee' }).click();
  await page.getByText(/Coffee logged at/).waitFor({ timeout: 5000 });
  await page.locator('[aria-label="Recent entries"]').getByText('Coffee').waitFor({ timeout: 5000 });
  console.log('coffee tag logged and listed');

  await page.goto(base + '/#/settings');
  await page.getByRole('button', { name: 'Load 4 weeks of sample history' }).click();
  await page.waitForTimeout(1500);
  await page.goto(base + '/#/insights');
  await page.locator('.hint').first().waitFor({ timeout: 15000 });
  const hint = await page.locator('.hint-text').first().textContent();
  console.log('first pattern hint: ' + hint);
  const tagResults = await page.locator('[aria-label="Tags and tremor"] .result-list li').allTextContents();
  console.log('tag results:\n  ' + tagResults.map((t) => t.replace(/\s+/g, ' ').slice(0, 170)).join('\n  '));
  if (!tagResults.some((t) => /interval/.test(t))) await fail('no comparison with an interval');
  const med = await page.locator('[aria-label="Medication and tremor"] .result-list li').allTextContents();
  console.log('medication results:\n  ' + med.map((t) => t.replace(/\s+/g, ' ').slice(0, 170)).join('\n  '));
  const all = (await page.locator('main').textContent()) ?? '';
  if (/essential tremor|parkinson|dystoni|diagnos(is|ed) with/i.test(all)) await fail('disease name or diagnosis wording on Insights');
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) { await fail(String(e)); }
await browser.close();
