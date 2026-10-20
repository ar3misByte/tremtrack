// End-to-end, phone path: the app connects over (fake) Bluetooth to a "headset" that streams real firmware output
// (recorded from the host simulator), shows live data and the tremor alert, shows the device status in
// Settings -> Headset, and sends the Wi-Fi setup command in 20-byte writes.
// The real Web Bluetooth API cannot be driven headless, so navigator.bluetooth is replaced with a fake that
// follows the same calls (requestDevice -> gatt.connect -> service -> characteristics -> notifications / writes).
// Needs: the app running (npm run dev) and tools/hostsim/bin/sim_cloud (npm run hostsim:cloud builds it).
// Usage: node scripts/e2e-device.mjs [baseUrl]
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fakeHeadset } from './fakeHeadset.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5173';
const root = fileURLToPath(new URL('../../', import.meta.url));
const exe = join(root, 'tools/hostsim/bin', process.platform === 'win32' ? 'sim_cloud.exe' : 'sim_cloud');
if (!existsSync(exe)) { console.error('Build the simulator first: npm run hostsim:cloud'); process.exit(2); }
mkdirSync(join(root, 'tools/hostsim/out'), { recursive: true });
const csv = join(root, 'tools/hostsim/out/e2e-device.csv');
execFileSync(exe, ['--scenario', 'tremor_no_4.5hz_15dps', '--seed', '1', '--csv', csv], { stdio: 'ignore' });
const lines = readFileSync(csv, 'utf8').split('\n').map((l) => l.trim().slice(l.indexOf(',') + 1)).filter((l) => l.startsWith('$'));
// a compass calibration recorded from the real firmware: state 1 -> 4 (progress lines) -> 3
const csv2 = join(root, 'tools/hostsim/out/e2e-compass.csv');
execFileSync(exe, ['--scenario', 'compass_session', '--seed', '1', '--mag', '--mag-cal-at', '1', '--csv', csv2], { stdio: 'ignore' });
const magLines = readFileSync(csv2, 'utf8').split('\n').map((l) => l.trim().slice(l.indexOf(',') + 1)).filter((l) => l.startsWith('$') || l.startsWith('# MAG')).slice(0, 1800);
console.log(`${lines.length} real firmware lines to stream`);
// a fall recorded from the real firmware
const csv3 = join(root, 'tools/hostsim/out/e2e-fall.csv');
execFileSync(exe, ['--scenario', 'fall', '--seed', '1', '--csv', csv3], { stdio: 'ignore' });
const fallLines = readFileSync(csv3, 'utf8').split('\n').map((l) => l.trim().slice(l.indexOf(',') + 1)).filter((l) => l.startsWith('$'));

let browser;
const fail = async (m) => { console.error('FAIL: ' + m); await browser?.close(); process.exit(1); };
const axe = async (page, name) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  if (r.violations.length) await fail(`accessibility (${name}): ` + r.violations.map((v) => `${v.id} ${v.nodes[0].target.join(' ')}`).join('; '));
  console.log(`accessibility: ${name} has no violations axe can detect`);
};

