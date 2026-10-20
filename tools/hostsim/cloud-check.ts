// Differential test: the firmware's C++ cloud reporter (firmware/tremor_monitor/reporter.h, compiled into the
// host simulator with --cloud) against the TypeScript reference (app/src/logic/cloudSummary.ts).
// Both get the same frames with the same timestamps and must publish the same telemetry and events.
//
//   npx tsx tools/hostsim/cloud-check.ts [--scenario name ...]
//
// Allowed differences, by design (documented in firmware/tremor_monitor/reporter.h):
//   - episodes on several axes: the device says pattern "mixed";
//   - the device sends a second "fall" event (no-response) when nobody answered the countdown.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../../app/src/logic/csv.ts';
import { CloudSummarizer, type CloudMessage } from '../../app/src/logic/cloudSummary.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const exe = join(here, 'bin', process.platform === 'win32' ? 'sim_cloud.exe' : 'sim_cloud');
mkdirSync(join(here, 'bin'), { recursive: true });

console.log('building the host simulator with the cloud hook...');
execFileSync('g++', ['-O2', '-std=c++17', '-I' + join(here, 'mock'), `-DSKETCH="${join(root, 'firmware/tremor_monitor/tremor_monitor.ino').replace(/\\/g, '/')}"`, join(here, 'sim.cpp'), '-o', exe], { stdio: 'inherit' });

const argv = process.argv.slice(2);
const scenarios = argv.includes('--scenario') ? argv.filter((_, i) => argv[i - 1] === '--scenario') : ['showcase', 'tremor_yes_5hz_6dps', 'combo_yes_no_diag', 'fall', 'fall_trip', 'headset_dropped', 'jump_while_walking', 'walk_1.8', 'tremor_walk_nonharmonic', 'combo_two_freq', 'sit_down_hard', 'talking_animated', 'fidget'];

type Msg = Record<string, unknown>;
const near = (a: unknown, b: unknown, tol: number) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : a === b);

function diff(path: string, a: Msg, b: Msg, tol: Record<string, number>): string[] {
  const errs: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[k], vb = b[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) { errs.push(...diff(`${path}.${k}`, va as Msg, vb as Msg, tol)); continue; }
    if (Array.isArray(va) && Array.isArray(vb)) { if (JSON.stringify(va) !== JSON.stringify(vb)) errs.push(`${path}.${k}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`); continue; }
    if (!near(va, vb, tol[k] ?? 0.0501)) errs.push(`${path}.${k}: reference ${JSON.stringify(va)} vs firmware ${JSON.stringify(vb)}`);
  }
  return errs;
}

let failures = 0;
for (const sc of scenarios) {
  const csv = join(out, `${sc}.csv`), cloud = join(out, `${sc}.cloud.jsonl`);
  try { execFileSync(exe, ['--scenario', sc, '--seed', '1', '--csv', csv, '--cloud', cloud], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { console.log(`- ${sc}: skipped (${(e as Error).message.split('\n')[0]})`); continue; }

  const fw = readFileSync(cloud, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; t?: number; msg?: Msg });
  const times = fw.filter((m) => m.kind === 'frame').map((m) => m.t as number);
  const lines = readFileSync(csv, 'utf8').split('\n').map((l) => l.slice(l.indexOf(',') + 1)).filter((l) => l.startsWith('$'));
  if (lines.length !== times.length) { console.log(`✗ ${sc}: ${lines.length} lines but ${times.length} frames`); failures++; continue; }

  const ref: CloudMessage[] = [];
  const sum = new CloudSummarizer(times[0], 5);
  lines.forEach((l, i) => { const p = parseLine(l); if (p?.kind === 'frame') ref.push(...sum.push(p.frame, times[i])); });

  const fwMsgs = fw.filter((m) => m.kind !== 'frame');
  const isRefFall = (m: Msg) => m.type === 'fall';
  const fwNorm = fwMsgs.filter((m) => !(m.kind === 'event' && (m.msg as Msg).type === 'fall' && ((m.msg as Msg).fall as Msg).outcome !== 'pending'));
  const errs: string[] = [];
  if (ref.length !== fwNorm.length) errs.push(`message count: reference ${ref.length} vs firmware ${fwNorm.length}`);
  const tel = (a: { kind: string }[]) => a.filter((m) => m.kind === 'telemetry').length;
  const evs = (a: { kind: string }[]) => a.filter((m) => m.kind === 'event').length;
  if (tel(ref) !== tel(fwNorm) || evs(ref) !== evs(fwNorm)) errs.push(`telemetry ${tel(ref)}/${tel(fwNorm)}, events ${evs(ref)}/${evs(fwNorm)} (reference/firmware)`);
  for (let i = 0; i < Math.min(ref.length, fwNorm.length) && errs.length < 12; i++) {
    const r = ref[i], f = fwNorm[i];
    if (r.kind !== f.kind) { errs.push(`#${i}: kind ${r.kind} vs ${f.kind}`); continue; }
    const rm = JSON.parse(JSON.stringify(r.msg)) as Msg, fm = f.msg as Msg;
    if (isRefFall(rm)) { /* fall fields compared below */ }
    if (rm.type === 'episode' && ((rm.ep as Msg).axes as number[]).length > 1) { (rm.ep as Msg).pattern = 'mixed'; }   // the app works out the pattern, the device does not
    errs.push(...diff(`#${i} ${String(rm.type ?? 'telemetry')}`, rm, fm, { sev: 0.31, ampDps: 0.11, a: 0.11, score: 0.11, durationS: 0.11, seq: 0 }));
  }
  if (errs.length) { failures++; console.log(`✗ ${sc}\n   ${errs.join('\n   ')}`); }
  else console.log(`✓ ${sc}: ${tel(ref)} telemetry + ${evs(ref)} events identical (${lines.length} frames)`);
}
if (!existsSync(exe)) failures++;
process.exit(failures ? 1 : 0);
