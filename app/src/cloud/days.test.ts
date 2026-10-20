import { describe, expect, it } from 'vitest';
import { cloudDaySummaries } from './days';

describe('cloud day summaries for the chart', () => {
  const now = new Date(2026, 9, 20, 12);

  it('fills the last N days, leaves unworn days empty, and keeps scores', () => {
    const { days, avg } = cloudDaySummaries([
      { day: '2026-10-20', score: 4.2, episodes: 7, monitoredS: 3600, tremorS: 120, maxEpisodeScore: 5.1 },
      { day: '2026-10-18', score: 2.0, episodes: 3, monitoredS: 7200, tremorS: 40 },
      { day: '2026-10-19', score: null, episodes: 1, monitoredS: 120, tremorS: 10 },
    ], 5, now);
    expect(days.map((d) => d.day)).toEqual(['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
    expect(days[0]).toMatchObject({ score: null, monitoredS: 0, episodes: 0 });
    expect(days[2]).toMatchObject({ score: 2, episodes: 3, monitoredS: 7200 });
    expect(days[3]).toMatchObject({ score: null, reason: 'not-enough-data' });     // worn, but too short to score
    expect(days[4]).toMatchObject({ score: 4.2, maxEpisodeScore: 5.1 });
    expect(days[4].shareShaking).toBeCloseTo(120 / 3600);
    expect(avg).toHaveLength(5);
    expect(avg[4]).toBeNull();                                                      // only two scored days: not enough for an average
  });

  it('works with no data at all', () => {
    const { days } = cloudDaySummaries([], 30, now);
    expect(days).toHaveLength(30);
    expect(days.every((d) => d.score === null && d.monitoredS === 0)).toBe(true);
  });
});
