import { describe, expect, it } from 'vitest';
import type { Frame } from './csv';
import { SessionTracker, type TrackerEvent } from './tracker';
import type { Episode, Sample } from './model';

const base: Frame = {
  pitch: 0, roll: 0, yaw: 0, fPitch: 0, fRoll: 0, fYaw: 0, tremor: false, dir: 0, ampP: 0.3, ampR: 0.3, ampY: 0.3, freq: 0, q: 0.2,
  walking: false, stepHz: 0, cycles: 0, bpm: 72, spo2: 97, ppgState: 3, pulse: 0, nValues: 20, extra: [],
};
const T0 = Date.UTC(2026, 9, 20, 8, 0, 0);

/** Runs a timeline at 50 Hz; `at(sec)` returns the frame overrides for that time. */
function run(seconds: number, at: (s: number) => Partial<Frame>, source: 'serial' | 'demo' = 'serial') {
  const tr = new SessionTracker(source, T0, 2);
  const ev: TrackerEvent[] = [];
  for (let i = 0; i < seconds * 50; i++) ev.push(...tr.push({ ...base, ...at(i / 50) }, T0 + i * 20));
  ev.push(...tr.close());
  return {
    tr,
    episodes: ev.filter((e) => e.type === 'episode').map((e) => (e as { episode: Episode }).episode),
    samples: ev.filter((e) => e.type === 'sample').map((e) => (e as { sample: Sample }).sample),
  };
}

const tremorYaw = (on: boolean): Partial<Frame> => (on ? { tremor: true, dir: 2, ampY: 12, freq: 5, q: 0.8, cycles: 7, bpm: 80 } : {});

describe('SessionTracker episodes', () => {
  it('records one episode with its statistics and score', () => {
    const { episodes, tr } = run(30, (s) => tremorYaw(s >= 5 && s < 15));
    expect(episodes).toHaveLength(1);
    const e = episodes[0];
    expect(e.axis).toBe(2);
    expect(e.durationS).toBeCloseTo(10, 1);
    expect(e.ampDps).toBeCloseTo(12, 6);
    expect(e.freqHz).toBeCloseTo(5, 6);
    expect(e.bpm).toBeCloseTo(80, 6);
    expect(e.displacementDeg).toBeCloseTo(12 / (2 * Math.PI * 5), 6);
    expect(e.score).toBeGreaterThan(0);
    expect(e.start).toBe(T0 + 5000);
    expect(tr.session.episodes).toBe(1);
    expect(tr.session.tremorS).toBeCloseTo(10, 1);
  });

  it('merges alerts separated by less than the merge gap, splits longer gaps', () => {
    const merged = run(30, (s) => tremorYaw((s >= 2 && s < 6) || (s >= 8 && s < 12)));
    expect(merged.episodes).toHaveLength(1);
    expect(merged.episodes[0].durationS).toBeCloseTo(10, 1);
    const split = run(30, (s) => tremorYaw((s >= 2 && s < 6) || (s >= 10 && s < 14)));
    expect(split.episodes).toHaveLength(2);
  });

  it('drops blips shorter than the minimum duration', () => {
    expect(run(10, (s) => tremorYaw(s >= 2 && s < 2.5)).episodes).toHaveLength(0);
  });

  it('closes an episode still open at disconnect', () => {
    const { episodes } = run(10, (s) => tremorYaw(s >= 6));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].durationS).toBeCloseTo(4, 1);
  });

  it('takes the dominant axis by time and reports shares', () => {
    const { episodes } = run(20, (s) => (s >= 2 && s < 12 ? { tremor: true, dir: s < 5 ? 0 : 2, ampP: 8, ampY: 8, freq: 5 } : {}));
    expect(episodes[0].axis).toBe(2);
    expect(episodes[0].axisShare[0]).toBeCloseTo(0.3, 1);
  });

  it('flags demo sources', () => {
    expect(run(10, (s) => tremorYaw(s > 1 && s < 5), 'demo').episodes[0].demo).toBe(true);
  });
});

describe('SessionTracker session and samples', () => {
  it('counts monitored time, ignoring gaps over 1 s', () => {
    const tr = new SessionTracker('serial', T0, 2);
    for (let i = 0; i < 500; i++) tr.push(base, T0 + i * 20);          // 10 s
    for (let i = 0; i < 500; i++) tr.push(base, T0 + 60000 + i * 20);  // 50 s gap, then 10 s
    expect(tr.session.monitoredS).toBeCloseTo(19.96, 1);
  });

  it('emits one sample per second with stillness and vitals', () => {
    const { samples } = run(5, (s) => ({ pitch: Math.floor(s) === 2 ? 10 * Math.sin(s * 40) : 0 }));
    expect(samples).toHaveLength(5);
    expect(samples[0].motionDeg).toBeCloseTo(0, 6);
    expect(samples[2].motionDeg).toBeGreaterThan(3);
    expect(samples[0].bpm).toBe(72);
    expect(samples[0].ppgState).toBe(3);
  });

  it('counts walking time', () => {
    const { tr } = run(10, (s) => ({ walking: s >= 5 }));
    expect(tr.session.walkingS).toBeCloseTo(5, 1);
  });
});
