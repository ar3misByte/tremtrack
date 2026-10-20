import { describe, expect, it } from 'vitest';
import type { Frame } from './csv';
import { deviation, motionState, PoseCalibrator, PosturePrompter, zoneOf } from './posture';
import { RestingTracker, summarizeVitals, vitalsFlags, type RestingReading } from './vitals';
import type { Sample } from './model';
import { DEFAULT_MAPPING } from './orientation';

const f = (pitch: number, roll = 0, extra: Partial<Frame> = {}) => ({ pitch, roll, yaw: 0, walking: false, tremor: false, ...extra }) as Frame;

describe('PoseCalibrator', () => {
  it('returns the mean pose after holding still for 3 s', () => {
    const c = new PoseCalibrator();
    let r: ReturnType<PoseCalibrator['push']> = { state: 'collecting', progress: 0 };
    for (let i = 0; i <= 160; i++) r = c.push(f(5 + 0.2 * Math.sin(i), -3), i * 20);
    expect(r.state).toBe('done');
    if (r.state === 'done') { expect(r.pose.pitch).toBeCloseTo(5, 0); expect(r.pose.roll).toBeCloseTo(-3, 6); }
  });
  it('fails if the head moves, walks or shakes', () => {
    const c = new PoseCalibrator();
    let r: ReturnType<PoseCalibrator['push']> = { state: 'collecting', progress: 0 };
    for (let i = 0; i <= 160; i++) r = c.push(f(i * 0.1), i * 20);
    expect(r.state).toBe('failed');
    expect(new PoseCalibrator().push(f(0, 0, { walking: true }), 0).state).toBe('failed');
  });
});

describe('deviation and zones', () => {
  const neutral = { pitch: 5, roll: 0, t: 0 };
  it('forward is chin down relative to neutral', () => {
    expect(deviation(-15, 0, neutral).forward).toBeCloseTo(20);
    expect(zoneOf(deviation(-15, 0, neutral))).toBe('forward');
    expect(zoneOf(deviation(30, 0, neutral))).toBe('back');
    expect(zoneOf(deviation(5, 14, neutral))).toBe('tilt');
    expect(zoneOf(deviation(0, 5, neutral))).toBe('ok');
  });
  it('follows the axis mapping', () => {
    expect(deviation(-15, 0, neutral, { ...DEFAULT_MAPPING, flipPitch: true }).forward).toBeCloseTo(-10);
  });
});

describe('motionState', () => {
  it('classifies seconds', () => {
    expect(motionState({ motionDeg: 0.2, walkingFrac: 0 })).toBe('still');
    expect(motionState({ motionDeg: 1, walkingFrac: 0 })).toBe('normal');
    expect(motionState({ motionDeg: 3, walkingFrac: 0 })).toBe('restless');
    expect(motionState({ motionDeg: 3, walkingFrac: 1 })).toBe('walking');
  });
});

describe('PosturePrompter', () => {
  it('prompts after about 2 minutes mostly outside the range, then stays quiet', () => {
    const p = new PosturePrompter();
    const hits: [number, string][] = [];
    for (let s = 0; s < 900; s++) { const z = p.push(s * 1000, s % 10 === 0 ? 'ok' : 'forward'); if (z) hits.push([s, z]); }
    expect(hits[0][1]).toBe('forward');
    expect(hits[0][0]).toBeGreaterThanOrEqual(107);           // 108 s elapsed (0-based)
    expect(hits[0][0]).toBeLessThan(125);
    expect(hits[1][0] - hits[0][0]).toBeGreaterThanOrEqual(600);
  });
  it('does not prompt for brief or mixed deviations', () => {
    const p = new PosturePrompter();
    let hit = null;
    for (let s = 0; s < 600; s++) hit = p.push(s * 1000, s % 3 === 0 ? 'forward' : 'ok') ?? hit;
    expect(hit).toBeNull();
  });
});

const sample = (t: number, o: Partial<Sample> = {}): Sample => ({
  sessionId: 's1', t, demo: false, pitch: 0, roll: 0, yaw: 0, motionDeg: 0.2, tremorFrac: 0, ampDps: 0.3, axes: 0, freqHz: 0,
  walkingFrac: 0, bpm: 64, spo2: 97, ppgState: 3, ...o,
});

describe('RestingTracker', () => {
  it('emits readings every 30 s after 3 minutes of low motion, with quality', () => {
    const r = new RestingTracker('s1', false);
    const out: RestingReading[] = [];
    for (let s = 0; s < 300; s++) { const x = r.push(sample(s * 1000, { bpm: 62 + (s % 3) })); if (x) out.push(x); }
    expect(out.map((x) => x.restedS)).toEqual([180, 210, 240, 270, 300]);
    expect(out[0].bpm).toBeCloseTo(63, 0);
    expect(out[0].quality).toBe('good');
  });
  it('restarts the rest timer on movement, walking or tremor', () => {
    const r = new RestingTracker('s1', false);
    let n = 0;
    for (let s = 0; s < 400; s++) if (r.push(sample(s * 1000, { motionDeg: s === 150 ? 3 : 0.2, tremorFrac: s === 300 ? 1 : 0 }))) n++;
    expect(n).toBe(0);
  });
  it('marks windows with few valid readings as poor and skips windows with none', () => {
    const r = new RestingTracker('s1', false);
    const out: RestingReading[] = [];
    for (let s = 0; s < 220; s++) { const x = r.push(sample(s * 1000, s % 3 ? { ppgState: 1, bpm: null } : {})); if (x) out.push(x); }
    expect(out[0].quality).toBe('poor');
    const r2 = new RestingTracker('s1', false);
    let any = false;
    for (let s = 0; s < 220; s++) any = !!r2.push(sample(s * 1000, { ppgState: 1, bpm: null })) || any;
    expect(any).toBe(false);
  });
});

describe('summarizeVitals and flags', () => {
  const day = (d: number) => new Date(2026, 9, d, 10).getTime();
  const rd = (t: number, bpm: number, spo2: number, quality: RestingReading['quality'] = 'good'): RestingReading => ({ id: 'v' + t, sessionId: 's', t, demo: false, bpm, spo2, validShare: 1, bpmIqr: 2, motionDeg: 0.2, restedS: 200, quality });
  it('takes daily medians of usable readings', () => {
    const days = summarizeVitals([rd(day(5), 60, 97), rd(day(5) + 60000, 64, 95), rd(day(5) + 120000, 90, 80, 'poor')], day(4), day(6));
    expect(days.map((d) => d.bpm)).toEqual([null, 62, null]);
    expect(days[1].spo2).toBe(96);
  });
  it('flags repeated low SpO2 estimates with cautious wording', () => {
    const days = summarizeVitals([1, 2, 3, 4, 5, 6, 7].map((d) => rd(day(d), 70, d % 3 === 0 ? 90 : 96)), day(1), day(7));
    const flags = vitalsFlags(days);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe('low-spo2');
    expect(flags[0].text).toMatch(/not calibrated/);
    expect(flags[0].text).not.toMatch(/hypox|diagnos/i);
  });
});
