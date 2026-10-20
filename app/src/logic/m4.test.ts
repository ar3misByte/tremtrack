import { describe, expect, it } from 'vitest';
import { adherence, dueReminders, occurrences, stateOf, doseKey } from './meds';
import { compareTags, heartRateLink, medicationEffects, windowStat } from './correlate';
import { bootstrapDiff, bootstrapMean, correctedLevel, hedgesG, verdictOf } from './stats';
import { hints } from './hints';
import { HINT_RULES } from '../config/hints';
import type { DoseLog, Episode, Medication, Session, Tag } from './model';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const MIN = 60_000;

const med = (o: Partial<Medication> = {}): Medication => ({ id: 'm1', name: 'Med A', dose: '1 tablet', times: ['08:00', '20:00'], days: [], active: true, createdAt: at(1, 0), demo: false, ...o });
const log = (m: string, sched: number, takenAt: number | null, status: DoseLog['status'] = 'taken'): DoseLog => ({ id: doseKey(m, sched), medId: m, scheduledFor: sched, takenAt, status, loggedAt: takenAt ?? sched, demo: false });

describe('medication schedule and adherence', () => {
  it('lists occurrences on chosen weekdays only', () => {
    expect(occurrences(med(), at(5, 0), at(5, 23, 59)).map((o) => new Date(o.at).getHours())).toEqual([8, 20]);
    const mon = med({ days: [1] });                       // 5 Oct 2026 is a Monday
    expect(occurrences(mon, at(5, 0), at(11, 23)).length).toBe(2);
    expect(occurrences(med({ active: false }), at(5, 0), at(6, 0))).toEqual([]);
  });

  it('classifies dose states', () => {
    const o = occurrences(med(), at(5, 0), at(5, 9))[0];
    expect(stateOf(o, undefined, at(5, 7))).toBe('upcoming');
    expect(stateOf(o, undefined, at(5, 9))).toBe('due');
    expect(stateOf(o, undefined, at(5, 10, 1))).toBe('missed');
    expect(stateOf(o, log('m1', o.at, at(5, 8, 20)), at(5, 12))).toBe('taken');
    expect(stateOf(o, log('m1', o.at, at(5, 9, 15)), at(5, 12))).toBe('late');
    expect(stateOf(o, log('m1', o.at, null, 'skipped'), at(5, 12))).toBe('skipped');
  });

  it('computes adherence over past doses only', () => {
    const m = med();
    const occ = occurrences(m, at(5, 0), at(6, 23));
    const logs = [log('m1', occ[0].at, occ[0].at + 5 * MIN), log('m1', occ[1].at, occ[1].at + 50 * MIN), log('m1', occ[2].at, null, 'skipped')];
    const a = adherence([m], logs, at(5, 0), at(6, 23), at(6, 21));   // 4th dose (6th 20:00) is due, not counted
    expect(a).toMatchObject({ scheduled: 3, taken: 2, onTime: 1, late: 1, skipped: 1, missed: 0 });
    expect(a.pct).toBeCloseTo(2 / 3);
  });

  it('reminds about due doses unless logged or snoozed', () => {
    const m = med();
    const now = at(5, 8, 5);
    expect(dueReminders([m], [], now, new Map()).length).toBe(1);
    const k = doseKey('m1', at(5, 8));
    expect(dueReminders([m], [], now, new Map([[k, now + 5 * MIN]])).length).toBe(0);
    expect(dueReminders([m], [log('m1', at(5, 8), now)], now, new Map()).length).toBe(0);
  });
});

describe('statistics', () => {
  it('bootstrap intervals contain the true difference and widen with correction', () => {
    const a = [5, 6, 7, 6, 5, 7, 6, 8, 6, 5], b = [2, 3, 2, 4, 3, 2, 3, 2, 3, 4];
    const iv = bootstrapDiff(a, b);
    expect(iv.estimate).toBeCloseTo(3.3);
    expect(iv.lo).toBeGreaterThan(2);
    expect(iv.hi).toBeLessThan(4.5);
    const wide = bootstrapDiff(a, b, correctedLevel(5));
    expect(wide.hi - wide.lo).toBeGreaterThan(iv.hi - iv.lo);
    expect(verdictOf(iv, true)).toBe('higher');
    expect(verdictOf(bootstrapMean([1, -1, 2, -2, 0.5, -0.5]), true)).toBe('no-clear-difference');
    expect(verdictOf(iv, false)).toBe('not-enough-data');
    expect(hedgesG(a, b)).toBeGreaterThan(2);
  });
});

