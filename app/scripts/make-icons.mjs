// Renders public/icon.svg to the PNG icons the install manifest needs (Android Chrome requires 192 and 512 px
// PNGs, and a maskable one with safe-zone padding). Run after changing the icon: node scripts/make-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const out = (n) => fileURLToPath(new URL(`../public/${n}`, import.meta.url));
const browser = await chromium.launch();
const render = async (size, name, { maskable = false } = {}) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // maskable icons are cropped to a circle or squircle: draw the artwork inside the central 80 % on a full-bleed background
  const inner = maskable ? `<div style="position:absolute;inset:0;background:#F2F1EE"></div><div style="position:absolute;inset:10%">${svg.replace('rx="112"', 'rx="0"').replace('<svg ', '<svg width="100%" height="100%" ')}</div>`
    : svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<body style="margin:0;background:transparent;position:relative;width:${size}px;height:${size}px">${inner}</body>`);
  await page.screenshot({ path: out(name), omitBackground: true });
  await page.close();
};
await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
await render(512, 'icon-maskable-512.png', { maskable: true });
await render(180, 'apple-touch-icon.png');
await browser.close();
console.log('icons written to public/');
