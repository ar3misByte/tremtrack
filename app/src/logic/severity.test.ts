import { describe, expect, it } from 'vitest';
import { dailyScore, displacementDeg, episodeScore, scoreBand } from './severity';
import { SEVERITY } from '../config/thresholds';

// deterministic pseudo-random for property tests
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe('displacementDeg', () => {
  it('is A / (2 pi f)', () => {
    expect(displacementDeg(2 * Math.PI * 5, 5)).toBeCloseTo(1, 9);
    expect(displacementDeg(0, 5)).toBe(0);
    expect(displacementDeg(10, 0)).toBe(0);
  });
});

describe('episodeScore', () => {
  it('worked examples (documented in docs/SEVERITY.md)', () => {
    expect(episodeScore({ ampDps: 3, freqHz: 5, durationS: 5 }).score).toBeCloseTo(2.37, 1);
    expect(episodeScore({ ampDps: 15, freqHz: 5, durationS: 30 }).score).toBeCloseTo(5.23, 1);
    expect(episodeScore({ ampDps: 60, freqHz: 4, durationS: 300 }).score).toBeCloseTo(8.90, 1);
  });

  it('is capped at 10 and floored at 0', () => {
    expect(episodeScore({ ampDps: 1e6, freqHz: 3.5, durationS: 1e6 }).score).toBe(10);
    expect(episodeScore({ ampDps: 0, freqHz: 5, durationS: 0 }).score).toBe(0);
    expect(episodeScore({ ampDps: -5, freqHz: 5, durationS: -3 }).score).toBe(0);
  });

  it('never decreases with amplitude or duration, and rises as frequency falls (fixed rate)', () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const e = { ampDps: r() * 80, freqHz: 3.5 + r() * 5, durationS: r() * 600 };
      const s = episodeScore(e).score;
      expect(episodeScore({ ...e, ampDps: e.ampDps + r() * 10 }).score).toBeGreaterThanOrEqual(s - 1e-12);
      expect(episodeScore({ ...e, durationS: e.durationS + r() * 60 }).score).toBeGreaterThanOrEqual(s - 1e-12);
      expect(episodeScore({ ...e, freqHz: Math.max(0.1, e.freqHz - r()) }).score).toBeGreaterThanOrEqual(s - 1e-12);
    }
  });
});

describe('dailyScore', () => {
  const hour = 3600;
  it('says "not enough data" below the monitored-time minimum', () => {
    const d = dailyScore({ episodes: [{ ampDps: 10, freqHz: 5, durationS: 20 }], monitoredS: SEVERITY.minMonitoredS - 1 });
    expect(d.score).toBeNull();
    expect(d.reason).toBe('not-enough-data');
    expect(scoreBand(d.score)).toBe('Not enough data');
  });

  it('is 0 for a monitored day without episodes', () => {
    expect(dailyScore({ episodes: [], monitoredS: hour }).score).toBe(0);
  });

  it('reports share of time and burden', () => {
    const d = dailyScore({ episodes: [{ ampDps: 15, freqHz: 5, durationS: 36 }], monitoredS: hour });
    expect(d.shareShaking).toBeCloseTo(0.01, 9);
    expect(d.burden).toBeGreaterThan(0);
    expect(d.score).toBeGreaterThan(0);
  });

  it('never decreases when an episode is added, lengthened or strengthened (fixed monitored time)', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const eps = Array.from({ length: 1 + Math.floor(r() * 8) }, () => ({ ampDps: r() * 40, freqHz: 3.5 + r() * 5, durationS: r() * 120 }));
      const T = 2 * hour;
      const s = dailyScore({ episodes: eps, monitoredS: T }).score!;
      const added = [...eps, { ampDps: r() * 5, freqHz: 3.5 + r() * 5, durationS: 1 + r() * 10 }];
      expect(dailyScore({ episodes: added, monitoredS: T }).score!).toBeGreaterThanOrEqual(s - 1e-12);
      const k = Math.floor(r() * eps.length);
      const longer = eps.map((e, j) => (j === k ? { ...e, durationS: e.durationS + 10 } : e));
      expect(dailyScore({ episodes: longer, monitoredS: T }).score!).toBeGreaterThanOrEqual(s - 1e-12);
      const stronger = eps.map((e, j) => (j === k ? { ...e, ampDps: e.ampDps * 1.5 } : e));
      expect(dailyScore({ episodes: stronger, monitoredS: T }).score!).toBeGreaterThanOrEqual(s - 1e-12);
    }
  });

  it('is capped at 10 when shaking fills the whole day', () => {
    expect(dailyScore({ episodes: [{ ampDps: 200, freqHz: 4, durationS: hour }], monitoredS: hour }).score).toBe(10);
  });
});
