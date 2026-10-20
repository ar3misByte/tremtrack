import { describe, expect, it } from 'vitest';
import { FallDetector, type FallCandidate } from './fall';
import { loadFixture, sceneS } from './fixtures';
import type { Frame } from './csv';

function detect(name: string): FallCandidate[] {
  const d = new FallDetector();
  const out: FallCandidate[] = [];
  for (const { t, frame } of loadFixture(name)) { const c = d.push(frame, t); if (c) out.push(c); }
  return out;
}

// Real firmware output (the +/-8 g build) from the host simulator.
describe('FallDetector on firmware recordings', () => {
  it('flags a fall with free fall and a 9 g impact, and reports how the head turned over', () => {
    const c = detect('fall');
    expect(c).toHaveLength(1);
    expect(c[0].path).toBe('freefall+impact');
    expect(sceneS(c[0].t)).toBeCloseTo(10.35, 0);
    expect(c[0].peakG).toBeGreaterThan(6);
    expect(c[0].freeFallMs).toBeGreaterThanOrEqual(200);
    expect(c[0].orientationChangeDeg).toBeGreaterThan(60);
  });

  it('flags a trip without free fall (hard impact, then lying still)', () => {
    const c = detect('fall_trip');
    expect(c).toHaveLength(1);
    expect(c[0].path).toBe('impact');
  });

  it('flags the headset being dropped: a known, documented false alarm', () => {
    expect(detect('headset_dropped')).toHaveLength(1);
  });

  it.each(['sit_down_hard', 'jump_while_walking', 'voluntary_turns', 'walk_2.8', 'combo_yes_no_diag'])('does not flag %s', (name) => {
    expect(detect(name)).toHaveLength(0);
  });
});

describe('FallDetector rules', () => {
  const frame = (aMax: number, aMin: number, pitch = 0) => ({ pitch, roll: 0, aMax, aMin }) as unknown as Frame;

  it('is disabled for firmware without |a| extremes', () => {
    const d = new FallDetector();
    expect(d.push({ pitch: 0, roll: 0, aMax: null, aMin: null } as unknown as Frame, 0)).toBeNull();
    expect(d.supported).toBe(false);
  });

  it('needs stillness after the impact', () => {
    const d = new FallDetector();
    let hit: FallCandidate | null = null;
    for (let i = 0; i < 300; i++) {
      const f = i === 100 ? frame(6, 1) : i > 100 ? frame(1.5, 0.5) : frame(1.01, 0.99);   // keeps moving after the impact
      hit = d.push(f, i * 20) ?? hit;
    }
    expect(hit).toBeNull();
  });

  it('honours the cooldown', () => {
    const d = new FallDetector();
    const hits: FallCandidate[] = [];
    for (let i = 0; i < 600; i++) {
      const f = i === 100 || i === 300 ? frame(6, 1, 80) : frame(1.01, 0.99, i > 100 ? 80 : 0);
      const h = d.push(f, i * 20);
      if (h) hits.push(h);
    }
    expect(hits).toHaveLength(1);
  });
});
