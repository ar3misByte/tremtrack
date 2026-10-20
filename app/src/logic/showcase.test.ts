// The whole tracker (episodes, combined axes, posture, falls) run over the bundled showcase recording,
// which is REAL firmware output from the host simulator (tools/hostsim, scenario "showcase").
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseLine } from './csv';
import { parseRecording } from './recording';
import { SessionTracker, type TrackerEvent } from './tracker';
import type { Episode } from './model';

const rec = parseRecording(gunzipSync(readFileSync(new URL('../../public/demo/showcase.rec.gz', import.meta.url))).toString('utf8'));
const scene = (t: number) => (t - rec.start) / 1000 - 5;

function runShowcase() {
  const tr = new SessionTracker('replay', rec.start, 2);
  const ev: TrackerEvent[] = [];
  for (const [ms, line] of rec.entries) {
    const p = parseLine(line);
    if (p?.kind === 'frame') ev.push(...tr.push(p.frame, rec.start + ms));
  }
  ev.push(...tr.close());
  return { tr, ev };
}

describe('showcase recording through the tracker', () => {
  const { tr, ev } = runShowcase();
  const episodes = ev.filter((e) => e.type === 'episode').map((e) => (e as { episode: Episode }).episode);

  it('finds the single-axis and the combined episode', () => {
    expect(episodes).toHaveLength(2);
    expect(episodes[0].axes).toEqual([2]);
    expect(episodes[1].axes).toEqual([0, 2]);
    expect(episodes[1].pattern).toBe('diagonal');
    expect(episodes[1].ampDps).toBeGreaterThan(episodes[1].ampByAxis![2]);
  });

  it('flags the fall once, at the impact', () => {
    const falls = ev.filter((e) => e.type === 'fall');
    expect(falls).toHaveLength(1);
    if (falls[0].type === 'fall') expect(scene(falls[0].candidate.t)).toBeCloseTo(112.35, 0);
    expect(tr.fallSupported).toBe(true);
  });

  it('counts stillness and walking', () => {
    expect(tr.session.stillS).toBeGreaterThan(20);
    expect(tr.session.walkingS).toBeGreaterThan(15);
  });
});
