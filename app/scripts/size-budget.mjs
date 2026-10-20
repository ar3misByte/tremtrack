// Fails if the production bundle grows past its budget (gzip sizes). Run after `vite build`.
// "Initial" = the JS and CSS that index.html loads (entry + modulepreloads); everything else loads on demand.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const html = readFileSync(dist + 'index.html', 'utf8');
const initialFiles = new Set([...html.matchAll(/(?:src|href)="\/?assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]));
const BUDGET_KB = { initialJs: 110, lazy3d: 280, lazyOther: 80, css: 20 };
let initialJs = 0, lazy3d = 0, lazyOther = 0, css = 0;
for (const f of readdirSync(dist + 'assets')) {
  const kb = gzipSync(readFileSync(dist + 'assets/' + f)).length / 1024;
  if (f.endsWith('.css')) css += kb;
  else if (!f.endsWith('.js')) continue;
  else if (initialFiles.has(f)) initialJs += kb;
  else if (/^(three|Head3D)-/.test(f)) lazy3d += kb;
  else lazyOther += kb;
}
const rows = [['initial JS', initialJs, BUDGET_KB.initialJs], ['3D (lazy)', lazy3d, BUDGET_KB.lazy3d], ['screens (lazy)', lazyOther, BUDGET_KB.lazyOther], ['CSS', css, BUDGET_KB.css]];
let ok = true;
for (const [n, v, b] of rows) { console.log(`${n.padEnd(15)} ${v.toFixed(1).padStart(7)} KB gz  (budget ${b})`); if (v > b) ok = false; }
if (!ok) { console.error('size budget exceeded'); process.exit(1); }
