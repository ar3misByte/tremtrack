// Fall / sudden-impact CANDIDATE detection from the firmware's per-line |a| extremes (aMax, aMin) and
// orientation. Rules (thresholds in config/thresholds.ts, FALL):
//   A. free fall (|a| < 0.5 g for >= 0.1 s), then an impact (> 2.5 g) within 1 s, or
//   B. a hard impact (> 4 g) without free fall (trips, slips),
//   then the head stays still for 2 s (checked from 0.5 s after the impact).
// This is a HEURISTIC. It will miss falls (slow slumps, soft landings) and raise false alarms. A
// head-worn sensor cannot tell a fall from the headset being dropped on a table.
import { FALL } from '../config/thresholds';
import type { Frame } from './csv';

export type FallConfig = typeof FALL;
export interface FallCandidate {
  t: number;                      // impact time (ms)
  path: 'freefall+impact' | 'impact';
  peakG: number;
  freeFallMs: number;
  orientationChangeDeg: number;   // largest pitch/roll change from before the fall to after it
  stillShare: number;
}

interface Pending {
  t: number; peak: number; path: FallCandidate['path']; ffMs: number;
  pre: { p: number; r: number } | null; n: number; still: number; ps: number[]; rs: number[];
}

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const spread = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };

export class FallDetector {
  private ffStart: number | null = null;
  private lastFF: { end: number; ms: number } | null = null;
  private pending: Pending | null = null;
  private cooldownUntil = 0;
  private hist: { t: number; p: number; r: number }[] = [];
  /** True once frames carry aMax / aMin (firmware with the +/-8 g build). */
  supported = false;
  constructor(private readonly c: FallConfig = FALL) {}

  push(f: Frame, t: number): FallCandidate | null {
    if (f.aMax === null || f.aMin === null) return null;
    this.supported = true;
    const c = this.c;
    this.hist.push({ t, p: f.pitch, r: f.roll });
    while (this.hist.length && this.hist[0].t < t - 3000) this.hist.shift();

    // free fall
    if (f.aMin < c.freeFallG) { if (this.ffStart === null) this.ffStart = t; }
    else if (this.ffStart !== null) {
      const ms = t - this.ffStart;
      if (ms >= c.freeFallMinS * 1000) this.lastFF = { end: t, ms };
      this.ffStart = null;
    }

    // impact
    if (!this.pending && t >= this.cooldownUntil) {
      const afterFF = !!this.lastFF && t - this.lastFF.end <= c.impactWindowS * 1000 && f.aMax >= c.impactG;
      if (afterFF || f.aMax >= c.impactOnlyG) {
        const pre = this.hist.filter((h) => h.t >= t - 2500 && h.t <= t - 1000);
        this.pending = {
          t, peak: f.aMax, path: afterFF ? 'freefall+impact' : 'impact', ffMs: afterFF ? this.lastFF!.ms : 0,
          pre: pre.length ? { p: mean(pre.map((h) => h.p)), r: mean(pre.map((h) => h.r)) } : null,
          n: 0, still: 0, ps: [], rs: [],
        };
        this.lastFF = null;
        return null;
      }
    }

    // stillness after the impact
    const p = this.pending;
    if (!p) return null;
    const dt = t - p.t;
    if (dt < c.settleS * 1000) { p.peak = Math.max(p.peak, f.aMax); return null; }
    if (dt <= (c.settleS + c.stillWindowS) * 1000) {
      p.n++;
      if (!f.walking && f.aMax <= c.stillMaxG && f.aMin >= c.stillMinG) p.still++;   // walking never counts as still
      p.ps.push(f.pitch);
      p.rs.push(f.roll);
      return null;
    }
    this.pending = null;
    const stillShare = p.n ? p.still / p.n : 0;
    const orientSpread = Math.hypot(spread(p.ps), spread(p.rs));
    const change = p.pre ? Math.max(Math.abs(mean(p.ps) - p.pre.p), Math.abs(mean(p.rs) - p.pre.r)) : 0;
    const still = stillShare >= c.stillMinShare && orientSpread <= c.stillMaxDeg;
    const turned = !c.requireOrientationChange || change >= c.minOrientationChangeDeg;
    if (!still || !turned) return null;
    this.cooldownUntil = t + c.cooldownS * 1000;
    return { t: p.t, path: p.path, peakG: p.peak, freeFallMs: p.ffMs, orientationChangeDeg: change, stillShare };
  }
}
