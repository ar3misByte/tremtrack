// Screenshots of the connected states that need a (fake) headset or the local mock cloud: Settings -> Headset and
// Compass, the Cloud screen before and after sign-in, and the live view through the cloud. Written to docs/screenshots/.
// Needs the app running (npm run dev). Run with:  node --import tsx scripts/ui-shots.mjs [baseUrl]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCloudMock } from '../../tools/devsim/src/cloudmock.ts';
import { startMqtt } from '../../tools/devsim/src/mqtt.ts';
import { encodeConfig } from '../src/cloud/config.ts';
import { fakeHeadset } from './fakeHeadset.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = (n) => join(root, 'docs/screenshots', n);
mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
const exe = join(root, 'tools/hostsim/bin', process.platform === 'win32' ? 'sim_cloud.exe' : 'sim_cloud');
if (!existsSync(exe)) { console.error('Build the simulator first: npm run hostsim:cloud'); process.exit(2); }
const csv = join(root, 'tools/hostsim/out/ui-shots.csv');
execFileSync(exe, ['--scenario', 'compass_session', '--seed', '1', '--mag', '--mag-cal-at', '1', '--csv', csv], { stdio: 'ignore' });
const lines = readFileSync(csv, 'utf8').split('\n').map((l) => l.trim().slice(l.indexOf(',') + 1)).filter((l) => l.startsWith('$') || l.startsWith('# MAG')).slice(0, 1800);

const mock = await startCloudMock({ port: 8801, mqttPort: 8802, tcpPort: 8803, demoHistory: true, log: () => {} });
const dev = startMqtt({ endpoint: 'mock', thing: 'htm-mock', owner: mock.identityId, cert: '', key: '', ca: '', url: `mqtt://127.0.0.1:${mock.ports.tcp}` }, { fallAnswer: 'cancelled', minutes: 0, log: () => {}, exitOnStop: false });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const watch = (page, name) => { page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); }); };
const noOverflow = async (page, name) => { const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 1) errors.push(`${name}: horizontal overflow of ${o}px`); };

try {
  // ---- Settings -> Headset and Compass, over (fake) Bluetooth ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.addInitScript(fakeHeadset, { lines });
  const p = await phone.newPage(); watch(p, 'phone-headset');
  await p.goto(base + '/#/live');
  await p.getByRole('button', { name: /Change connection/ }).click();
  await p.getByRole('button', { name: /Bluetooth/ }).click();
  await p.getByRole('heading', { name: 'Steady' }).waitFor({ timeout: 15000 });
  await p.getByRole('link', { name: 'Settings' }).click();
  await p.getByText('Fitted but not calibrated').waitFor({ timeout: 15000 });
  await p.getByLabel('Wi-Fi network (2.4 GHz)').fill('Home network');
  await p.waitForTimeout(300);
  await p.screenshot({ path: out('phone-12-settings-headset.png') });
  await noOverflow(p, 'settings headset');
  await p.getByText(/Calibrating: turn the headset slowly/).waitFor({ timeout: 15000 });
  await p.locator('[aria-label="Compass"]').scrollIntoViewIfNeeded();
  await p.waitForTimeout(300);
  await p.screenshot({ path: out('phone-13-compass-calibrating.png') });
  await p.getByText('Calibrated and keeping the yaw steady.').waitFor({ timeout: 30000 });
  await p.locator('[aria-label="Compass"]').scrollIntoViewIfNeeded();
  await p.screenshot({ path: out('phone-14-compass-calibrated.png') });
  await phone.close();

  // ---- Cloud: setup, signed in, live ----
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const c = await ctx.newPage(); watch(c, 'phone-cloud');
  await c.goto(base + '/#/cloud');
  await c.getByText('Set up the cloud', { exact: true }).waitFor();
  await c.screenshot({ path: out('phone-10-cloud-setup.png') });
  await noOverflow(c, 'cloud setup');
  await c.getByLabel('Setup link or code').fill(`${base}/#/cloud?cfg=${encodeConfig(mock.config)}`);
  await c.getByRole('button', { name: 'Check' }).click();
  await c.getByRole('button', { name: 'Use this setup' }).waitFor();
  await c.screenshot({ path: out('phone-10b-cloud-setup-check.png') });
  await c.getByRole('button', { name: 'Use this setup' }).click();
  await c.getByRole('button', { name: 'Sign in' }).click();
  await c.getByText('Signed in', { exact: true }).waitFor({ timeout: 15000 });
  await c.getByText('Online').first().waitFor({ timeout: 15000 });
  await c.getByText('Show as table').waitFor();
  await c.waitForTimeout(500);
  await c.screenshot({ path: out('phone-11-cloud-signed-in.png') });
  await c.screenshot({ path: out('phone-11b-cloud-signed-in-full.png'), fullPage: true });
  await noOverflow(c, 'cloud signed in');
  await c.getByRole('button', { name: 'Watch live' }).click();
  await c.getByText(/Remote view through the cloud/).waitFor({ timeout: 15000 });
  await c.getByRole('heading', { name: /Steady|Tremor detected|Walking/ }).waitFor({ timeout: 25000 });
  await c.waitForTimeout(1500);
  await c.screenshot({ path: out('phone-15-live-through-cloud.png') });
  await noOverflow(c, 'live through cloud');
  await ctx.close();

  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const d = await desk.newPage(); watch(d, 'desktop-cloud');
  await d.goto(base + '/#/cloud');
  await d.getByText('Signed in', { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
  await d.waitForTimeout(500);
  await d.screenshot({ path: out('desktop-cloud.png') });
  await desk.close();
} finally {
  await browser.close();
  await new Promise((r) => { dev.client.once('close', () => r()); dev.stop(); });
  await mock.close();
}
if (errors.length) { console.error('PROBLEMS:\n' + errors.join('\n')); process.exit(1); }
console.log('screenshots written to docs/screenshots/, no page errors, no horizontal overflow');
