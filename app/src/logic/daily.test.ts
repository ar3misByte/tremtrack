import { describe, expect, it } from 'vitest';
import { dayKey, rollingMean, startOfWeek, summarizeDays, summarizeWeeks } from './daily';
import type { Episode, Session } from './model';
import { generateSampleHistory } from './sampleHistory';
import { formatRecording, parseRecording } from './recording';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

const sess = (start: number, end: number, monitoredS = (end - start) / 1000): Session => ({
  id: 's' + start, source: 'serial', demo: false, start, end, open: false, monitoredS, tremorS: 0, walkingS: 0, episodes: 0, frames: 0, sensitivity: 2,
});
const ep = (start: number, durationS = 10, axis: 0 | 1 | 2 = 2): Episode => ({
  id: 'e' + start, sessionId: 'x', source: 'serial', demo: false, start, end: start + durationS * 1000, durationS, axis, axisShare: [0, 0, 1],
  ampDps: 10, peakAmpDps: 12, freqHz: 5, q: 0.8, cycles: 7, walkingFrac: 0, bpm: 75, displacementDeg: 0.32, score: 4, scoreVersion: 1, sensitivity: 2,
});

describe('summarizeDays', () => {
  it('gives every day in range a row; unmonitored days have a null score', () => {
    const days = summarizeDays([sess(at(5, 9), at(5, 11))], [ep(at(5, 10))], at(4, 12), at(6, 12));
    expect(days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(days[0].score).toBeNull();
    expect(days[1].score).toBeGreaterThan(0);
    expect(days[1].episodes).toBe(1);
    expect(days[1].axisCounts).toEqual([0, 0, 1]);
    expect(days[2].score).toBeNull();
  });

  it('splits a session across midnight pro rata', () => {
    const days = summarizeDays([sess(at(5, 23), at(6, 1))], [], at(5, 0), at(6, 0));
    expect(days[0].monitoredS).toBeCloseTo(3600, 0);
    expect(days[1].monitoredS).toBeCloseTo(3600, 0);
  });

  it('a monitored day without episodes scores 0, not null', () => {
    expect(summarizeDays([sess(at(5, 9), at(5, 10))], [], at(5, 0), at(5, 0))[0].score).toBe(0);
  });
});

describe('rollingMean and weeks', () => {
  it('needs 3 scored days in the window and skips nulls', () => {
    const mk = (score: number | null) => ({ score } as never);
    expect(rollingMean([mk(1), mk(null), mk(3), mk(5)])).toEqual([null, null, null, 3]);
  });

  it('groups by Monday-start weeks', () => {
    expect(new Date(startOfWeek(at(21, 15))).getDay()).toBe(1);   // 21 Oct 2026 is a Wednesday
    const days = summarizeDays([sess(at(19, 9), at(19, 11)), sess(at(26, 9), at(26, 11))], [ep(at(19, 10)), ep(at(26, 10)), ep(at(26, 10, 30))], at(19, 0), at(26, 0));
    const w = summarizeWeeks(days);
    expect(w).toHaveLength(2);
    expect(w[0].episodes).toBe(1);
    expect(w[1].episodes).toBe(2);
    expect(w[0].scoredDays).toBe(1);
  });

  it('dayKey is local', () => {
    expect(dayKey(at(5, 0, 30))).toBe('2026-10-05');
    expect(dayKey(at(5, 23, 59))).toBe('2026-10-05');
  });
});

describe('generateSampleHistory', () => {
  it('is deterministic, flagged as demo, inside the range, without overlapping episodes', () => {
    const end = at(20, 18);
    const a = generateSampleHistory(28, end, 3);
    const b = generateSampleHistory(28, end, 3);
    expect(a).toEqual(b);
    expect(a.sessions.length).toBeGreaterThan(20);
    expect(a.episodes.length).toBeGreaterThan(50);
    expect([...a.sessions, ...a.episodes].every((x) => x.demo && x.source === 'sample')).toBe(true);
    expect(a.sessions.every((s) => s.end <= end)).toBe(true);
    const bySession = new Map<string, Episode[]>();
    a.episodes.forEach((e) => (bySession.get(e.sessionId) ?? bySession.set(e.sessionId, []).get(e.sessionId)!).push(e));
    for (const eps of bySession.values()) for (let i = 1; i < eps.length; i++) expect(eps[i].start).toBeGreaterThanOrEqual(eps[i - 1].end);
    const days = summarizeDays(a.sessions, a.episodes, at(20, 0) - 27 * 86_400_000, end);
    expect(days.filter((d) => d.score !== null).length).toBeGreaterThan(18);
  });
});

describe('recording format', () => {
  it('round-trips and tolerates junk lines', () => {
    const r = { start: Date.UTC(2026, 9, 20, 8), source: 'serial', entries: [[0, '# hi'], [20, '$,1,2'], [40.4, '$,3,4']] as [number, string][] };
    const txt = formatRecording(r);
    expect(parseRecording(txt + 'garbage\n30\tout-of-order\n')).toEqual({ ...r, entries: [[0, '# hi'], [20, '$,1,2'], [40, '$,3,4']] });
    expect(() => parseRecording('nope')).toThrow(/header/);
  });
});
