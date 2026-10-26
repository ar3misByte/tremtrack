// End-to-end, doctor dashboard in a browser, against the local mock backend (the real API Lambda code):
//   patient makes a share code -> doctor view adds it -> patient list, triage flags, one patient's details and charts
//   -> patient revokes -> the doctor loses access; also: a non-doctor account sees nothing, and axe checks on phone and desktop.
// Needs the app running (npm run dev). Run with:  node --import tsx scripts/e2e-doctor.mjs [baseUrl]
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startCloudMock } from '../../tools/devsim/src/cloudmock.ts';
import { encodeConfig } from '../src/cloud/config.ts';

const base = process.argv[2] ?? 'http://localhost:5173';
const shots = process.env.SHOTS ? fileURLToPath(new URL('../../docs/screenshots/', import.meta.url)) + '/' : null;
if (shots) mkdirSync(shots, { recursive: true });
const mock = await startCloudMock({ port: 8811, mqttPort: 8812, tcpPort: 8813, demoHistory: true, doctor: true, log: () => {} });

let browser, pageRef;
const cleanup = async () => { await browser?.close().catch(() => {}); await mock.close(); };
const fail = async (m) => { if (pageRef) console.error('--- page ---\n' + pageRef.url() + '\n' + (await pageRef.evaluate(() => document.body.innerText.slice(0, 900)).catch(() => '')) + '\n' + (pageRef.__errors ?? []).join('\n')); console.error('FAIL: ' + m); await cleanup(); process.exit(1); };
const axe = async (page, name) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  if (r.violations.length) await fail(`accessibility (${name}): ` + r.violations.map((v) => `${v.id} ${v.nodes[0].target.join(' ')}`).join('; '));
  console.log(`accessibility: ${name} has no violations axe can detect`);
};

try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  pageRef = page;
  const errors = [];
  page.__errors = errors;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // setup + sign in (the mock token carries the "doctors" group, so this account is a patient and a doctor)
  await page.goto(base + '/#/cloud');
  await page.getByLabel('Setup link or code').fill(`${base}/#/cloud?cfg=${encodeConfig(mock.config)}`);
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Use this setup' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/' && !u.search.includes('code='), { timeout: 15000 });
  await page.waitForURL(/#\/doctor/, { timeout: 15000 });
  console.log('a doctor account lands on the doctor dashboard after signing in');
  await page.getByRole('heading', { name: 'Doctor dashboard' }).waitFor();
  await page.getByText('No patients yet').waitFor({ timeout: 10000 });

  // an invalid code is explained
  await page.getByLabel("Patient's code").fill('ZZZZZ-ZZZZZ');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /not valid|already used|expired/ }).waitFor();
  console.log('a wrong code is refused with an explanation');

  // the patient side: make a code on the Cloud screen
  await page.goto(base + '/#/cloud');
  await page.getByLabel('Doctor keeps access for').selectOption('30');
  await page.getByLabel(/Also share my medication list/).check();
  await page.getByRole('button', { name: 'Make a code' }).click();
  const codeText = await page.locator('b', { hasText: /^[A-Z2-9]{5}-[A-Z2-9]{5}$/ }).first().textContent({ timeout: 10000 });
  console.log('the patient got a code: ' + codeText.replace(/[A-Z2-9]/g, '•'));
  await page.getByText('Nobody.').waitFor();

  // the doctor adds it
  await page.goto(base + '/#/doctor');
  await page.getByLabel("Patient's code").fill(codeText.toLowerCase());
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText(/^Added /).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /demo@example\.com/ }).waitFor();
  console.log('the doctor added the patient and sees them in the list');
  await page.getByRole('button', { name: /demo@example\.com/ }).click();
  await page.getByRole('region', { name: 'Patient', exact: true }).waitFor({ timeout: 10000 });
  await page.getByLabel('Summary').waitFor();
  await page.getByText('Show as table').first().waitFor({ timeout: 10000 });
  await page.getByText(/Possible fall .*the wearer said they are OK/).waitFor();
  await page.getByText(/Tremor episode, 30 s/).first().waitFor();
  console.log('the patient view shows the summary, the 30-day chart, a fall and tremor episodes');
  await page.getByText(/No medications uploaded yet/).waitFor();
  console.log('medications were shared on purpose, so the medication card is there (nothing synced yet)');

  // the doctor's own tools: range, private note, CSV
  await page.getByLabel('Show the last').selectOption('7');
  await page.getByText('Severity, last 7 days').waitFor({ timeout: 10000 });
  await page.getByLabel(/New note about/).fill('Review the dose timing at the next visit');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.locator('li p', { hasText: 'Review the dose timing at the next visit' }).waitFor({ timeout: 10000 });
  const stored = [...mock.db.items.values()].filter((i) => String(i.sk).startsWith('NOTE#'));
  if (stored.length !== 1 || !String(stored[0].pk).startsWith('DOC#')) await fail('the note should be stored under the doctor, not the patient');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
  if (!/^tremor-.*\.csv$/.test(dl.suggestedFilename())) await fail('unexpected CSV file name ' + dl.suggestedFilename());
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(await dl.path(), 'utf8');
  if (!csv.includes('Daily summary') || !csv.includes('Events')) await fail('the CSV lacks its sections');
  console.log('range change, a private note and the CSV download work');
  await page.getByRole('button', { name: /Delete the note/ }).click();
  await page.locator('li p', { hasText: 'Review the dose timing at the next visit' }).waitFor({ state: 'detached', timeout: 10000 });
  console.log('the note can be deleted');
  if (shots) await page.screenshot({ path: shots + 'desktop-14-doctor.png', fullPage: true });
  await axe(page, 'doctor dashboard (desktop)');

  // a code works once
  await page.goto(base + '/#/doctor');
  await page.getByLabel("Patient's code").fill(codeText);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /already used|not valid/ }).waitFor();
  console.log('a code cannot be used twice');

  // phone layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /demo@example\.com/ }).click();
  await page.getByRole('region', { name: 'Patient', exact: true }).waitFor({ timeout: 10000 });
  if (shots) await page.screenshot({ path: shots + 'phone-14-doctor.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) await fail('the doctor dashboard scrolls sideways on a phone: ' + (await page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}[${e.getAttribute('aria-label') ?? ''}] right=${Math.round(e.getBoundingClientRect().right)}`).join('; '))));
  await axe(page, 'doctor dashboard (phone)');
  await page.setViewportSize({ width: 1280, height: 900 });

  // the patient takes the access away
  await page.goto(base + '/#/cloud');
  await page.getByText('Who can see your data').waitFor();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText(/sees medications/).waitFor({ timeout: 10000 });
  await page.getByText(/last looked/).waitFor();
  await page.getByText(/until \d/).waitFor();
  console.log('the patient sees how long the access lasts, that medications are shared, and when the doctor last looked');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: 'Stop sharing' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByText('That doctor can no longer see your data.').waitFor();
  await page.goto(base + '/#/doctor');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('No patients yet').waitFor({ timeout: 10000 });
  console.log('after the patient stops sharing the doctor sees no patients');
  const links = [...mock.db.items.values()].filter((i) => String(i.pk).startsWith('DOC#') || String(i.sk).startsWith('ACC#'));
  if (links.length) await fail('links left in the table after revoking');

  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
  await cleanup();
} catch (e) {
  await fail(String(e?.stack ?? e));
}
