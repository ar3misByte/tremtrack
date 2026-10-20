// Turns stored episodes into pattern hints using the reviewable table in config/hints.ts.
// Hints describe patterns with their evidence and a confidence level; they never diagnose.
import { HINTS } from '../config/thresholds';
import { HINT_RULES } from '../config/hints';
import { dayKey, type WeekSummary } from './daily';
import type { Episode } from './model';
import { PATTERN_LABEL } from './multiaxis';
import { mean, median, quantile } from './stats';

export interface HintFeatures {
  n: number;
  daysWithData: number;
  perDay: number;
  axisShare: [number, number, number];   // share of episodes whose main axis is pitch / roll / yaw
  combinedShare: number;
  patternCounts: Record<string, number>;
  dominantPattern: string;
  freqMedian: number;
  freqIqr: [number, number];
  meanQ: number;
  meanCycles: number;
  regular: boolean;
  walkingShare: number;
  weeklyScores: number[];
}

export type Confidence = 'low' | 'moderate' | 'high';
export interface Hint { id: string; text: string; evidence: string[]; confidence: Confidence; support: number; mention: boolean; source: string; review: string }

export function features(episodes: Episode[], monitoredDays: number, weeks: WeekSummary[]): HintFeatures {
  const n = episodes.length;
  const axisShare: [number, number, number] = [0, 0, 0];
  for (const e of episodes) axisShare[e.axis] += 1 / Math.max(1, n);
  const combined = episodes.filter((e) => (e.axes?.length ?? 1) > 1);
  const patternCounts: Record<string, number> = {};
  for (const e of combined) { const p = PATTERN_LABEL[e.pattern ?? 'mixed']; patternCounts[p] = (patternCounts[p] ?? 0) + 1; }
  const dominantPattern = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed';
  const fq = episodes.map((e) => e.freqHz).filter((f) => f > 0);
  const meanQ = n ? mean(episodes.map((e) => e.q)) : 0;
  const meanCycles = n ? mean(episodes.map((e) => e.cycles)) : 0;
  const days = new Set(episodes.map((e) => dayKey(e.start))).size;
  const daysWithData = Math.max(days, monitoredDays);
  return {
    n, daysWithData, perDay: daysWithData ? n / daysWithData : 0, axisShare,
    combinedShare: n ? combined.length / n : 0, patternCounts, dominantPattern,
    freqMedian: fq.length ? median(fq) : 0, freqIqr: fq.length ? [quantile(fq, 0.25), quantile(fq, 0.75)] : [0, 0],
    meanQ, meanCycles, regular: meanQ >= 0.6 && meanCycles >= 5,
    walkingShare: n ? episodes.filter((e) => e.walkingFrac >= 0.5).length / n : 0,
    weeklyScores: weeks.filter((w) => w.meanScore !== null && w.scoredDays >= 3).map((w) => w.meanScore!).slice(-4),
  };
}

const confidenceOf = (support: number): Confidence => (support >= HINTS.highEpisodes ? 'high' : support >= HINTS.moderateEpisodes ? 'moderate' : 'low');

export function hints(episodes: Episode[], monitoredDays: number, weeks: WeekSummary[]): { features: HintFeatures; hints: Hint[]; enough: boolean } {
  const f = features(episodes, monitoredDays, weeks);
  if (f.n < HINTS.minEpisodes) return { features: f, hints: [], enough: false };
  const fill = (s: string) => s
    .replace('{freq}', f.freqMedian.toFixed(1))
    .replace('{perDay}', f.perDay.toFixed(0))
    .replace('{pattern}', f.dominantPattern)
    .replace('{from}', f.weeklyScores[0]?.toFixed(1) ?? '')
    .replace('{to}', f.weeklyScores[f.weeklyScores.length - 1]?.toFixed(1) ?? '');
  const out = HINT_RULES.filter((r) => r.when(f)).map((r) => {
    const support = r.support(f);
    return { id: r.id, text: fill(r.text), evidence: r.evidence(f), confidence: confidenceOf(support), support, mention: !!r.mention, source: r.source, review: r.review };
  });
  return { features: f, hints: out, enough: true };
}
