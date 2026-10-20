// Comparisons for the Insights screen. Every result carries its sample counts and an interval, says
// "not enough data" below CORRELATION minimums, and is worded as an association, never a cause.
//
// Measure: share of MONITORED time with a tremor episode, inside a window. Monitored time comes from the
// sessions overlapping the window (pro rata over their span), so gaps without the headset don't count.
import { CORRELATION, MEDS, TAGS, type TagKind } from '../config/thresholds';
import type { DoseLog, Episode, Medication, Sample, Session, Tag } from './model';
import type { RestingReading } from './vitals';
import { dayKey } from './daily';
import { bootstrapDiff, bootstrapMean, correctedLevel, hedgesG, mean, median, verdictOf, type Interval, type Verdict } from './stats';

const MIN = 60_000;

export interface WindowStat { start: number; end: number; monitoredS: number; tremorS: number; share: number }

/** Monitored and tremor seconds in [start, end). Returns null when less than minCoverage was monitored. */
export function windowStat(start: number, end: number, sessions: Session[], episodes: Episode[], minCoverage = CORRELATION.minCoverage): WindowStat | null {
  let monitoredS = 0;
  for (const s of sessions) {
    const ov = Math.min(end, s.end) - Math.max(start, s.start);
    if (ov <= 0) continue;
    monitoredS += (s.monitoredS * ov) / Math.max(1000, s.end - s.start);
  }
  if (monitoredS < ((end - start) / 1000) * minCoverage) return null;
  let tremorS = 0;
  for (const e of episodes) {
    const ov = Math.min(end, e.end) - Math.max(start, e.start);
    if (ov > 0) tremorS += ov / 1000;
  }
  return { start, end, monitoredS, tremorS, share: Math.min(1, tremorS / monitoredS) };
}

/**
 * Baseline: the same clock-time window on OTHER days without a tag of this kind (up to TAGS.baselineDays
 * away), so time-of-day effects (mornings vs evenings) are compared like with like.
 */
function matchedBaseline(ts: number[], s0: number, s1: number, avoid: [number, number][], sessions: Session[], episodes: Episode[]): WindowStat[] {
  const seen = new Set<number>();
  const out: WindowStat[] = [];
  for (const t of ts) {
    for (let k = -TAGS.baselineDays; k <= TAGS.baselineDays; k++) {
      if (k === 0) continue;
      const d = new Date(t); d.setDate(d.getDate() + k);              // calendar days, DST-safe
      const a = d.getTime() + s0 * MIN, b = d.getTime() + s1 * MIN;
      const key = Math.round(a / (5 * MIN));
      if (seen.has(key) || avoid.some(([x, y]) => a < y && b > x)) continue;
      seen.add(key);
      const w = windowStat(a, b, sessions, episodes);
      if (w) out.push(w);
    }
  }
  return out;
}

export interface Comparison {
  key: string;
  label: string;
  nAfter: number;
  nBase: number;
  afterShare: number | null;      // mean share of time with tremor
  baseShare: number | null;
  diff: Interval | null;          // percentage points (share x 100)
  g: number | null;               // Hedges' g
  verdict: Verdict;
}

export const TAG_LABEL: Record<TagKind, string> = {
  coffee: 'Coffee', 'poor-sleep': 'Poor sleep', stress: 'Stress', exercise: 'Exercise', alcohol: 'Alcohol', meal: 'Meal', custom: 'Custom',
};

/** Tremor after each kind of tag vs baseline windows. The interval level is corrected for the number of kinds compared. */
export function compareTags(tags: Tag[], sessions: Session[], episodes: Episode[], c = CORRELATION): Comparison[] {
  const kinds = [...new Set(tags.map((t) => t.kind))];
  const pre = kinds.map((k) => {
    const [s0, s1] = TAGS.windows[k];
    const ts = tags.filter((t) => t.kind === k);
    const after = ts.map((t) => windowStat(t.t + s0 * MIN, t.t + s1 * MIN, sessions, episodes)).filter((w): w is WindowStat => !!w);
    const avoid = ts.map((t) => [t.t - TAGS.baselineGapMin * MIN, t.t + (s1 + TAGS.baselineGapMin) * MIN] as [number, number]);
    const base = matchedBaseline(ts.map((t) => t.t), s0, s1, avoid, sessions, episodes);
    return { k, after, base };
  });
  const tested = pre.filter((p) => p.after.length >= c.minAfterWindows && p.base.length >= c.minBaselineWindows).length;
  const level = correctedLevel(tested, c.alpha);
  return pre.map(({ k, after, base }, i) => {
    const enough = after.length >= c.minAfterWindows && base.length >= c.minBaselineWindows;
    const a = after.map((w) => 100 * w.share), b = base.map((w) => 100 * w.share);
    const diff = enough ? bootstrapDiff(a, b, level, c.bootstrap, 101 + i) : null;
    return {
      key: k, label: TAG_LABEL[k], nAfter: after.length, nBase: base.length,
      afterShare: a.length ? mean(a) : null, baseShare: b.length ? mean(b) : null,
      diff, g: enough ? hedgesG(a, b) : null, verdict: verdictOf(diff, enough),
    };
  }).sort((x, y) => y.nAfter - x.nAfter);
}

