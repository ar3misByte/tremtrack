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
  it('emits full 23-value lines that parse', () => {
    const f = run(1, () => DEFAULT_CONTROLS);
    expect(f.every((x) => x.nValues === 23)).toBe(true);
  });

  it('raises the tremor flag only after the firmware-like delay and drops it after release', () => {
    const f = run(10, (t) => ({ ...DEFAULT_CONTROLS, tremorAxes: t >= 2 && t < 6 ? [2] : [] }));
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

  it('reports every shaking axis in the mask for a combined tremor', () => {
    const f = run(5, () => ({ ...DEFAULT_CONTROLS, tremorAxes: [2, 0] }));
    expect(f[200].tremor).toBe(true);
    expect(f[200].axes).toBe(5);
    expect(f[200].dir).toBe(2);
    expect(f[20].axes).toBe(0);                    // before the detection delay
  });

  it('a fall gives a free-fall dip, an impact spike, then lying still', () => {
    const f = run(6, (t) => ({ ...DEFAULT_CONTROLS, fall: t >= 2 }));
    const after = f.slice(100);
    expect(Math.min(...after.map((x) => x.aMin!))).toBeLessThan(0.2);
    expect(Math.max(...after.map((x) => x.aMax!))).toBeGreaterThan(5);
    expect(f[290].pitch).toBeGreaterThan(70);
  });
});

describe('scriptAt', () => {
  it('accumulates steps and loops', () => {
    expect(scriptAt(12).controls.tremorAxes).toEqual([2]);
    expect(scriptAt(40).controls).toMatchObject({ tremorAxes: [], walking: true });
    expect(scriptAt(SHOWCASE.length + 12).controls.tremorAxes).toEqual([2]);
    expect(scriptAt(108).controls.finger).toBe(false);
    expect(scriptAt(60).controls.tremorAxes).toEqual([2, 0]);
    expect(scriptAt(130).controls.fall).toBe(true);
  });
});
