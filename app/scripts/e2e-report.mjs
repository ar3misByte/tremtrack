// End-to-end, report: sample history -> Report screen -> Download PDF -> valid multi-page PDF saved
// to tools/hostsim/out/e2e-report.pdf (git-ignored) for checking with scripts/pdf-shots.mjs.
// Needs the app running (npm run dev). Usage: node scripts/e2e-report.mjs [baseUrl]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = fileURLToPath(new URL('../../tools/hostsim/out/e2e-report.pdf', import.meta.url));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const fail = async (m) => { console.error('FAIL: ' + m); await browser.close(); process.exit(1); };
try {
  await page.goto(base + '/#/settings');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load 4 weeks of sample history' }).click();
  await page.waitForTimeout(1500);
  await page.goto(base + '/#/report');
  await page.getByText(/Episode table: \d+/).waitFor({ timeout: 15000 });
  console.log('preview: ' + (await page.locator('[aria-label="What the report will contain"]').textContent()).replace(/\s+/g, ' ').slice(0, 220));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Download PDF' }).click()]);
  await dl.saveAs(out);
  const buf = readFileSync(out);
  console.log(`download: ${dl.suggestedFilename()} ${Math.round(buf.length / 1024)} KB`);
  if (buf.subarray(0, 5).toString() !== '%PDF-') await fail('not a PDF');
  const pages = (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
  console.log(`pages: ${pages}`);
  if (pages < 4) await fail('expected at least 4 pages');
  console.log('status: ' + (await page.locator('[role="status"]').last().textContent()));
  if (errors.length) await fail('page errors: ' + errors.join('; '));
  console.log('PASS');
} catch (e) { await fail(String(e)); }
await browser.close();
