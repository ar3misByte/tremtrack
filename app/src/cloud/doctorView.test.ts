import { describe, expect, it } from 'vitest';
import type { PatientDay, PatientRow } from './aws';
import { cloudDay, DAY_MS, formatCode, overview, triage } from './doctorView';

const NOW = Date.UTC(2026, 9, 25, 6, 0);
const day = (back: number, o: Partial<PatientDay> = {}): PatientDay => ({ day: cloudDay(NOW - back * DAY_MS), score: 3, episodes: 2, falls: 0, monitoredS: 7200, restingBpm: 70, restingSpo2: 97, ...o });
const row = (o: Partial<PatientRow> = {}): PatientRow => ({
  id: 'ap-south-1:x', label: 'P', since: NOW - 10 * DAY_MS, falls7: 0, lastFallTs: null,
  devices: [{ thing: 'htm-01', online: true, lastSeen: NOW - 60_000 }], days: Array.from({ length: 14 }, (_, i) => day(i)), ...o,
});

describe('overview', () => {
  it('averages the last 7 days, compares with the 7 before, and reports the latest resting vitals', () => {
    const days = [...Array.from({ length: 7 }, (_, i) => day(i, { score: 6, restingBpm: 80 + i })), ...Array.from({ length: 7 }, (_, i) => day(7 + i, { score: 3 }))];
    const o = overview(row({ days }), NOW);
    expect(o.avg7).toBe(6);
    expect(o.prev7).toBe(3);
    expect(o.trend).toBe('worse');
    expect(o.episodes7).toBe(14);
    expect(o.restingBpm).toBe(80);                       // today's value (the newest day)
    expect(o.latestDay).toBe(cloudDay(NOW));
    expect(o.spark).toHaveLength(14);
    expect(o.spark.at(-1)).toBe(6);
    expect(o.flags.map((f) => f.text)).toEqual([expect.stringContaining('Average severity up 3.0')]);
  });

  it('days without a score count as no data, not as zero', () => {
    const o = overview(row({ days: [day(0, { score: null }), day(1, { score: 4 }), day(2, { score: null })] }), NOW);
    expect(o.avg7).toBe(4);
    expect(o.prev7).toBeNull();
    expect(o.trend).toBeNull();
    expect(o.latestScore).toBe(4);
  });

  it('flags a recent fall as an alert, with different wording within 24 hours', () => {
    const now24 = overview(row({ falls7: 1, lastFallTs: NOW - 3_600_000 }), NOW);
    expect(now24.flags[0]).toMatchObject({ level: 'alert', text: expect.stringContaining('last 24 hours') });
    const week = overview(row({ falls7: 2, lastFallTs: NOW - 3 * DAY_MS }), NOW);
    expect(week.flags[0]).toMatchObject({ level: 'alert', text: '2 falls (confirmed or unanswered) in the last 7 days' });
  });

  it('flags a silent headset, a missing headset, low SpO2 and an unusual resting heart rate', () => {
    expect(overview(row({ devices: [{ thing: 'h', online: false, lastSeen: NOW - 3 * DAY_MS }] }), NOW).flags[0].text).toBe('Headset has not reported for 3 days');
    expect(overview(row({ devices: [{ thing: 'h', online: false, lastSeen: NOW - 30 * 3_600_000 }] }), NOW).flags[0].text).toBe('Headset has not reported for 1 day');
    expect(overview(row({ devices: [] }), NOW).flags.map((f) => f.text)).toContain('No headset has reported yet');
    expect(overview(row({ days: [day(0, { restingSpo2: 90 })] }), NOW).flags.map((f) => f.text)).toContain('Resting SpO₂ estimate 90 %');
    expect(overview(row({ days: [day(0, { restingBpm: 110 })] }), NOW).flags.map((f) => f.text)).toContain('Resting heart rate 110 bpm');
    expect(overview(row(), NOW).flags).toEqual([]);                    // a steady, online patient raises nothing
  });
});

describe('triage', () => {
  it('puts falls first, then other flags, then the highest recent severity', () => {
    const calm = overview(row({ id: 'a', label: 'Calm' }), NOW);
    const sev = overview(row({ id: 'b', label: 'Severe', days: Array.from({ length: 14 }, (_, i) => day(i, { score: 8 })) }), NOW);
    const fall = overview(row({ id: 'c', label: 'Fall', falls7: 1, lastFallTs: NOW - 1000 }), NOW);
    const off = overview(row({ id: 'd', label: 'Offline', devices: [{ thing: 'h', online: false, lastSeen: NOW - 5 * DAY_MS }] }), NOW);
    expect(triage([calm, sev, off, fall]).map((o) => o.label)).toEqual(['Fall', 'Offline', 'Severe', 'Calm']);
  });
});

describe('formatCode', () => {
  it('writes a code in two groups of five', () => expect(formatCode('K7M2Q9XPD4')).toBe('K7M2Q-9XPD4'));
});
