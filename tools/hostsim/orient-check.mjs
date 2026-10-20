#!/usr/bin/env node
// Mounting and drift checks against the real firmware in the host simulator:
//   1. a board mounted in another orientation, told so with `!orient`, gives the same angles and detections as the default one
//      (and without the command the axes really are confused: the command is what fixes it)
//   2. invalid mountings (a mirror image, a repeated axis) are refused
//   3. while the head is still, the gyro bias is learned, so the yaw stops creeping (zero-rate update, `!zupt`)
//   4. the zero-rate update does not change tremor, walking or any other output
//   node tools/hostsim/orient-check.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
mkdirSync(join(here, 'bin'), { recursive: true });
const exe = join(here, 'bin', process.platform === 'win32' ? 'sim_cloud.exe' : 'sim_cloud');
execFileSync('g++', ['-O2', '-std=c++17', '-I' + join(here, 'mock'), `-DSKETCH="${join(root, 'firmware/tremor_monitor/tremor_monitor.ino').replace(/\\/g, '/')}"`, join(here, 'sim.cpp'), '-o', exe], { stdio: 'inherit' });

function run(scenario, flags = []) {
  const csv = join(out, 'orient.csv'), report = join(out, 'orient.report.json');
  execFileSync(exe, ['--scenario', scenario, '--seed', '1', '--csv', csv, '--mag-report', report, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = readFileSync(csv, 'utf8').split('\n').map((l) => l.trim());
  return {
    status: lines.filter((l) => l.includes(',# ')).map((l) => l.slice(l.indexOf('# '))),
    frames: lines.filter((l) => l.includes(',$,')).map((l) => l.slice(l.indexOf(',') + 1).split(',').slice(1).map(Number)),   // after the '$'
    times: lines.filter((l) => l.includes(',$,')).map((l) => Math.round(Number(l.slice(0, l.indexOf(','))) * 50)),             // frame number at 50 Hz
    report: JSON.parse(readFileSync(report, 'utf8')),
  };
}

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };
// frame columns: 0 pitch, 1 roll, 2 yaw, 6 tremor, 7 dir, 8-10 amp, 20 axes

const MOUNTS = [
  ['rotated 90° about the vertical', '+y -x +z'],
  ['standing on its edge (Z forward)', '+x +z -y'],
  ['upside down', '-x +y -z'],
  ['on its side', '+z +y -x'],
];
const zupt = ['--send', '!zupt off\\n'];                     // isolate the mounting from the drift correction
// compare frame by frame at the same moment (the 2 s re-calibration after !orient pauses the stream, so indexes shift)
const pairs = (a, b, fromSec) => { const m = new Map(b.times.map((t, i) => [t, i])); return a.times.map((t, i) => [i, m.get(t)]).filter(([i, j]) => j !== undefined && a.times[i] > fromSec * 50).map(([i, j]) => [a.frames[i], b.frames[j]]); };
const same = (a, b, fromSec) => { const p = pairs(a, b, fromSec); return p.length > 1000 && p.every(([x, y]) => Math.abs(x[0] - y[0]) < 2 && Math.abs(x[1] - y[1]) < 2 && Math.abs(x[2] - y[2]) < 2); };

const ref = run('tremor_no_4.5hz_6dps', zupt);
const refYes = run('tremor_yes_5hz_6dps', zupt);
for (const [name, m] of MOUNTS) {
  const mount = m.replace(/ /g, ',');
  const set = run('tremor_no_4.5hz_6dps', [...zupt.slice(0, 1), `!orient ${m}\\n!zupt off\\n`, '--mount', mount]);
  const p = pairs(set, ref, 10);
  const agree = p.filter(([x, y]) => x[6] === y[6]).length / p.length;
  const both = p.filter(([x, y]) => x[6] === 1 && y[6] === 1);
  const dirOk = both.length > 100 && both.every(([x]) => x[7] === 2);
  check(same(set, ref, 10) && agree > 0.97 && dirOk, `${name} (${m}): angles within 2° of the default mounting, the "no-no" tremor still found on the yaw axis (${(agree * 100).toFixed(1)} % of frames agree)`);
  if (name.startsWith('standing') || name.startsWith('on its side')) {
    const wrong = run('tremor_no_4.5hz_6dps', [...zupt, '--mount', mount]);       // mounted, but the firmware not told
    const dirs = wrong.frames.filter((f) => f[6] === 1).map((f) => f[7]);
    check(dirs.length === 0 || dirs.filter((d) => d !== 2).length / dirs.length > 0.5, `${name}: without !orient the axes are confused (the command is what fixes it)`);
  }
}
const yes = run('tremor_yes_5hz_6dps', ['--send', '!orient +x +z -y\\n!zupt off\\n', '--mount', '+x,+z,-y']);
check(yes.frames.filter((f) => f[6] === 1).every((f) => f[7] === 0) && yes.frames.some((f) => f[6] === 1), 'a "yes-yes" tremor stays a "yes-yes" tremor on the board standing on its edge');

const fall = run('fall', ['--send', '!orient -x +y -z\\n!zupt off\\n', '--mount', '-x,+y,-z']);
check(fall.frames.some((f) => f[21] > 5), 'a fall is still seen with the board upside down (|a| peaks above 5 g)');

const bad = run('still', ['--send', '!orient +x +y -z\\n!orient +x +x +z\\n!orient +x\\n']);
check(bad.status.filter((s) => /ORIENT invalid/.test(s)).length === 3 && !bad.status.some((s) => /ORIENT applied/.test(s)), 'a mirror image, a repeated axis and a short command are all refused');
const ok = run('still', ['--send', '!orient +y -x +z\\n']);
check(ok.status.some((s) => /ORIENT \+y -x \+z/.test(s)) && ok.status.some((s) => /ORIENT applied/.test(s)), 'a valid mounting is accepted, announced, and re-calibrated');

// ---- drift ----
const d0 = run('drift_still', ['--send', '!zupt off\\n']), d1 = run('drift_still');
check(Math.abs(d0.report.yawErrEnd) > 25, `sitting still with a drifting gyro, no correction: the yaw ends ${d0.report.yawErrEnd.toFixed(1)}° off after 150 s`);
check(Math.abs(d1.report.yawErrEnd) < 8 && Math.abs(d1.report.yawErrEnd) < Math.abs(d0.report.yawErrEnd) / 5, `with the zero-rate update it ends ${d1.report.yawErrEnd.toFixed(1)}° off: the head stays put`);

for (const sc of ['tremor_no_4.5hz_6dps', 'combo_yes_no_diag', 'walk_1.8', 'voluntary_turns', 'talking']) {
  const a = run(sc, zupt), b = run(sc);
  const cols = (r) => r.frames.map((f) => f.filter((_, i) => i !== 2 && i !== 0 && i !== 1).join(','));        // everything except the angles
  check(JSON.stringify(cols(a)) === JSON.stringify(cols(b)), `${sc}: tremor, walking and every other output unchanged by the zero-rate update`);
}
process.exit(failed ? 1 : 0);
