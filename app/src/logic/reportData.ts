// Assembles everything the doctor report shows for a date range. Pure: the PDF renderer and the
// on-screen preview both use this, and it is unit-tested (reportData.test.ts).
import { SEVERITY } from '../config/thresholds';
import { compareTags, heartRateLink, medicationEffects, type Comparison, type HeartRateLink, type MedEffect } from './correlate';
import { rollingMean, summarizeDays, summarizeWeeks, type DaySummary, type WeekSummary } from './daily';
import { hints, type Hint, type HintFeatures } from './hints';
import { adherence, type Adherence } from './meds';
import type { DoseLog, Episode, FallEvent, Medication, Sample, Session, Tag } from './model';
import { summarizeVitals, vitalsFlags, type RestingReading, type VitalsDay, type VitalsFlag } from './vitals';
import { mean, median } from './stats';

export interface ReportInput {
  from: number; to: number; now: number;
  sessions: Session[]; episodes: Episode[]; tags: Tag[]; meds: Medication[]; doses: DoseLog[];
  vitals: RestingReading[]; events: FallEvent[]; samples: Sample[];
  maxEpisodeRows?: number;
}

export interface ReportData {
  period: { from: number; to: number; days: number };
  generatedAt: number;
  containsDemo: boolean;
  empty: boolean;
  overview: {
    monitoredH: number; daysWithData: number; episodes: number; tremorMin: number; shareOfTime: number | null;
    meanDailyScore: number | null; maxDailyScore: number | null; combinedEpisodes: number; scoreVersion: number;
  };
  days: DaySummary[];
  avg: (number | null)[];
  weeks: WeekSummary[];
  episodeRows: Episode[];
  episodeRowsNote: string | null;
  hints: Hint[];
  hintFeatures: HintFeatures;
  hintsEnough: boolean;
  tags: Comparison[];
  tagCounts: { kind: string; n: number }[];
  meds: { med: Medication; effect: MedEffect; adherence: Adherence }[];
  hr: HeartRateLink;
  posture: { stillS: number; restlessS: number; poseMonitoredS: number; outsidePoseS: number; calibratedDays: number };
  vitals: { days: VitalsDay[]; flags: VitalsFlag[]; nReadings: number; medianBpm: number | null; medianSpo2: number | null };
  falls: FallEvent[];
}

export function assembleReport(i: ReportInput): ReportData {
  const end = Math.min(i.to, i.now);
  const inRange = <T extends { t: number }>(x: T[]) => x.filter((r) => r.t >= i.from && r.t <= end);
  const sessions = i.sessions.filter((s) => s.end >= i.from && s.start <= end);
  const episodes = i.episodes.filter((e) => e.start >= i.from && e.start <= end).sort((a, b) => a.start - b.start);
  const tags = inRange(i.tags);
  const vitals = inRange(i.vitals);
  const events = inRange(i.events).sort((a, b) => a.t - b.t);
  const doses = i.doses.filter((d) => { const t = d.takenAt ?? d.scheduledFor ?? d.loggedAt; return t >= i.from && t <= end; });

  const days = summarizeDays(sessions, episodes, i.from, end);
  const scored = days.filter((d) => d.score !== null).map((d) => d.score!);
  const monitoredS = days.reduce((s, d) => s + d.monitoredS, 0);
  const tremorS = days.reduce((s, d) => s + d.tremorS, 0);
  const weeks = summarizeWeeks(days);
  const h = hints(episodes, days.filter((d) => d.monitoredS > 0).length, weeks);

  const max = i.maxEpisodeRows ?? 150;
  let episodeRows = episodes, episodeRowsNote: string | null = null;
  if (episodes.length > max) {
    episodeRows = [...episodes].sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.start - b.start);
    episodeRowsNote = `Showing the ${max} highest-scoring of ${episodes.length} episodes, in time order. All episodes are included in the numbers above.`;
  }

  const medsInRange = i.meds.filter((m) => m.createdAt <= end);
  const effects = medicationEffects(medsInRange, doses, sessions, episodes);
  const vdays = summarizeVitals(vitals, i.from, end);
  const usable = vitals.filter((v) => v.quality !== 'poor');
  const tagCounts = [...tags.reduce((m, t) => m.set(t.label ?? t.kind, (m.get(t.label ?? t.kind) ?? 0) + 1), new Map<string, number>())].map(([kind, n]) => ({ kind, n }));

  return {
    period: { from: i.from, to: end, days: days.length },
    generatedAt: i.now,
    containsDemo: [...sessions, ...episodes, ...tags, ...vitals, ...events].some((x) => x.demo) || medsInRange.some((m) => m.demo),
    empty: sessions.length === 0,
    overview: {
      monitoredH: monitoredS / 3600, daysWithData: days.filter((d) => d.monitoredS > 0).length, episodes: episodes.length,
      tremorMin: tremorS / 60, shareOfTime: monitoredS > 0 ? tremorS / monitoredS : null,
      meanDailyScore: scored.length ? mean(scored) : null, maxDailyScore: scored.length ? Math.max(...scored) : null,
      combinedEpisodes: episodes.filter((e) => (e.axes?.length ?? 1) > 1).length, scoreVersion: SEVERITY.version,
    },
    days, avg: rollingMean(days), weeks,
    episodeRows, episodeRowsNote,
    hints: h.hints, hintFeatures: h.features, hintsEnough: h.enough,
    tags: compareTags(tags, sessions, episodes), tagCounts,
    meds: medsInRange.map((med, k) => ({ med, effect: effects[k], adherence: adherence([med], i.doses, i.from, end, i.now) })),
    hr: heartRateLink(episodes, vitals, i.samples.filter((s) => s.t >= i.from && s.t <= end)),
    posture: {
      stillS: days.reduce((s, d) => s + d.stillS, 0), restlessS: days.reduce((s, d) => s + d.restlessS, 0),
      poseMonitoredS: days.reduce((s, d) => s + d.poseMonitoredS, 0), outsidePoseS: days.reduce((s, d) => s + d.outsidePoseS, 0),
      calibratedDays: days.filter((d) => d.poseMonitoredS > 0).length,
    },
    vitals: {
      days: vdays, flags: vitalsFlags(vdays), nReadings: usable.length,
      medianBpm: usable.length ? median(usable.map((v) => v.bpm)) : null,
      medianSpo2: usable.some((v) => v.spo2 !== null) ? median(usable.filter((v) => v.spo2 !== null).map((v) => v.spo2!)) : null,
    },
    falls: events,
  };
}
