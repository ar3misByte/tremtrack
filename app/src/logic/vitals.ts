// Resting heart rate and SpO2. "Resting" = low motion (no walking, no tremor alert) for at least
// RESTING.restMinS; then one reading every RESTING.readingEveryS from the valid (ppgState = 3) seconds,
// with quality metadata so bad data can be filtered out. SpO2 here is an UNCALIBRATED estimate from a
// hobby sensor. Flags are worded as observations, never a diagnosis.
import { RESTING } from '../config/thresholds';
import { dayKey, nextDay, startOfDay } from './daily';
import type { Sample } from './model';

export type RestingConfig = typeof RESTING;
export type Quality = 'good' | 'fair' | 'poor';

export interface RestingReading {
  id: string;
  sessionId: string;
  t: number;                    // end of the 30 s window
  demo: boolean;
  bpm: number;                  // median of valid seconds
  spo2: number | null;          // median of valid seconds (estimate)
  validShare: number;           // share of seconds in the window with a valid reading
  bpmIqr: number;               // spread of heart rate in the window
  motionDeg: number;            // mean orientation spread
  restedS: number;              // how long the person had been resting
  quality: Quality;
}

const median = (x: number[]) => { if (!x.length) return NaN; const s = [...x].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (x: number[], q: number) => { const s = [...x].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };

export class RestingTracker {
  private run = 0;
  private win: Sample[] = [];
  constructor(private readonly sessionId: string, private readonly demo: boolean, private readonly c: RestingConfig = RESTING) {}

  /** One call per 1 s sample. Returns a reading when one is due. */
  push(s: Sample): RestingReading | null {
    const low = s.motionDeg <= this.c.restMaxMotionDeg && s.walkingFrac === 0 && s.tremorFrac === 0;
    this.run = low ? this.run + 1 : 0;
    this.win.push(s);
    if (this.win.length > this.c.readingEveryS) this.win.shift();
    if (this.run < this.c.restMinS || (this.run - this.c.restMinS) % this.c.readingEveryS !== 0) return null;
    const valid = this.win.filter((w) => w.ppgState === 3 && w.bpm !== null && w.bpm > 0);
    if (!valid.length) return null;
    const bpms = valid.map((w) => w.bpm!);
    const spo2s = valid.map((w) => w.spo2).filter((x): x is number => x !== null && x > 0);
    const validShare = valid.length / this.win.length;
    const bpmIqr = bpms.length >= 4 ? quantile(bpms, 0.75) - quantile(bpms, 0.25) : 0;
    const quality: Quality = validShare >= this.c.goodValidShare && bpmIqr <= this.c.goodMaxSpreadBpm ? 'good' : validShare >= this.c.fairValidShare ? 'fair' : 'poor';
    return {
      id: `v_${s.t.toString(36)}_${this.sessionId.slice(-4)}`, sessionId: this.sessionId, t: s.t + 1000, demo: this.demo,
      bpm: median(bpms), spo2: spo2s.length ? median(spo2s) : null, validShare, bpmIqr,
      motionDeg: this.win.reduce((a, w) => a + w.motionDeg, 0) / this.win.length, restedS: this.run, quality,
    };
  }
}

export interface VitalsDay { day: string; dayStart: number; bpm: number | null; spo2: number | null; n: number; nGood: number }

/** Daily medians of good and fair resting readings, one row per local day (null = no usable readings). */
export function summarizeVitals(readings: RestingReading[], from: number, to: number): VitalsDay[] {
  const by = new Map<string, RestingReading[]>();
  for (const r of readings) if (r.quality !== 'poor') (by.get(dayKey(r.t)) ?? by.set(dayKey(r.t), []).get(dayKey(r.t))!).push(r);
  const out: VitalsDay[] = [];
  for (let d = startOfDay(from); d <= to; d = nextDay(d)) {
    const rs = by.get(dayKey(d)) ?? [];
    const sp = rs.map((r) => r.spo2).filter((x): x is number => x !== null);
    out.push({ day: dayKey(d), dayStart: d, bpm: rs.length ? median(rs.map((r) => r.bpm)) : null, spo2: sp.length ? median(sp) : null, n: rs.length, nGood: rs.filter((r) => r.quality === 'good').length });
  }
  return out;
}

export interface VitalsFlag { kind: 'low-spo2' | 'high-bpm'; days: number; text: string }

/** Observations over the last 7 days. Wording is deliberately cautious. */
export function vitalsFlags(days: VitalsDay[], c: RestingConfig = RESTING): VitalsFlag[] {
  const last = days.slice(-7);
  const low = last.filter((d) => d.spo2 !== null && d.spo2 < c.lowSpo2Pct).length;
  const high = last.filter((d) => d.bpm !== null && d.bpm > c.highBpm).length;
  const flags: VitalsFlag[] = [];
  if (low >= c.flagDays) flags.push({ kind: 'low-spo2', days: low, text: `On ${low} of the last 7 days the resting SpO₂ estimate was below ${c.lowSpo2Pct} %. This hobby sensor is not calibrated and is easily affected by finger position and cold hands, but if this keeps happening it may be worth mentioning to a doctor.` });
  if (high >= c.flagDays) flags.push({ kind: 'high-bpm', days: high, text: `On ${high} of the last 7 days the resting heart rate was above ${c.highBpm} bpm. Readings from this sensor can be disturbed by movement, but if this keeps happening it may be worth mentioning to a doctor.` });
  return flags;
}
