// Shaking on several axes at once (e.g. "yes-yes" and "no-no" together).
// The firmware says WHICH axes are shaking (the `axes` mask); this module works out HOW they relate,
// from the band-passed gyro signals the firmware streams at 50 Hz (fPitch, fRoll, fYaw):
//   - diagonal    : same frequency, in step (or in opposition): the head moves along one slanted line
//   - circular    : same frequency, about a quarter cycle apart: the head traces a circle or ellipse
//   - independent : clearly different frequencies: two separate rhythms at once
//   - mixed       : same frequency but no stable phase relation
// Pure and unit-tested (multiaxis.test.ts). Thresholds: config/thresholds.ts (MULTIAXIS).
import { MULTIAXIS } from '../config/thresholds';
import { axesOf, type Axis } from './csv';

export type ComboPattern = 'single' | 'diagonal' | 'circular' | 'independent' | 'mixed';

export interface ComboResult {
  axes: Axis[];                 // axes reported shaking
  pair: [Axis, Axis] | null;    // the two strongest, analysed against each other
  pattern: ComboPattern;
  freqHz: [number, number, number];   // per-axis frequency from zero crossings (0 = not measurable)
  rmsDps: [number, number, number];
  phaseDeg: number | null;      // phase of the second axis relative to the first, -180..180
  coherence: number;            // 0..1, how stable the phase relation is
}

/** Frequency from the mean interval between rising zero crossings (with interpolation). */
export function zeroCrossFreq(x: ArrayLike<number>, fs: number): number {
  const t: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const d = x[i] - x[i - 1];
      t.push(i - 1 + (d > 0 ? -x[i - 1] / d : 0.5));
    }
  }
  if (t.length < 3) return 0;
  return fs / ((t[t.length - 1] - t[0]) / (t.length - 1));
}

const rms = (x: ArrayLike<number>) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); };

/** Normalised correlation of a[i] with b[i + lag]. */
function corr(a: ArrayLike<number>, b: ArrayLike<number>, lag: number): number {
  let s = 0, sa = 0, sb = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
    const x = a[i], y = b[i + lag];
    s += x * y; sa += x * x; sb += y * y;
  }
  const d = Math.sqrt(sa * sb);
  return d > 1e-9 ? s / d : 0;
}

/**
 * @param sig  band-passed rate signals [pitch, roll, yaw], oldest first, same length (about 1.5 s)
 * @param mask axes reported shaking by the firmware
 * @param fs   sample rate of the signals (50 Hz on the live stream)
 */
export function analyzeCombined(sig: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>], mask: number, fs = 50): ComboResult {
  const axes = axesOf(mask);
  const freqHz = sig.map((x) => zeroCrossFreq(x, fs)) as [number, number, number];
  const rmsDps = sig.map(rms) as [number, number, number];
  const base: ComboResult = { axes, pair: null, pattern: 'single', freqHz, rmsDps, phaseDeg: null, coherence: 0 };
  if (axes.length < 2) return base;
  const [a, b] = [...axes].sort((p, q) => rmsDps[q] - rmsDps[p]).slice(0, 2).sort() as [Axis, Axis];
  const fa = freqHz[a], fb = freqHz[b];
  const res: ComboResult = { ...base, pair: [a, b] };
  if (fa > 0 && fb > 0 && Math.abs(fa - fb) > Math.max(MULTIAXIS.independentMinHz, MULTIAXIS.independentRel * Math.max(fa, fb))) {
    return { ...res, pattern: 'independent' };
  }
  const f = fa > 0 && fb > 0 ? (fa + fb) / 2 : Math.max(fa, fb);
  if (!(f > 0)) return { ...res, pattern: 'mixed' };
  // phase from the in-phase and quarter-period correlations: for two sinusoids c0 = cos(phi), cq = sin(phi)
  const q = fs / (4 * f);
  const lag = Math.round(q);
  const c0 = corr(sig[a], sig[b], 0);
  const cq = (corr(sig[a], sig[b], -lag) - corr(sig[a], sig[b], lag)) / 2;
  const coherence = Math.min(1, Math.hypot(c0, cq));
  const phaseDeg = (Math.atan2(cq, c0) * 180) / Math.PI;
  let pattern: ComboPattern = 'mixed';
  if (coherence >= MULTIAXIS.minCoherence) {
    const ph = Math.abs(phaseDeg);
    if (ph <= MULTIAXIS.diagonalMaxDeg || ph >= 180 - MULTIAXIS.diagonalMaxDeg) pattern = 'diagonal';
    else if (Math.abs(ph - 90) <= MULTIAXIS.circularTolDeg) pattern = 'circular';
  }
  return { ...res, pattern, phaseDeg, coherence };
}

export const PATTERN_LABEL: Record<ComboPattern, string> = {
  single: 'one axis',
  diagonal: 'diagonal (both together, in step)',
  circular: 'circular (a quarter cycle apart)',
  independent: 'two separate rhythms',
  mixed: 'together, no fixed timing',
};
