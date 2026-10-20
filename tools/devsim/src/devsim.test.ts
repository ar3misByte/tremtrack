import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, startSource } from './devsim.ts';
import { parseLine } from '../../../app/src/logic/csv.ts';

test('parseArgs defaults to WebSocket on 8787 with the showcase script', () => {
  const o = parseArgs([]);
  assert.equal(o.ws, true);
  assert.equal(o.port, 8787);
  assert.equal(o.script, 'showcase');
});

test('--tremor switches to manual controls', () => {
  const o = parseArgs(['--stdout', '--tremor', '2']);
  assert.equal(o.script, 'manual');
  assert.deepEqual(o.tremor, [2]);
  assert.equal(o.ws, false);
});

test('the simulated stream parses and raises a tremor flag in manual tremor mode', async () => {
  const lines: string[] = [];
  const stop = startSource(parseArgs(['--stdout', '--tremor', '0', '--quiet']), (l) => lines.push(l), () => {});
  await new Promise((r) => setTimeout(r, 2600));
  stop();
  const frames = lines.map(parseLine).filter((p) => p?.kind === 'frame');
  assert.ok(frames.length > 60, `expected ~120 frames, got ${frames.length}`);
  const statuses = lines.map(parseLine).filter((p) => p?.kind === 'status');
  assert.ok(statuses.length >= 1);
  const last = frames.at(-1);
  assert.ok(last?.kind === 'frame' && last.frame.tremor && last.frame.dir === 0);
});
