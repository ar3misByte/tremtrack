// End-to-end, local path: real firmware (compiled by tools/hostsim) -> devsim WebSocket -> app in a browser.
// Needs: the app running (npm run dev) and tools/hostsim/bin/sim_current built (npm run hostsim).
// Usage: node scripts/e2e-local.mjs [baseUrl]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173';
const port = 8799;
const root = fileURLToPath(new URL('../../', import.meta.url));
const sim = spawn(process.execPath, ['--import', 'tsx', 'tools/devsim/src/devsim.ts', '--ws', '--port', String(port), '--hostsim', 'tremor_no_4.5hz_15dps'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let simLog = '';
sim.stderr.on('data', (d) => (simLog += d));
const fail = async (m) => { console.error('FAIL: ' + m + '\n--- devsim log ---\n' + simLog); sim.kill(); await browser?.close(); process.exit(1); };

let browser;
try {
  await new Promise((r) => setTimeout(r, 1500));
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/#/live');
  await page.evaluate((p) => {
    const k = 'htm.settings.v1';
    const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{},"version":0}');
    s.state.wsUrl = `ws://localhost:${p}`;
    localStorage.setItem(k, JSON.stringify(s));
  }, port);
  await page.reload();
  await page.getByRole('button', { name: /Change connection/ }).click();
  await page.getByRole('button', { name: /Wi-Fi or simulator/ }).click();
  const t0 = Date.now();
  await page.getByRole('heading', { name: 'Steady' }).waitFor({ timeout: 15000 });
  console.log(`live data, 'Steady' after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // hostsim: 5 s warm-up, tremor from scenario t = 10 s, about 1.7 s to detect
  await page.getByRole('heading', { name: 'Tremor detected' }).waitFor({ timeout: 30000 });
  const sub = await page.locator('.hero-text p').textContent();
  console.log(`'Tremor detected' after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${sub}`);
  if (!/Turning/.test(sub ?? '')) await fail(`expected a yaw ('no-no') tremor, got: ${sub}`);
  const rate = await page.locator('.chip', { hasText: '/s' }).first().textContent();
  console.log(`connection pill: ${rate}`);
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) {
  await fail(String(e));
}
sim.kill();
await browser.close();
