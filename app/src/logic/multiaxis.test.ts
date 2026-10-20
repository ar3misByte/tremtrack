import { describe, expect, it } from 'vitest';
import { analyzeCombined, zeroCrossFreq } from './multiaxis';

const FS = 50, N = 75;   // 1.5 s at 50 Hz, as on the live stream
function sine(f: number, amp: number, ph = 0, noise = 0, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return Float64Array.from({ length: N }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / FS + ph) + noise * rnd());
}
const zero = new Float64Array(N);

describe('zeroCrossFreq', () => {
  it('measures the frequency of a sinusoid', () => {
    expect(zeroCrossFreq(sine(5, 10), FS)).toBeCloseTo(5, 1);
    expect(zeroCrossFreq(sine(4.2, 3, 1), FS)).toBeCloseTo(4.2, 1);
    expect(zeroCrossFreq(zero, FS)).toBe(0);
  });
});

describe('analyzeCombined', () => {
  it('single axis', () => {
    expect(analyzeCombined([zero, zero, sine(5, 10)], 4).pattern).toBe('single');
  });

  it('diagonal: yes-yes and no-no in step, or in opposition', () => {
    const r = analyzeCombined([sine(5, 10), zero, sine(5, 10)], 5);
    expect(r.pattern).toBe('diagonal');
    expect(r.pair).toEqual([0, 2]);
    expect(Math.abs(r.phaseDeg!)).toBeLessThan(15);
    const opp = analyzeCombined([sine(5, 10), zero, sine(5, 8, Math.PI)], 5);
    expect(opp.pattern).toBe('diagonal');
    expect(Math.abs(opp.phaseDeg!)).toBeGreaterThan(165);
  });

  it('circular: a quarter cycle apart, either direction', () => {
    expect(analyzeCombined([sine(5, 10), zero, sine(5, 10, Math.PI / 2)], 5).pattern).toBe('circular');
    expect(analyzeCombined([sine(5.5, 10), zero, sine(5.5, 6, -Math.PI / 2)], 5).pattern).toBe('circular');
  });

  it('independent: clearly different frequencies', () => {
    const r = analyzeCombined([sine(4.4, 8), zero, sine(5.8, 10)], 5);
    expect(r.pattern).toBe('independent');
    expect(r.freqHz[0]).toBeCloseTo(4.4, 0);
    expect(r.freqHz[2]).toBeCloseTo(5.8, 0);
  });

  it('robust to moderate noise', () => {
    expect(analyzeCombined([sine(5, 10, 0, 2, 3), zero, sine(5, 10, 0.1, 2, 9)], 5).pattern).toBe('diagonal');
    expect(analyzeCombined([sine(5, 10, 0, 2, 3), zero, sine(5, 10, Math.PI / 2, 2, 9)], 5).pattern).toBe('circular');
  });

  it('analyses the two strongest axes when all three are reported', () => {
    const r = analyzeCombined([sine(5, 10), sine(5, 1, 1), sine(5, 9, Math.PI / 2)], 7);
    expect(r.pair).toEqual([0, 2]);
    expect(r.pattern).toBe('circular');
  });
});
