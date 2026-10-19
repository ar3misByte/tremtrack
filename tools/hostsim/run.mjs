#!/usr/bin/env node
// Builds the host simulator for the legacy sketch and the current firmware, runs every scenario
// over several seeds and sensitivity levels, and compares the current firmware with the baseline.
//
//   node tools/hostsim/run.mjs                 run + print table (current firmware vs baseline)
//   node tools/hostsim/run.mjs --write-baseline   record legacy results as tools/hostsim/baseline.json
//   node tools/hostsim/run.mjs --check         exit 1 if the current firmware regresses (used in CI)
//   node tools/hostsim/run.mjs --md docs/DETECTOR_BASELINE.md   also write a markdown report
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const SEEDS = +opt('--seeds', 5);
const SENS = opt('--sens', '1,2,3,4,5').split(',').map(Number);
const exe = process.platform === 'win32' ? '.exe' : '';
const BIN = join(here, 'bin');
mkdirSync(BIN, { recursive: true });

const SKETCHES = {
  legacy: join(root, 'legacy/tremor_stream.ino'),
  current: join(root, 'firmware/tremor_monitor/tremor_monitor.ino'),
};

function build(name, sketch) {
  const out = join(BIN, `sim_${name}${exe}`);
  const rel = sketch.replace(/\\/g, '/');
  execFileSync('g++', ['-O2', '-std=c++17', '-I' + join(here, 'mock'), `-DSKETCH="${rel}"`, join(here, 'sim.cpp'), '-o', out],
    { stdio: 'inherit' });
  return out;
}

function runOne(bin, scenario, seed, sens) {
  return new Promise((res, rej) => {
    const p = spawn(bin, ['--scenario', scenario, '--seed', String(seed), '--sens', String(sens)]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res(JSON.parse(out.trim().split('\n').pop())) : rej(new Error(err || `exit ${code}`))));
  });
}

async function runAll(bin) {
  const scenarios = execFileSync(bin, ['--list']).toString().trim().split('\n').map((l) => l.split('\t')[0].trim());
  const jobs = [];
  for (const s of scenarios) for (const sens of SENS) for (let seed = 1; seed <= SEEDS; seed++) jobs.push([s, seed, sens]);
  const results = [];
  const N = Math.max(2, os.cpus().length);
  let i = 0;
  await Promise.all(Array.from({ length: N }, async () => {
    while (i < jobs.length) { const j = jobs[i++]; results.push(await runOne(bin, ...j)); }
  }));
  return aggregate(results);
}

const mean = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
function aggregate(results) {
  const by = {};
  for (const r of results) (by[`${r.scenario}@${r.sens}`] ??= []).push(r);
  const agg = {};
  for (const [k, rs] of Object.entries(by)) {
    agg[k] = {
      scenario: rs[0].scenario, sens: rs[0].sens, runs: rs.length,
      falseAlertFrac: mean(rs.map((r) => r.falseAlertFrac)),
      falseEpisodesPerRun: mean(rs.map((r) => r.falseEpisodes)),
      recall: mean(rs.map((r) => r.recall)),
      minRecall: rs.some((r) => r.recall !== null) ? Math.min(...rs.filter((r) => r.recall !== null).map((r) => r.recall)) : null,
      axisCorrect: mean(rs.map((r) => r.axisCorrect)),
      latencyS: mean(rs.map((r) => r.latencyS)),
      freqErrHz: mean(rs.map((r) => r.freqErrHz)),
      walkDetectedFrac: mean(rs.map((r) => r.walkDetectedFrac)),
      accSaturated: mean(rs.map((r) => r.accSaturated)),
      maxAccServedG: Math.max(...rs.map((r) => r.maxAccServedG)),
      maxAccDemandG: Math.max(...rs.map((r) => r.maxAccDemandG)),
      bpmMean: mean(rs.map((r) => r.bpmMean)),
    };
  }
  return agg;
}

