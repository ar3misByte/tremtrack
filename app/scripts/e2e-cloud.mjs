// End-to-end, cloud path in a browser: local mock backend (sign-in page, identity, the real API Lambda code, MQTT broker
// with the IoT rules) + a simulated headset publishing over MQTT + the app.
//   setup code -> sign in (redirect and back) -> device listed -> live view through the cloud -> history chart and events
//   -> sync a tag -> delete the cloud data
// Needs the app running (npm run dev). Run with:  node --import tsx scripts/e2e-cloud.mjs [baseUrl]
import { chromium } from 'playwright';
import { startCloudMock } from '../../tools/devsim/src/cloudmock.ts';
import { startMqtt } from '../../tools/devsim/src/mqtt.ts';
import { encodeConfig } from '../src/cloud/config.ts';

const base = process.argv[2] ?? 'http://localhost:5173';
const mock = await startCloudMock({ port: 8801, mqttPort: 8802, tcpPort: 8803, demoHistory: true, log: () => {} });
const deviceLog = [];
const dev = startMqtt({ endpoint: 'mock', thing: 'htm-mock', owner: mock.identityId, cert: '', key: '', ca: '', url: `mqtt://127.0.0.1:${mock.ports.tcp}` }, { fallAnswer: 'cancelled', minutes: 0, log: (m) => deviceLog.push(m), exitOnStop: false });

let browser, pageRef;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  await new Promise((r) => { dev.client.once('close', () => r()); dev.stop(); });
  await mock.close();
};
const fail = async (m) => { if (pageRef) console.error('--- page ---\n' + pageRef.url() + '\n' + (await pageRef.evaluate(() => document.body.innerText.slice(0, 700)).catch(() => '')) + '\n' + (pageRef.__errors ?? []).join('\n')); console.error('FAIL: ' + m + '\n--- headset log ---\n' + deviceLog.slice(-8).join('\n')); await cleanup(); process.exit(1); };

try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  pageRef = page;
  const errors = [];
  page.__errors = errors;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // 1. setup from a pasted code (what tools/aws/app-link.mjs prints)
  await page.goto(base + '/#/cloud');
  await page.getByText('Set up the cloud', { exact: true }).waitFor();
  await page.getByLabel('Setup link or code').fill('cfg=garbage');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('alert').filter({ hasText: /could not be read|No setup code/ }).waitFor();
  console.log('a bad setup code is refused with an explanation');
  await page.getByLabel('Setup link or code').fill(`${base}/#/cloud?cfg=${encodeConfig(mock.config)}`);
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Use this setup' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  console.log('setup accepted');

  // 2. sign in: to the (mock) login page and back with ?code=
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/' && !u.search.includes('code='), { timeout: 15000 });   // the app removes the code from the address bar
  await page.getByText('Signed in', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByText('demo@example.com').waitFor();
  console.log('signed in through the login page (PKCE) as demo@example.com');

  // 3. the headset is listed; history and events come from the seeded two weeks
  await page.getByText('htm-mock', { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByText('Online').first().waitFor({ timeout: 15000 });
  console.log('headset htm-mock is listed and online');
  await page.getByText('Show as table').waitFor({ timeout: 10000 });
  await page.getByText(/Possible fall .*the wearer said they are OK/).waitFor();
  await page.getByText(/Tremor episode, 30 s/).first().waitFor();
  console.log('30-day chart, a fall and tremor episodes are shown from the cloud');

  // 4. live view through the cloud
  await page.getByRole('button', { name: 'Watch live' }).click();
  await page.waitForURL(/#\/live/);
  await page.getByText(/Remote view through the cloud/).waitFor({ timeout: 15000 });
  const t0 = Date.now();
  await page.getByRole('heading', { name: /Steady|Tremor detected|Walking/ }).waitFor({ timeout: 25000 });
  console.log(`live data from the headset through the cloud after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!deviceLog.some((l) => /viewer watching: telemetry every 1 s/.test(l))) await fail('the headset never saw the viewer flag');
  await page.getByRole('button', { name: 'Stop watching' }).first().click();
  await page.waitForFunction(() => !document.body.textContent.includes('Remote view through the cloud'), null, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 800));
  if (!deviceLog.some((l) => /viewer gone/.test(l))) await fail('the viewer flag was not cleared');
  console.log('stop watching clears the viewer flag, so the headset slows down again');

  // 5. a tag, then sync
  await page.goto(base + '/#/log');
  await page.getByRole('button', { name: /Coffee/ }).first().click();
  await page.goto(base + '/#/cloud');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.getByText(/Done .*sent [1-9]\d* records/).waitFor({ timeout: 15000 });
  const tags = [...mock.db.items.values()].filter((i) => String(i.sk).startsWith('TG#'));
  if (tags.length < 1) await fail('the tag did not reach the cloud table');
  console.log(`sync: the tag reached the cloud table (${tags.length})`);

  // 6. delete
  await page.getByRole('button', { name: 'Delete cloud data…' }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await page.getByText(/Deleted \d+ items from the cloud/).waitFor({ timeout: 10000 });
  const left = [...mock.db.items.values()].filter((i) => String(i.pk).startsWith('U#'));
  if (left.length) await fail(`${left.length} user items left after deletion`);
  console.log('cloud data deleted: nothing left under the user');

  // 7. signing out and forgetting the setup
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
  await cleanup();
} catch (e) {
  await fail(String(e?.stack ?? e));
}
