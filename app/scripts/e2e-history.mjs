// End-to-end, history path: replay the bundled real-firmware showcase -> recorder -> IndexedDB -> Trends.
// Needs the app running (npm run dev). Takes about 40 s (the first tremor ends at ~29 s, plus the 3 s merge gap).
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = async (m) => { console.error('FAIL: ' + m); await browser.close(); process.exit(1); };
try {
  await page.goto(base + '/#/live');
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.getByRole('button', { name: 'Showcase, 2 min' }).click();
  await page.getByRole('heading', { name: 'Tremor detected' }).waitFor({ timeout: 25000 });
  console.log('replay: tremor detected');
  await page.getByText('This episode').waitFor({ timeout: 5000 });
  // the episode is stored once the alert has been off for the merge gap
  await page.waitForFunction(() => /\d+ episode/.test(document.body.innerText) && !document.body.innerText.includes('0 episodes'), null, { timeout: 30000 });
  await page.goto(base + '/#/trends');
  await page.locator('.ep-row').first().waitFor({ timeout: 10000 });
  const row = await page.locator('.ep-row').first().getAttribute('aria-label');
  console.log('Trends first episode: ' + row);
  if (!/Turn/.test(row ?? '')) await fail('expected a Turn episode from the showcase, got ' + row);
  const sess = await page.locator('.sess-row').first().textContent();
  console.log('Trends first session: ' + sess);
  if (!/Live|Replay/.test(sess ?? '')) await fail('expected the replay session');
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) { await fail(String(e)); }
await browser.close();
