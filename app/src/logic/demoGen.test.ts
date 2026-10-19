import { describe, expect, it } from 'vitest';
import { parseLine, type Frame } from './csv';
import { DEFAULT_CONTROLS, DemoGenerator, scriptAt, SHOWCASE } from './demoGen';

function run(seconds: number, controlsAt: (t: number) => typeof DEFAULT_CONTROLS): Frame[] {
  const g = new DemoGenerator();
  const out: Frame[] = [];
  for (let i = 0; i <= seconds * 50; i++) {
    const t = i / 50;
    const p = parseLine(g.next(t, controlsAt(t)));
    if (p?.kind !== 'frame') throw new Error('demo line did not parse');
    out.push(p.frame);
  }
  return out;
}

describe('DemoGenerator', () => {
  it('emits full 20-value lines that parse', () => {
    const f = run(1, () => DEFAULT_CONTROLS);
    expect(f.every((x) => x.nValues === 20)).toBe(true);
  });

  it('raises the tremor flag only after the firmware-like delay and drops it after release', () => {
    const f = run(10, (t) => ({ ...DEFAULT_CONTROLS, tremorAxis: t >= 2 && t < 6 ? 2 : null }));
    const at = (t: number) => f[Math.round(t * 50)];
    expect(at(3.0).tremor).toBe(false);           // 1.0 s after onset
    expect(at(4.0).tremor).toBe(true);            // 2.0 s after onset
    expect(at(4.0).dir).toBe(2);
    expect(at(6.2).tremor).toBe(true);            // within the 0.5 s release
    expect(at(7.0).tremor).toBe(false);
  });

  it('reports measuring, then a valid reading after the finger returns', () => {
    const f = run(20, (t) => ({ ...DEFAULT_CONTROLS, finger: t < 2 || t >= 5 }));
    expect(f[150].ppgState).toBe(1);              // 3 s: no finger
    expect(f[300].ppgState).toBe(2);              // 6 s: measuring
    expect(f[900].ppgState).toBe(3);              // 18 s: valid
    expect(f[900].bpm).toBeGreaterThan(60);
  });
});

describe('scriptAt', () => {
  it('accumulates steps and loops', () => {
    expect(scriptAt(12).controls.tremorAxis).toBe(2);
    expect(scriptAt(40).controls).toMatchObject({ tremorAxis: null, walking: true });
    expect(scriptAt(SHOWCASE.length + 12).controls.tremorAxis).toBe(2);
    expect(scriptAt(85).controls.finger).toBe(false);
  });
});
