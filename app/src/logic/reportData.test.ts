import { describe, expect, it } from 'vitest';
import { assembleReport } from './reportData';
import { generateSampleHistory } from './sampleHistory';

const NOW = new Date(2026, 9, 20, 18).getTime();
const DAY = 86_400_000;
const h = generateSampleHistory(28, NOW, 5);
const base = { now: NOW, sessions: h.sessions, episodes: h.episodes, tags: h.tags, meds: h.meds, doses: h.doses, vitals: h.vitals, events: h.events, samples: [] };

describe('assembleReport', () => {
  it('summarises a 28-day range', () => {
    const r = assembleReport({ ...base, from: NOW - 27 * DAY, to: NOW });
    expect(r.empty).toBe(false);
    expect(r.containsDemo).toBe(true);
    expect(r.overview.episodes).toBe(r.days.reduce((s, d) => s + d.episodes, 0));
    expect(r.overview.daysWithData).toBeGreaterThan(15);
    expect(r.overview.meanDailyScore).toBeGreaterThan(0);
    expect(r.overview.shareOfTime).toBeGreaterThan(0);
    expect(r.days.length).toBe(28);
    expect(r.hintsEnough).toBe(true);
    expect(r.hints.length).toBeGreaterThan(0);
    expect(r.meds).toHaveLength(1);
    expect(r.meds[0].adherence.scheduled).toBeGreaterThan(20);
    expect(r.vitals.nReadings).toBeGreaterThan(20);
    expect(r.falls).toHaveLength(1);
    expect(r.tags.length).toBeGreaterThan(0);
  });

  it('caps the episode table and says so, keeping the highest-scoring rows in time order', () => {
    const r = assembleReport({ ...base, from: NOW - 27 * DAY, to: NOW, maxEpisodeRows: 50 });
    expect(r.episodeRows).toHaveLength(50);
    expect(r.episodeRowsNote).toMatch(/50 highest-scoring of \d+/);
    for (let k = 1; k < r.episodeRows.length; k++) expect(r.episodeRows[k].start).toBeGreaterThanOrEqual(r.episodeRows[k - 1].start);
    const minShown = Math.min(...r.episodeRows.map((e) => e.score));
    expect(r.days.length).toBe(28);
    expect(h.episodes.filter((e) => e.start >= NOW - 27 * DAY && e.score > minShown + 1e-9).length).toBeLessThanOrEqual(50);
  });

  it('only includes data inside the range', () => {
    const from = NOW - 6 * DAY;
    const r = assembleReport({ ...base, from, to: NOW });
    expect(r.days.length).toBe(7);
    expect(r.episodeRows.every((e) => e.start >= from)).toBe(true);
    expect(r.falls).toHaveLength(0);                    // the sample fall was 9 days ago
  });

  it('reports an empty range honestly', () => {
    const r = assembleReport({ ...base, from: NOW - 400 * DAY, to: NOW - 300 * DAY });
    expect(r.empty).toBe(true);
    expect(r.overview.meanDailyScore).toBeNull();
    expect(r.hintsEnough).toBe(false);
  });
});
