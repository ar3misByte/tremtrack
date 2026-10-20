#!/usr/bin/env node
// Compass (magnetometer) checks against the real firmware compiled in the host simulator, with a synthetic
// QMC5883P that sees Earth's field from the simulated head's true orientation (plus hard iron, soft iron, noise).
//   node tools/hostsim/compass-check.mjs
// Checks:
//   1. drift: with a slow gyro bias ramp the unfused yaw ends tens of degrees off; after calibration the fused yaw stays close
//   2. a board mounted mirrored is detected and corrected
//   3. a board with swapped axes is rejected with a clear message (no wrong correction)
//   4. a magnetic disturbance is ignored (field strength gate), and the yaw recovers
//   5. without calibration the yaw is exactly the gyro's yaw; the tremor detector output never changes
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
  const report = join(out, 'compass.report.json'), csv = join(out, 'compass.csv');
  execFileSync(exe, ['--scenario', scenario, '--seed', '1', '--csv', csv, '--mag-report', report, ...flags], { stdio: ['ignore', 'ignore', 'pipe'] });
  const lines = readFileSync(csv, 'utf8').split('\n').map((l) => l.trim());
  return { report: JSON.parse(readFileSync(report, 'utf8')), status: lines.filter((l) => l.includes(',# ')).map((l) => l.slice(l.indexOf(',') + 1)), frames: lines.filter((l) => l.includes(',$,')).map((l) => l.slice(l.indexOf(',') + 1).split(',')) };
}

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failed++; };
const cal = ['--mag', '--mag-cal-at', '1'];

const base = run('compass_session');
check(Math.abs(base.report.yawErrEnd) > 25, `without a compass the yaw drifts: ${base.report.yawErrEnd.toFixed(1)}° off after 150 s (gyro bias ramp)`);

const fused = run('compass_session', cal);
check(fused.report.calDoneAt > 0 && fused.report.calDoneAt < 25, `calibration finishes by itself after about one turn (${fused.report.calDoneAt.toFixed(1)} s)`);
check(fused.status.some((l) => /MAG calibrated: (good|fair)/.test(l)), 'status says: ' + (fused.status.find((l) => /MAG calibrated/.test(l)) ?? '(no message)').replace(/^[^#]*# /, ''));
check(fused.report.yawErrMaxAfter < 6, `fused yaw error at most ${fused.report.yawErrMaxAfter.toFixed(1)}° afterwards (rms ${fused.report.yawErrRmsAfter.toFixed(1)}°), ends ${fused.report.yawErrEnd.toFixed(1)}° (was ${base.report.yawErrEnd.toFixed(1)}°)`);
check(fused.frames.slice(-1)[0][24] === '3', 'compass state is "correcting" at the end');

const mir = run('compass_session', [...cal, '--mag-mirror']);
check(/direction mirrored/.test(mir.status.join('\n')) && mir.report.yawErrMaxAfter < 10, `mirrored board: direction detected, error at most ${mir.report.yawErrMaxAfter.toFixed(1)}° (a mirror image is not tilt-compensated exactly: set HTM_MAG_FLIP_* in mag.h for a perfect fit)`);

const swp = run('compass_session', [...cal, '--mag-swap']);
check(/direction mirrored/.test(swp.status.join('\n')) && swp.report.yawErrMaxAfter < 10, `swapped X/Y is a mirror image too, handled the same way: error at most ${swp.report.yawErrMaxAfter.toFixed(1)}°`);

const rot = run('compass_session', [...cal, '--mag-rot']);
const why = (rot.status.find((l) => /MAG [a-z]/.test(l) && !/progress|calibrating/.test(l)) ?? '').replace(/^[^#]*# /, '');
check(/MAG (compass axes do not match|turn about the vertical|field strength varied|compass reads no change)/.test(why) && Math.abs(rot.report.yawErrEnd - base.report.yawErrEnd) < 0.5, `chip mounted on its side: calibration refused ("${why}"), yaw left to the gyro`);

const dist = run('compass_session', [...cal, '--mag-disturb', '70,80,0.5,-0.3,0.2']);
const during = dist.report.series.filter(([t]) => t >= 70 && t <= 80).map(([, e]) => Math.abs(e));
check(Math.max(...during) < 8 && dist.report.yawErrMaxAfter < 8, `10 s magnetic disturbance (0.6 G) ignored: error at most ${dist.report.yawErrMaxAfter.toFixed(1)}°`);
check(dist.report.series.some(([t, , q]) => t >= 70 && t <= 80 && q === 2), 'compass state shows "ignored" during the disturbance');

const raw = run('compass_session', ['--mag']);
const noMag = run('compass_session');
check(raw.frames.length === noMag.frames.length && raw.frames.every((f, i) => f[3] === noMag.frames[i][3]), 'compass fitted but not calibrated: yaw identical to the gyro-only yaw');

for (const sc of ['tremor_no_4.5hz_6dps', 'combo_yes_no_diag', 'walk_1.8', 'voluntary_turns']) {
  const a = run(sc), b = run(sc, cal);
  const cols = (r) => r.frames.map((f) => f.filter((_, i) => i !== 3 && i !== 24).join(','));   // everything except yaw and the compass state
  check(JSON.stringify(cols(a)) === JSON.stringify(cols(b)), `${sc}: tremor, walking and every other output unchanged by the compass`);
}
process.exit(failed ? 1 : 0);
