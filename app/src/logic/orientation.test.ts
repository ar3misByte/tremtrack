import { describe, expect, it } from 'vitest';
import { applyMapping, DEFAULT_MAPPING, Exaggerator, headQuaternion, relativeTo, rotate, slerp, smoothingFactor, wrap180, YawHold } from './orientation';

const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 5));

describe('headQuaternion', () => {
  it('is the identity at zero', () => {
    close(headQuaternion({ pitch: 0, roll: 0, yaw: 0 }), [0, 0, 0, 1]);
  });
  it('yaw +90 turns the face (+Z) towards +X', () => {
    close(rotate(headQuaternion({ pitch: 0, roll: 0, yaw: 90 }), [0, 0, 1]), [1, 0, 0]);
  });
  it('pitch +30 lifts the chin: the face direction points up', () => {
    const f = rotate(headQuaternion({ pitch: 30, roll: 0, yaw: 0 }), [0, 0, 1]);
    expect(f[1]).toBeCloseTo(Math.sin(30 * Math.PI / 180), 6);
  });
  it('roll moves the top of the head sideways and leaves the face direction alone', () => {
    const q = headQuaternion({ pitch: 0, roll: 20, yaw: 0 });
    close(rotate(q, [0, 0, 1]), [0, 0, 1]);
    expect(Math.abs(rotate(q, [0, 1, 0])[0])).toBeCloseTo(Math.sin(20 * Math.PI / 180), 6);
  });
  it('stays unit length and has no gimbal blow-up at pitch 90', () => {
    const q = headQuaternion({ pitch: 90, roll: 45, yaw: 170 });
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(q.every(Number.isFinite)).toBe(true);
  });
});

describe('slerp and smoothing', () => {
  it('interpolates halfway along the shortest arc', () => {
    const a = headQuaternion({ pitch: 0, roll: 0, yaw: 0 });
    const b = headQuaternion({ pitch: 0, roll: 0, yaw: 90 });
    close(rotate(slerp(a, b, 0.5), [0, 0, 1]), [Math.SQRT1_2, 0, Math.SQRT1_2]);
  });
  it('takes the short way across the +/-180 seam', () => {
    const a = headQuaternion({ pitch: 0, roll: 0, yaw: 179 });
    const b = headQuaternion({ pitch: 0, roll: 0, yaw: -179 });
    const m = rotate(slerp(a, b, 0.5), [0, 0, 1]);
    close(m, [0, 0, -1]);
  });
  it('smoothing factor is frame-rate independent', () => {
    const one = smoothingFactor(1 / 30, 0.05);
    const twoHalves = 1 - (1 - smoothingFactor(1 / 60, 0.05)) ** 2;
    expect(one).toBeCloseTo(twoHalves, 9);
  });
});

describe('recenter, mapping, exaggeration', () => {
  it('recenters and wraps yaw', () => {
    expect(relativeTo({ pitch: 10, roll: 5, yaw: -170 }, { pitch: 10, roll: 5, yaw: 170 })).toEqual({ pitch: 0, roll: 0, yaw: 20 });
    expect(wrap180(540)).toBe(180);
    expect(wrap180(-190)).toBe(170);
  });
  it('flips and swaps axes', () => {
    expect(applyMapping({ pitch: 1, roll: 2, yaw: 3 }, { ...DEFAULT_MAPPING, swapPitchRoll: true, flipYaw: true })).toEqual({ pitch: 2, roll: 1, yaw: -3 });
  });
  it('boost 1 shows the true motion; boost > 1 enlarges only the fast part', () => {
    const ex = new Exaggerator();
    const still = { pitch: 10, roll: 0, yaw: 0 };
    for (let i = 0; i < 200; i++) ex.step(still, 4);
    expect(ex.step(still, 4).pitch).toBeCloseTo(10, 6);          // a held pose is not exaggerated
    const jolt = ex.step({ pitch: 11, roll: 0, yaw: 0 }, 4);
    expect(jolt.pitch).toBeGreaterThan(11);                        // a sudden change is
    const plain = new Exaggerator();
    expect(plain.step({ pitch: 3, roll: 2, yaw: 1 }, 1)).toEqual({ pitch: 3, roll: 2, yaw: 1 });
  });
});

describe('YawHold (drift removal while the head is still)', () => {
  const run = (rateAt: (t: number) => number, seconds: number, hold = new YawHold()) => {
    let yaw = 0, shown = 0;
    const shownAt: number[] = [];
    for (let i = 0; i < seconds * 50; i++) {
      const t = i / 50;
      yaw += rateAt(t) * 0.02;
      shown = yaw - hold.step(yaw, 0.02);
      shownAt.push(shown);
    }
    return { yaw, shown, shownAt };
  };

  it('keeps a still head still while the gyro drifts', () => {
    const r = run(() => 0.4, 120);                      // 0.4 deg/s of drift: 48 degrees in two minutes
    expect(r.yaw).toBeCloseTo(48);
    expect(Math.abs(r.shown)).toBeLessThan(1);
  });

  it('lets a real turn through almost untouched, then holds the new direction', () => {
    // 3 s still, a 40 degree turn in half a second, 5 s still
    const r = run((t) => (t >= 3 && t < 3.5 ? 80 : 0.3), 8.5);
    expect(r.shownAt[Math.floor(3.5 * 50) + 5]).toBeGreaterThan(36);       // the turn is seen
    expect(Math.abs(r.shown - 40)).toBeLessThan(4);                        // and it stays about where it ended, not creeping on
  });

  it('lets a deliberate slow turn through (3 degrees per second)', () => {
    const r = run(() => 3, 10);
    expect(r.shown).toBeGreaterThan(27);
  });

  it('handles the wrap at 180 degrees', () => {
    const hold = new YawHold();
    let yaw = 170;
    for (let i = 0; i < 1000; i++) { yaw = ((yaw + 0.01 + 180) % 360) - 180; hold.step(yaw, 0.02); }
    expect(hold.offset).toBeGreaterThan(9);
    expect(hold.offset).toBeLessThan(11);
  });

  it('starts over after reset', () => {
    const hold = new YawHold();
    for (let i = 0; i < 200; i++) hold.step(i * 0.005, 0.02);
    expect(hold.offset).toBeGreaterThan(0);
    hold.reset();
    expect(hold.offset).toBe(0);
  });
});