try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(fakeHeadset, { lines: lines.slice(0, 2400) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#/live');
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.getByRole('button', { name: /Bluetooth/ }).click();
  const t0 = Date.now();
  await page.getByRole('heading', { name: 'Steady' }).waitFor({ timeout: 15000 });
  console.log(`live data over Bluetooth after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.getByRole('heading', { name: 'Tremor detected' }).waitFor({ timeout: 40000 });
  const sub = await page.locator('.hero-text p').textContent();
  console.log(`'Tremor detected': ${sub}`);
  if (!/Turning/.test(sub ?? '')) await fail(`expected a yaw ('no-no') tremor, got: ${sub}`);

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await page.getByText('HeadTremor-TEST').waitFor({ timeout: 8000 });
  console.log('Settings -> Headset shows the device name from the INFO line');
  await page.getByLabel('Wi-Fi network (2.4 GHz)').fill('My Home Network');
  await page.getByLabel('Wi-Fi password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Send to headset' }).click();
  await page.waitForFunction(() => (window.__cmds ?? []).some((c) => c.startsWith('!wifi ')), null, { timeout: 5000 });
  const cmds = await page.evaluate(() => window.__cmds);
  const wifi = cmds.find((c) => c.startsWith('!wifi '));
  if (wifi !== '!wifi My Home Network\tcorrect horse battery staple') await fail('wifi command wrong: ' + JSON.stringify(wifi));
  const sizes = await page.evaluate(() => window.__written);
  if (Math.max(...sizes) > 20) await fail('a write exceeded 20 bytes: ' + Math.max(...sizes));
  if (!cmds.includes('!info') || !cmds.some((c) => /^!tz -?\d+$/.test(c))) await fail('expected !tz and !info on connect, got ' + JSON.stringify(cmds));
  console.log(`commands sent: ${cmds.map((c) => c.split('\t')[0]).join(', ')} (largest write ${Math.max(...sizes)} bytes)`);
  if (errors.length) await fail('page errors: ' + errors.join('; '));

  // ---- phase 2: compass calibration shown in Settings -> Headset ----
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(fakeHeadset, { lines: magLines });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(base + '/#/live');
  await p2.getByRole('button', { name: /Change connection/ }).click();
  await p2.getByRole('button', { name: /Bluetooth/ }).click();
  await p2.getByRole('heading', { name: 'Steady' }).waitFor({ timeout: 15000 });
  await p2.getByRole('link', { name: 'Settings' }).click();
  await p2.getByText('Fitted but not calibrated').waitFor({ timeout: 15000 });
  console.log('compass state 1: "Fitted but not calibrated"');
  await p2.getByText(/Calibrating: turn the headset slowly/).waitFor({ timeout: 15000 });
  await p2.getByRole('progressbar').waitFor();
  console.log('compass state 4: calibrating, progress bar shown');
  await axe(p2, 'Settings with the Headset and Compass cards (calibrating)');
  await p2.getByText('Calibrated and keeping the yaw steady.').waitFor({ timeout: 30000 });
  await p2.getByText(/Last result: calibrated: (good|fair)/).waitFor({ timeout: 5000 });
  console.log('compass state 3: calibrated, result line shown');
  await p2.getByRole('button', { name: 'Forget calibration' }).click();
  await p2.waitForFunction(() => (window.__cmds ?? []).includes('!mag clear'), null, { timeout: 5000 });

  // ---- phase 2b: Orientation card on the Live screen (reverse a direction, mount the board differently) ----
  await p2.goto(base + '/#/live');
  await p2.getByText('Orientation', { exact: true }).waitFor();
  await p2.getByText('Board mounted differently? Say how it sits on the head').click();
  await p2.getByLabel('Common mountings').selectOption({ label: 'Standing on its edge: X to the right, Y down, Z forward' });
  await p2.getByRole('button', { name: 'Apply to the headset' }).click();
  await p2.waitForFunction(() => (window.__cmds ?? []).includes('!orient +x +z -y'), null, { timeout: 5000 });
  console.log('mounting "standing on its edge" was sent as !orient +x +z -y');
  await p2.getByLabel('Sensor X arrow points').selectOption('right');
  await p2.getByLabel('Sensor Y arrow points').selectOption('left');
  await p2.getByText(/cannot point along the same line/).waitFor();
  if (!(await p2.getByRole('button', { name: 'Apply to the headset' }).isDisabled())) await fail('an impossible mounting must not be sendable');
  await p2.getByLabel('Sensor Y arrow points').selectOption('forward');
  await p2.getByLabel('Sensor Z arrow points').selectOption('down');
  await p2.getByText(/right-handed/).waitFor();
  console.log('impossible mountings are refused with a reason');
  await p2.getByRole('button', { name: 'Reset to default' }).click();
  await p2.getByRole('checkbox', { name: 'Reverse' }).first().check();
  const stored = await p2.evaluate(() => JSON.parse(localStorage.getItem('htm.settings.v1')).state.mapping);
  if (!stored.flipPitch) await fail('Reverse up/down was not stored');
  console.log('Reverse up/down is stored; the picture follows it');
  await axe(p2, 'Live screen with the Orientation card open');

  // ---- phase 3: a fall seen over Bluetooth; the answer is forwarded to the headset (which tells the cloud) ----
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addInitScript(fakeHeadset, { lines: fallLines });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(e.message));
  await p3.goto(base + '/#/live');
  await p3.getByRole('button', { name: /Change connection/ }).click();
  await p3.getByRole('button', { name: /Bluetooth/ }).click();
  await p3.getByRole('alertdialog', { name: 'Possible fall detected' }).waitFor({ timeout: 40000 });
  await p3.getByRole('button', { name: "I'm OK" }).click();
  await p3.waitForFunction(() => (window.__cmds ?? []).includes('!fall cancelled'), null, { timeout: 5000 });
  console.log('fall over Bluetooth: "I\'m OK" was forwarded to the headset as !fall cancelled');
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) {
  await fail(String(e));
}
await browser.close();
