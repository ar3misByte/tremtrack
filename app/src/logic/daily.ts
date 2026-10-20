// Per-day and per-week aggregation of stored sessions and episodes, in local time.
import { dailyScore, type DailyScore } from './severity';
import type { Episode, Session } from './model';

export const DAY_MS = 86_400_000;

/** Local calendar day key, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function startOfDay(ms: number): number { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** Start of the next local day (handles 23/25-hour DST days). */
export function nextDay(ms: number): number { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() + 1); return d.getTime(); }
/** Monday 00:00 of the local week containing ms. */
export function startOfWeek(ms: number): number { const d = new Date(startOfDay(ms)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }

export interface DaySummary extends DailyScore {
  day: string;
  dayStart: number;
  axisCounts: [number, number, number];
  meanFreqHz: number | null;
  maxEpisodeScore: number | null;
  combinedEpisodes: number;      // episodes with several axes shaking together
  stillS: number;
  restlessS: number;
  poseMonitoredS: number;
  outsidePoseS: number;
}

type DayTotals = { monitoredS: number; stillS: number; restlessS: number; poseMonitoredS: number; outsidePoseS: number };

/** Splits each session's monitored, stillness and posture time over the local days its wall-clock span covers (pro rata). */
function totalsByDay(sessions: Session[]): Map<string, DayTotals> {
  const m = new Map<string, DayTotals>();
  const add = (k: string, s: Session, w: number) => {
    const t = m.get(k) ?? { monitoredS: 0, stillS: 0, restlessS: 0, poseMonitoredS: 0, outsidePoseS: 0 };
    t.monitoredS += s.monitoredS * w; t.stillS += (s.stillS ?? 0) * w; t.restlessS += (s.restlessS ?? 0) * w;
    t.poseMonitoredS += (s.poseMonitoredS ?? 0) * w; t.outsidePoseS += (s.outsidePoseS ?? 0) * w;
    m.set(k, t);
  };
  for (const s of sessions) {
    const span = Math.max(1, s.end - s.start);
    let a = s.start;
    while (a < s.end) {
      const b = Math.min(s.end, nextDay(a));
      const k = dayKey(a);
      add(k, s, (b - a) / span);
      a = b;
    }
    if (s.end <= s.start) add(dayKey(s.start), s, 1);
  }
  return m;
}

/** One summary per local day from `from` to `to` (inclusive), oldest first. Days without monitoring get score null. */
export function summarizeDays(sessions: Session[], episodes: Episode[], from: number, to: number): DaySummary[] {
  const tot = totalsByDay(sessions);
  const byDay = new Map<string, Episode[]>();
  for (const e of episodes) { const k = dayKey(e.start); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e); }
  const out: DaySummary[] = [];
  for (let d = startOfDay(from); d <= to; d = nextDay(d)) {
    const k = dayKey(d);
    const eps = byDay.get(k) ?? [];
    const t = tot.get(k) ?? { monitoredS: 0, stillS: 0, restlessS: 0, poseMonitoredS: 0, outsidePoseS: 0 };
    const ds = dailyScore({ episodes: eps.map((e) => ({ ampDps: e.ampDps, freqHz: e.freqHz, durationS: e.durationS })), monitoredS: t.monitoredS });
    const axisCounts: [number, number, number] = [0, 0, 0];
    eps.forEach((e) => axisCounts[e.axis]++);
    const fq = eps.filter((e) => e.freqHz > 0);
    out.push({
      ...ds, day: k, dayStart: d, axisCounts,
      meanFreqHz: fq.length ? fq.reduce((s, e) => s + e.freqHz, 0) / fq.length : null,
      maxEpisodeScore: eps.length ? Math.max(...eps.map((e) => e.score)) : null,
      combinedEpisodes: eps.filter((e) => (e.axes?.length ?? 1) > 1).length,
      stillS: t.stillS, restlessS: t.restlessS, poseMonitoredS: t.poseMonitoredS, outsidePoseS: t.outsidePoseS,
    });
  }
  return out;
}

/** Trailing 7-day mean of scored days; null unless at least `minDays` of the 7 have a score. */
export function rollingMean(days: DaySummary[], window = 7, minDays = 3): (number | null)[] {
  return days.map((_, i) => {
    const xs = days.slice(Math.max(0, i - window + 1), i + 1).map((d) => d.score).filter((x): x is number => x !== null);
    return xs.length >= minDays ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  });
}

export interface WeekSummary {
  weekStart: number;
  scoredDays: number;
  meanScore: number | null;
  episodes: number;
  tremorS: number;
  monitoredS: number;
}

export function summarizeWeeks(days: DaySummary[]): WeekSummary[] {
  const m = new Map<number, DaySummary[]>();
  for (const d of days) { const w = startOfWeek(d.dayStart); (m.get(w) ?? m.set(w, []).get(w)!).push(d); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([weekStart, ds]) => {
    const sc = ds.map((d) => d.score).filter((x): x is number => x !== null);
    return {
      weekStart, scoredDays: sc.length, meanScore: sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null,
      episodes: ds.reduce((s, d) => s + d.episodes, 0), tremorS: ds.reduce((s, d) => s + d.tremorS, 0),
      monitoredS: ds.reduce((s, d) => s + d.monitoredS, 0),
    };
  });
}
