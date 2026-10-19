import { describe, expect, it } from 'vitest';
import { applyMapping, DEFAULT_MAPPING, Exaggerator, headQuaternion, relativeTo, rotate, slerp, smoothingFactor, wrap180 } from './orientation';

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
