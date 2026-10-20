// Small, dependency-free statistics for the Insights screen. Deterministic (seeded) bootstrap so the
// same data always gives the same interval.

export const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
export function quantile(x: number[], q: number): number {
  if (!x.length) return NaN;
  const s = [...x].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (x: number[]) => quantile(x, 0.5);
export function sd(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

export interface Interval { estimate: number; lo: number; hi: number; level: number }

/** Bootstrap percentile interval for mean(a) - mean(b) (two independent samples). */
export function bootstrapDiff(a: number[], b: number[], level = 0.95, iterations = 2000, seed = 7): Interval {
  const r = rng(seed);
  const pick = (x: number[]) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[Math.floor(r() * x.length)]; return s / x.length; };
  const d: number[] = [];
  for (let k = 0; k < iterations; k++) d.push(pick(a) - pick(b));
  const alpha = 1 - level;
  return { estimate: mean(a) - mean(b), lo: quantile(d, alpha / 2), hi: quantile(d, 1 - alpha / 2), level };
}

/** Bootstrap percentile interval for the mean of paired differences. */
export function bootstrapMean(x: number[], level = 0.95, iterations = 2000, seed = 11): Interval {
  const r = rng(seed);
  const d: number[] = [];
  for (let k = 0; k < iterations; k++) { let s = 0; for (let i = 0; i < x.length; i++) s += x[Math.floor(r() * x.length)]; d.push(s / x.length); }
  const alpha = 1 - level;
  return { estimate: mean(x), lo: quantile(d, alpha / 2), hi: quantile(d, 1 - alpha / 2), level };
}

/** Standardised difference (Hedges' g) for two independent samples. */
export function hedgesG(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return NaN;
  const sp = Math.sqrt(((a.length - 1) * sd(a) ** 2 + (b.length - 1) * sd(b) ** 2) / (a.length + b.length - 2));
  if (!(sp > 0)) return 0;
  const j = 1 - 3 / (4 * (a.length + b.length) - 9);
  return ((mean(a) - mean(b)) / sp) * j;
}

/** Bonferroni-corrected confidence level when m comparisons are shown together. */
export const correctedLevel = (m: number, alpha = 0.05) => 1 - alpha / Math.max(1, m);

export type Verdict = 'not-enough-data' | 'no-clear-difference' | 'higher' | 'lower';
export function verdictOf(iv: Interval | null, enough: boolean): Verdict {
  if (!enough || !iv) return 'not-enough-data';
  if (iv.lo > 0) return 'higher';
  if (iv.hi < 0) return 'lower';
  return 'no-clear-difference';
}