// a synthetic history: monitored 08:00-20:00 for 20 days; tremor 20 % of the time for 2 h after coffee, 5 % otherwise
function history(days = 20, coffeeEffect = true) {
  const sessions: Session[] = [], episodes: Episode[] = [], tags: Tag[] = [];
  for (let d = 1; d <= days; d++) {
    const s0 = at(d, 8), s1 = at(d, 20);
    sessions.push({ id: 's' + d, source: 'serial', demo: false, start: s0, end: s1, open: false, monitoredS: (s1 - s0) / 1000, tremorS: 0, walkingS: 0, episodes: 0, frames: 0, sensitivity: 2 });
    const coffee = at(d, 9);
    const hasCoffee = d % 2 === 0;                     // coffee on even days only, so other days give a same-time baseline
    if (hasCoffee) tags.push({ id: 't' + d, t: coffee, kind: 'coffee', label: null, demo: false });
    for (let t = s0; t < s1; t += 10 * MIN) {
      const inCoffee = coffeeEffect && hasCoffee && t >= coffee + 30 * MIN && t < coffee + 180 * MIN;
      const dur = (inCoffee ? 0.2 : 0.05) * 10 * 60 * (0.8 + 0.4 * ((t / MIN) % 7) / 7);
      episodes.push({ id: `e${d}-${t}`, sessionId: 's' + d, source: 'serial', demo: false, start: t, end: t + dur * 1000, durationS: dur, axis: 2, axisShare: [0, 0, 1], ampDps: 8, peakAmpDps: 10, freqHz: 5.2, q: 0.8, cycles: 7, walkingFrac: 0, bpm: 75, displacementDeg: 0.25, score: 4, scoreVersion: 2, sensitivity: 2 });
    }
  }
  return { sessions, episodes, tags };
}

describe('tag comparisons', () => {
  it('measures share of monitored time in a window', () => {
    const h = history(2);                                // day 2 has coffee at 09:00
    const w = windowStat(at(2, 10), at(2, 11), h.sessions, h.episodes)!;
    expect(w.share).toBeGreaterThan(0.15);
    expect(windowStat(at(1, 21), at(1, 22), h.sessions, h.episodes)).toBeNull();     // not monitored
  });

  it('finds higher tremor after coffee, with counts and an interval', () => {
    const h = history();
    const [c] = compareTags(h.tags, h.sessions, h.episodes);
    expect(c.key).toBe('coffee');
    expect(c.nAfter).toBe(10);
    expect(c.nBase).toBe(10);                           // the 10 coffee-free days, same time of day
    expect(c.verdict).toBe('higher');
    expect(c.diff!.estimate).toBeGreaterThan(10);
  });

  it('says no clear difference when there is none, and not enough data with few tags', () => {
    const h = history(20, false);
    expect(compareTags(h.tags, h.sessions, h.episodes)[0].verdict).toBe('no-clear-difference');
    const few = history(6);
    expect(compareTags(few.tags, few.sessions, few.episodes)[0].verdict).toBe('not-enough-data');
  });
});

describe('medication effect (paired before / after)', () => {
  it('detects lower tremor after doses, and needs enough paired doses', () => {
    const h = history(20, false);
    // make the 3 h after each 12:00 dose quieter
    const logs: DoseLog[] = [];
    for (let d = 1; d <= 20; d++) logs.push(log('m1', at(d, 12), at(d, 12)));
    const quiet = h.episodes.map((e) => (e.start >= at(new Date(e.start).getDate(), 12, 30) && e.start < at(new Date(e.start).getDate(), 15) ? { ...e, end: e.start + 5000, durationS: 5 } : e));
    const [r] = medicationEffects([med({ times: ['12:00'] })], logs, h.sessions, quiet);
    expect(r.nPaired).toBe(20);
    expect(r.verdict).toBe('lower');
    const [few] = medicationEffects([med({ times: ['12:00'] })], logs.slice(0, 3), h.sessions, quiet);
    expect(few.verdict).toBe('not-enough-data');
  });
});

describe('heart rate around episodes', () => {
  it('compares heart rate during episodes with same-day resting values', () => {
    const h = history(10, false);
    const resting = Array.from({ length: 10 }, (_, i) => ({ id: 'v' + i, sessionId: 's' + (i + 1), t: at(i + 1, 10), demo: false, bpm: 65, spo2: 97, validShare: 1, bpmIqr: 2, motionDeg: 0.2, restedS: 200, quality: 'good' as const }));
    const r = heartRateLink(h.episodes, resting, []);
    expect(r.during.verdict).toBe('higher');
    expect(r.during.diff!.estimate).toBeCloseTo(10, 0);
    expect(r.before.verdict).toBe('not-enough-data');
  });
});

describe('pattern hints', () => {
  it('describes a regular no-no pattern with evidence and confidence', () => {
    const h = history(10, false);
    const r = hints(h.episodes, 10, []);
    expect(r.enough).toBe(true);
    const ids = r.hints.map((x) => x.id);
    expect(ids).toContain('regular-horizontal');
    const hz = r.hints.find((x) => x.id === 'regular-horizontal')!;
    expect(hz.text).toContain('5.2 Hz');
    expect(hz.confidence).toBe('high');
    expect(hz.evidence.length).toBeGreaterThan(1);
    expect(hz.mention).toBe(true);
  });

  it('says nothing below the minimum number of episodes', () => {
    expect(hints(history(1).episodes.slice(0, 3), 1, []).enough).toBe(false);
  });

  it('never names a disease and every rule is flagged for clinical review', () => {
    const banned = /essential|parkinson|dystoni|multiple sclerosis|cerebell|diagnos|disease|disorder/i;
    for (const r of HINT_RULES) {
      expect(r.text).not.toMatch(banned);
      expect(r.review).toBe('needs-clinical-review');
      expect(r.source.length).toBeGreaterThan(20);
    }
  });
});
