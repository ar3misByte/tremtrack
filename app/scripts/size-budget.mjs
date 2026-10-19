// Fails if the production bundle grows past its budget (gzip sizes). Run after `vite build`.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const BUDGET_KB = { initialJs: 110, three: 280, css: 20 };   // initial = everything except the lazily loaded 3D chunks
let initial = 0, three = 0, css = 0;
for (const f of readdirSync(dir)) {
  const kb = gzipSync(readFileSync(dir + f)).length / 1024;
  if (f.endsWith('.css')) css += kb;
  else if (f.endsWith('.js')) { if (/^(three|Head3D)-/.test(f)) three += kb; else initial += kb; }
}
const rows = [['initial JS', initial, BUDGET_KB.initialJs], ['3D (lazy)', three, BUDGET_KB.three], ['CSS', css, BUDGET_KB.css]];
let ok = true;
for (const [n, v, b] of rows) { console.log(`${n.padEnd(12)} ${v.toFixed(1).padStart(7)} KB gz  (budget ${b})`); if (v > b) ok = false; }
if (!ok) { console.error('size budget exceeded'); process.exit(1); }
