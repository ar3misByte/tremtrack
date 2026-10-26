import { describe, expect, it } from 'vitest';
import type { PatientDay, PatientRow } from './aws';
import { adherence, cloudDay, DAY_MS, formatCode, overview, patientCsv, triage } from './doctorView';

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
    expect(week.flags[0]).toMatchObject({ level: 'alert', text: '2 falls (confirmed or unanswered) in the last 7 days, not yet reviewed' });
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

describe('reviewed falls', () => {
  it('falls the doctor has reviewed do not flag the patient, but still count in the totals', () => {
    const o = overview(row({ falls7: 2, unreviewedFalls: 0, lastFallTs: null, reviewedAt: NOW - 1000 }), NOW);
    expect(o.flags).toEqual([]);
    expect(o.falls7).toBe(2);
    expect(o.unreviewedFalls).toBe(0);
    const n = overview(row({ falls7: 2, unreviewedFalls: 1, lastFallTs: NOW - 3 * DAY_MS }), NOW);
    expect(n.flags[0].text).toBe('1 fall (confirmed or unanswered) in the last 7 days, not yet reviewed');
  });
});

describe('adherence', () => {
  const med = (id: string, name: string, active = true) => ({ id, name, active });
  const dose = (medId: string, status: 'taken' | 'skipped', loggedAt: number) => ({ id: `${medId}@${loggedAt}`, medId, scheduledFor: loggedAt, takenAt: status === 'taken' ? loggedAt : null, status, loggedAt });
  it('counts taken and skipped doses in the window, and the share taken', () => {
    const rows = adherence([med('a', 'Alpha'), med('b', 'Beta')], [dose('a', 'taken', NOW - DAY_MS), dose('a', 'taken', NOW - 2 * DAY_MS), dose('a', 'skipped', NOW - 3 * DAY_MS), dose('a', 'taken', NOW - 60 * DAY_MS), dose('b', 'skipped', NOW - DAY_MS)], NOW, 30);
    expect(rows.map((r) => [r.med.name, r.taken, r.skipped, r.share])).toEqual([['Alpha', 2, 1, 2 / 3], ['Beta', 0, 1, 0]]);
    expect(rows[0].lastTakenAt).toBe(NOW - DAY_MS);
    expect(rows[1].lastTakenAt).toBeNull();
  });
  it('has no share without logged doses, and lists stopped medications last', () => {
    const rows = adherence([med('z', 'Zed', false), med('a', 'Alpha')], [], NOW);
    expect(rows.map((r) => r.med.name)).toEqual(['Alpha', 'Zed']);
    expect(rows.every((r) => r.share === null)).toBe(true);
  });
});

describe('patientCsv', () => {
  const detail = {
    id: 'ap-south-1:x', label: 'Patient, "A"', since: NOW, expiresAt: null, reviewedAt: null, medsShared: false, devices: [], vitals: [], notes: [], meds: [], doses: [],
    days: [{ day: '2026-10-24', score: 3.456, episodes: 2, falls: 1, monitoredS: 3600, tremorS: 600, restingBpm: 71.4, restingSpo2: 97 }, { day: '2026-10-23', score: null, episodes: 0 }],
    events: [{ ts: NOW, type: 'fall', thing: 'htm-01', fall: { t: NOW, path: 'a', peakG: 3.2, outcome: 'no-response' } }],
    episodes: [{ id: 'e1', start: NOW - 1000, durationS: 30.4, freqHz: 5.123, ampDps: 10, score: 4 }],
  } as never;
  it('writes sections with the days oldest first, escapes quotes and commas, and leaves empty values empty', () => {
    const csv = patientCsv(detail, NOW);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Patient,"Patient, ""A"""');
    expect(lines).toContain('2026-10-23,,0,0,0,0,,');
    expect(lines).toContain('2026-10-24,3.46,2,1,60,10,71,97');
    expect(lines.indexOf('2026-10-23,,0,0,0,0,,')).toBeLessThan(lines.indexOf('2026-10-24,3.46,2,1,60,10,71,97'));
    expect(csv).toContain('fall,Possible fall (peak 3.2 g): nobody answered the countdown.');
    expect(csv).toContain('30,5.12,10.00,4.00');
    expect(csv).not.toContain('Medication doses');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
  it('includes medication doses only when they are shared', () => {
    const d = { ...(detail as object), medsShared: true, meds: [{ id: 'm1', name: 'Med A', dose: '10 mg' }], doses: [{ id: 'd', medId: 'm1', scheduledFor: NOW, takenAt: NOW, status: 'taken', loggedAt: NOW }] } as never;
    const csv = patientCsv(d, NOW);
    expect(csv).toContain('Medication doses (shared by the patient)');
    expect(csv).toContain('Med A,10 mg,taken,');
  });
});
