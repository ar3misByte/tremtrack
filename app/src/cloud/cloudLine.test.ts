import { describe, expect, it } from 'vitest';
import { parseLine } from '../logic/csv';
import { validateTelemetry, type Telemetry } from '../logic/protocol';
import { telemetryToLine } from './cloudLine';

const base: Telemetry = { v: 1, seq: 1, ts: 1_800_000_000_000, per: 5, p: -3.1, r: 1.4, y: 12, tr: 1, ax: 4, dir: 2, f: 4.6, a: 7.9, sev: 3.2, wk: 0, hr: 74, sp: 97, ppg: 3, pf: null, pt: null, st: 'normal', rssi: -61, bat: null };

describe('telemetry -> live line', () => {
  it('round-trips through the line parser into a frame the live view understands', () => {
    expect(validateTelemetry(base).ok).toBe(true);
    const p = parseLine(telemetryToLine(base));
    expect(p?.kind).toBe('frame');
    if (p?.kind !== 'frame') return;
    const f = p.frame;
    expect(f).toMatchObject({ pitch: -3.1, roll: 1.4, yaw: 12, tremor: true, dir: 2, freq: 4.6, walking: false, bpm: 74, spo2: 97, ppgState: 3, axes: 4 });
    expect(f.ampY).toBeCloseTo(7.9);
    expect(f.ampP).toBe(0);
    expect(f.nValues).toBe(23);
  });

  it('shows walking, no tremor and missing vitals', () => {
    const p = parseLine(telemetryToLine({ ...base, tr: 0, ax: 0, a: 0, f: 0, wk: 1, hr: null, sp: null, ppg: 1, dir: 0 }));
    if (p?.kind !== 'frame') throw new Error('frame expected');
    expect(p.frame).toMatchObject({ tremor: false, walking: true, bpm: 0, spo2: 0, ppgState: 1, axes: 0 });
  });

  it('keeps several shaking axes', () => {
    const p = parseLine(telemetryToLine({ ...base, ax: 5, dir: 0 }));
    if (p?.kind !== 'frame') throw new Error('frame expected');
    expect(p.frame.axes).toBe(5);
  });
});
