// End-to-end, fall flow: demo fall -> fall detector -> countdown alert -> "I'm OK" -> event saved -> Trends.
// Then a second fall left to time out with a short countdown -> "No response" result screen.
// Needs the app running (npm run dev). Usage: node scripts/e2e-fall.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = async (m) => { console.error('FAIL: ' + m); await browser.close(); process.exit(1); };
try {
  await page.goto(base + '/#/live');
  await page.waitForLoadState('networkidle');
  // short countdown for the timeout case
  await page.evaluate(() => { const k = 'htm.settings.v1'; const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{},"version":0}'); s.state.overrides = { fall: { cancelCountdownS: 10 } }; s.state.fallDetection = true; localStorage.setItem(k, JSON.stringify(s)); });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.getByRole('button', { name: /Demo mode/ }).click();
  await page.getByRole('button', { name: 'Manual' }).click();
  await page.waitForTimeout(2000);

  await page.getByRole('button', { name: 'Simulate a fall' }).click();
  const t0 = Date.now();
  await page.getByRole('alertdialog', { name: 'Possible fall detected' }).waitFor({ timeout: 8000 });
  console.log(`alert after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const focused = await page.evaluate(() => document.activeElement?.textContent);
  if (focused !== "I'm OK") await fail(`"I'm OK" should have focus, got ${focused}`);
  await page.getByRole('button', { name: "I'm OK" }).click();
  await page.getByRole('button', { name: 'Get up' }).click();
  await page.waitForTimeout(17000);      // past the 15 s cooldown, which starts when the first fall is confirmed (about 2.5 s after the impact)

  // second fall: let the (shortened, 10 s) countdown run out
  await page.getByRole('button', { name: 'Simulate a fall' }).click();
  await page.getByRole('alertdialog', { name: 'Possible fall detected' }).waitFor({ timeout: 8000 });
  await page.getByRole('alertdialog', { name: 'No response' }).waitFor({ timeout: 15000 });
  console.log('countdown ran out -> "No response" screen shown');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Get up' }).click();

  await page.goto(base + '/#/trends');
  const ev = page.locator('[aria-label="Impact events"] .sess-row');
  await ev.first().waitFor({ timeout: 8000 });
  const texts = await ev.allTextContents();
  console.log('events: ' + texts.map((t) => t.replace(/\s+/g, ' ')).join(' | '));
  if (!texts.some((t) => t.includes("Said I'm OK"))) await fail('cancelled fall not in Trends');
  if (!texts.some((t) => t.includes('No response'))) await fail('timed-out fall not in Trends');
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) { await fail(String(e)); }
await browser.close();
