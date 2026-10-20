// Cloud day summaries (from the hourly aggregator) in the shape the Trends chart draws.
import { rollingMean, type DaySummary } from '../logic/daily';
import type { DayRow } from './aws';

const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The last `n` calendar days ending today (as written on this device's clock); days the headset was not worn are empty. */
export function cloudDaySummaries(rows: DayRow[], n = 30, now = new Date()): { days: DaySummary[]; avg: (number | null)[] } {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: DaySummary[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = key(d);
    const r = byDay.get(day);
    const monitoredS = r?.monitoredS ?? 0, tremorS = r?.tremorS ?? 0;
    days.push({
      day, dayStart: d.getTime(),
      score: monitoredS > 0 && typeof r?.score === 'number' ? r.score : null,
      burden: 0, shareShaking: monitoredS > 0 ? tremorS / monitoredS : 0, tremorS, monitoredS, episodes: r?.episodes ?? 0,
      ...(monitoredS > 0 && typeof r?.score !== 'number' ? { reason: 'not-enough-data' as const } : {}),
      axisCounts: [0, 0, 0], meanFreqHz: null, maxEpisodeScore: r?.maxEpisodeScore ?? null, combinedEpisodes: 0,
      stillS: 0, restlessS: 0, poseMonitoredS: 0, outsidePoseS: 0,
    });
  }
  return { days, avg: rollingMean(days) };
}