export interface MedEffect {
  medId: string; name: string; nDoses: number; nPaired: number;
  beforeShare: number | null; afterShare: number | null;
  diff: Interval | null;          // after - before, percentage points, paired
  verdict: Verdict;
}

/** For each medication: tremor in the window after each taken dose vs the window just before it (paired). */
export function medicationEffects(meds: Medication[], logs: DoseLog[], sessions: Session[], episodes: Episode[], c = CORRELATION, m = MEDS): MedEffect[] {
  const pre = meds.map((med) => {
    const times = logs.filter((l) => l.medId === med.id && l.status === 'taken' && l.takenAt !== null).map((l) => l.takenAt!);
    const pairs: [number, number][] = [];
    for (const t of times) {
      const before = windowStat(t - m.beforeMin * MIN, t, sessions, episodes);
      const after = windowStat(t + m.afterStartMin * MIN, t + m.afterEndMin * MIN, sessions, episodes);
      if (before && after) pairs.push([100 * before.share, 100 * after.share]);
    }
    return { med, times, pairs };
  });
  const tested = pre.filter((p) => p.pairs.length >= c.minPairedDoses).length;
  const level = correctedLevel(tested, c.alpha);
  return pre.map(({ med, times, pairs }, i) => {
    const enough = pairs.length >= c.minPairedDoses;
    const diff = enough ? bootstrapMean(pairs.map(([b, a]) => a - b), level, c.bootstrap, 201 + i) : null;
    return {
      medId: med.id, name: med.name, nDoses: times.length, nPaired: pairs.length,
      beforeShare: pairs.length ? mean(pairs.map((p) => p[0])) : null, afterShare: pairs.length ? mean(pairs.map((p) => p[1])) : null,
      diff, verdict: verdictOf(diff, enough),
    };
  });
}

export interface HeartRateLink {
  /** Heart rate during episodes minus that day's median resting heart rate (bpm). */
  during: { n: number; diff: Interval | null; verdict: Verdict };
  /** Mean heart rate in the 5 min before episodes minus the same session's baseline (bpm). Needs 1 s samples (kept 30 days). */
  before: { n: number; diff: Interval | null; verdict: Verdict };
}

export function heartRateLink(episodes: Episode[], resting: RestingReading[], samples: Sample[], c = CORRELATION): HeartRateLink {
  // during episodes vs same-day resting median
  const restByDay = new Map<string, number[]>();
  for (const r of resting) if (r.quality !== 'poor') (restByDay.get(dayKey(r.t)) ?? restByDay.set(dayKey(r.t), []).get(dayKey(r.t))!).push(r.bpm);
  const dDuring = episodes.filter((e) => e.bpm && restByDay.has(dayKey(e.start))).map((e) => e.bpm! - median(restByDay.get(dayKey(e.start))!));
  // 5 min before vs session baseline
  const bySession = new Map<string, Sample[]>();
  for (const s of samples) if (s.ppgState === 3 && s.bpm) (bySession.get(s.sessionId) ?? bySession.set(s.sessionId, []).get(s.sessionId)!).push(s);
  const dBefore: number[] = [];
  for (const e of episodes) {
    const ss = bySession.get(e.sessionId);
    if (!ss) continue;
    const pre = ss.filter((s) => s.t >= e.start - c.hrBeforeS * 1000 && s.t < e.start);
    const near = (t: number) => episodes.some((x) => x.sessionId === e.sessionId && t > x.start - c.hrBaselineGapS * 1000 && t < x.end + c.hrBaselineGapS * 1000);
    const base = ss.filter((s) => !near(s.t));
    if (pre.length >= 30 && base.length >= 60) dBefore.push(mean(pre.map((s) => s.bpm!)) - mean(base.map((s) => s.bpm!)));
  }
  const level = correctedLevel(2, c.alpha);
  const res = (d: number[], seed: number) => {
    const enough = d.length >= c.minEpisodesForHr;
    const iv = enough ? bootstrapMean(d, level, c.bootstrap, seed) : null;
    return { n: d.length, diff: iv, verdict: verdictOf(iv, enough) };
  };
  return { during: res(dDuring, 301), before: res(dBefore, 302) };
}