// Regression rules: the current firmware may not get worse than the baseline by more than these margins.
const TOL = { falseAlertFrac: 0.002, falseEpisodesPerRun: 0.2, recall: 0.02, axisCorrect: 0.02, latencyS: 0.25 };
function compare(base, cur) {
  const problems = [];
  for (const [k, b] of Object.entries(base)) {
    const c = cur[k];
    if (!c) { problems.push(`${k}: missing in current run`); continue; }
    if (c.falseAlertFrac > b.falseAlertFrac + TOL.falseAlertFrac) problems.push(`${k}: false-alert time ${pct(b.falseAlertFrac)} -> ${pct(c.falseAlertFrac)}`);
    if (c.falseEpisodesPerRun > b.falseEpisodesPerRun + TOL.falseEpisodesPerRun) problems.push(`${k}: false episodes/run ${f2(b.falseEpisodesPerRun)} -> ${f2(c.falseEpisodesPerRun)}`);
    if (b.recall !== null && (c.recall ?? 0) < b.recall - TOL.recall) problems.push(`${k}: recall ${pct(b.recall)} -> ${pct(c.recall)}`);
    if (b.axisCorrect !== null && c.axisCorrect !== null && c.axisCorrect < b.axisCorrect - TOL.axisCorrect) problems.push(`${k}: axis correct ${pct(b.axisCorrect)} -> ${pct(c.axisCorrect)}`);
    if (b.latencyS !== null && c.latencyS !== null && c.latencyS > b.latencyS + TOL.latencyS) problems.push(`${k}: latency ${f2(b.latencyS)} s -> ${f2(c.latencyS)} s`);
  }
  return problems;
}

const pct = (x) => (x === null || x === undefined ? '–' : (100 * x).toFixed(1) + ' %');
const f2 = (x) => (x === null || x === undefined ? '–' : x.toFixed(2));

function table(base, cur, sens) {
  const rows = Object.values(cur).filter((r) => r.sens === sens);
  let md = `| Scenario | False-alert time | False episodes / run | Recall (min) | Axis correct | Latency s | Freq err Hz | Walking detected | Acc served / demanded g |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const b = base?.[`${r.scenario}@${r.sens}`];
    const d = (cv, bv, fmt) => (b && fmt(bv) !== fmt(cv) ? `${fmt(cv)} (was ${fmt(bv)})` : fmt(cv));
    md += `| ${r.scenario} | ${d(r.falseAlertFrac, b?.falseAlertFrac, pct)} | ${d(r.falseEpisodesPerRun, b?.falseEpisodesPerRun, f2)} | ${r.recall === null ? '–' : `${pct(r.recall)} (${pct(r.minRecall)})`} | ${pct(r.axisCorrect)} | ${d(r.latencyS, b?.latencyS, f2)} | ${f2(r.freqErrHz)} | ${pct(r.walkDetectedFrac)} | ${f2(r.maxAccServedG)} / ${f2(r.maxAccDemandG)} |\n`;
  }
  return md;
}

const baselinePath = join(here, 'baseline.json');
if (flag('--write-baseline')) {
  const bin = build('legacy', SKETCHES.legacy);
  const res = await runAll(bin);
  writeFileSync(baselinePath, JSON.stringify({ sketch: 'legacy/tremor_stream.ino', seeds: SEEDS, sens: SENS, generated: new Date().toISOString(), results: res }, null, 1));
  console.log(`baseline written: ${Object.keys(res).length} scenario x sensitivity cells`);
  console.log(table(null, res, 2));
  process.exit(0);
}

const base = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).results : null;
const bin = build('current', SKETCHES.current);
const cur = await runAll(bin);
console.log('Current firmware, sensitivity 2 (default):\n');
console.log(table(base, cur, 2));
const md = opt('--md');
if (md) {
  let doc = `# Detector regression results (host simulator)\n\nGenerated by \`node tools/hostsim/run.mjs --md ${md}\` on ${new Date().toISOString().slice(0, 10)}.\n` +
    `${SEEDS} seeds per scenario. Values in brackets "(was …)" show the legacy baseline where it differs.\n\n` +
    `**These are synthetic signals.** They show that the code behaves as designed and catch regressions; they are not evidence of accuracy on real heads.\n\n`;
  for (const s of SENS) doc += `## Sensitivity ${s}\n\n${table(base, cur, s)}\n`;
  writeFileSync(resolve(root, md), doc);
  console.log(`wrote ${md}`);
}
if (base) {
  const problems = compare(base, cur);
  if (problems.length) {
    console.log('\nREGRESSIONS vs baseline:\n  ' + problems.join('\n  '));
    if (flag('--check')) process.exit(1);
  } else console.log('\nNo regressions vs baseline.');
} else console.log('\n(no baseline.json yet: run with --write-baseline)');
