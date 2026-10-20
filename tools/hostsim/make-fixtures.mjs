#!/usr/bin/env node
// Writes real firmware output (current sketch in the host simulator) for selected scenarios as
// gzipped recordings, used as test fixtures by the app (fall detection, posture, resting vitals).
//   node tools/hostsim/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = join(root, 'app/src/logic/__fixtures__');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = join(here, 'bin', `sim_current${exe}`);
const SCENARIOS = ['fall', 'fall_trip', 'headset_dropped', 'sit_down_hard', 'jump_while_walking', 'voluntary_turns', 'walk_2.8', 'combo_yes_no_diag', 'combo_yes_no_circ', 'combo_two_freq', 'crosstalk_no_15deg'];

mkdirSync(join(here, 'bin'), { recursive: true });
mkdirSync(outDir, { recursive: true });
execFileSync('g++', ['-O2', '-std=c++17', '-I' + join(here, 'mock'), `-DSKETCH="${join(root, 'firmware/tremor_monitor/tremor_monitor.ino').replaceAll(String.fromCharCode(92), '/')}"`, join(here, 'sim.cpp'), '-o', bin], { stdio: 'inherit' });
for (const sc of SCENARIOS) {
  const tmp = join(os.tmpdir(), `htm-fx-${process.pid}-${sc}.csv`);
  execFileSync(bin, ['--scenario', sc, '--seed', '1', '--csv', tmp]);
  const rows = readFileSync(tmp, 'utf8').trim().split('\n');
  rmSync(tmp);
  const lines = [`#REC v1 start=2026-01-01T00:00:00.000Z source=hostsim:${sc}`];
  for (const r of rows) { const i = r.indexOf(','); lines.push(`${Math.round(Number(r.slice(0, i)) * 1000)}\t${r.slice(i + 1)}`); }
  const gz = gzipSync(lines.join('\n') + '\n', { level: 9 });
  writeFileSync(join(outDir, `${sc}.rec.gz`), gz);
  console.log(`${sc}: ${rows.length} lines, ${(gz.length / 1024).toFixed(0)} KB`);
}
