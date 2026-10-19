#!/usr/bin/env node
// Runs a host-simulator scenario with the CURRENT firmware and writes a replayable recording
// (app/src/logic/recording.ts format, gzipped) for the app's "Replay" option.
//   node tools/hostsim/make-recording.mjs [scenario=showcase] [out=app/public/demo/showcase.rec.gz]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const scenario = process.argv[2] ?? 'showcase';
const out = resolve(root, process.argv[3] ?? 'app/public/demo/showcase.rec.gz');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = join(here, 'bin', `sim_current${exe}`);
mkdirSync(join(here, 'bin'), { recursive: true });
execFileSync('g++', ['-O2', '-std=c++17', '-I' + join(here, 'mock'), `-DSKETCH="${join(root, 'firmware/tremor_monitor/tremor_monitor.ino').split('\\').join('/')}"`, join(here, 'sim.cpp'), '-o', bin], { stdio: 'inherit' });
const tmp = join(os.tmpdir(), `htm-rec-${process.pid}.csv`);
execFileSync(bin, ['--scenario', scenario, '--seed', '1', '--csv', tmp]);
const rows = readFileSync(tmp, 'utf8').trim().split('\n');
rmSync(tmp);
const lines = [`#REC v1 start=2026-01-01T00:00:00.000Z source=hostsim:${scenario}`];
for (const r of rows) {
  const i = r.indexOf(',');
  const ms = Math.round(Number(r.slice(0, i)) * 1000);
  lines.push(`${ms}\t${r.slice(i + 1)}`);
}
const text = lines.join('\n') + '\n';
mkdirSync(dirname(out), { recursive: true });
const gz = gzipSync(text, { level: 9 });
writeFileSync(out, gz);
console.log(`${rows.length} lines, ${(text.length / 1024).toFixed(0)} KB -> ${(gz.length / 1024).toFixed(0)} KB gz: ${out}`);
