// Head orientation for display: recentering, axis mapping, tremor exaggeration and a quaternion
// for the 3D model. Pure functions, no three.js, so they can be unit-tested.
//
// Device convention (firmware): pitch = rotation about the board's X axis ("yes-yes"),
// roll = about Y (ear-to-shoulder tilt), yaw = about Z ("no-no").
// Model convention (three.js): Y up, the face looks down +Z, so
//   nod   = rotation about X,  tilt = rotation about Z,  turn = rotation about Y.

export interface Euler3 { pitch: number; roll: number; yaw: number }   // degrees
export type Quat = [number, number, number, number];                    // x, y, z, w

export interface AxisMapping {
  flipPitch: boolean;
  flipRoll: boolean;
  flipYaw: boolean;
  swapPitchRoll: boolean;    // board mounted rotated 90 degrees on the head
}

export const DEFAULT_MAPPING: AxisMapping = { flipPitch: false, flipRoll: false, flipYaw: false, swapPitchRoll: false };

const D2R = Math.PI / 180;

export function wrap180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export function applyMapping(a: Euler3, m: AxisMapping): Euler3 {
  let pitch = a.pitch, roll = a.roll;
  if (m.swapPitchRoll) [pitch, roll] = [roll, pitch];
  return {
    pitch: m.flipPitch ? -pitch : pitch,
    roll: m.flipRoll ? -roll : roll,
    yaw: m.flipYaw ? -a.yaw : a.yaw,
  };
}

export function relativeTo(a: Euler3, zero: Euler3): Euler3 {
  return { pitch: a.pitch - zero.pitch, roll: a.roll - zero.roll, yaw: wrap180(a.yaw - zero.yaw) };
}

/**
 * Exaggerates the fast (tremor) part of the motion so small shakes are visible, the same way the
 * legacy page did: a ~1.8 Hz low-pass tracks the slow pose, and the residual is multiplied.
 * Call once per incoming frame (50 Hz). boost = 1 shows the true motion.
 */
export class Exaggerator {
  private lp: Euler3 | null = null;
  constructor(private readonly alpha = 0.2) {}
  reset() { this.lp = null; }
  step(a: Euler3, boost: number): Euler3 {
    if (!this.lp) this.lp = { ...a };
    const lp = this.lp;
    const out = { ...a };
    for (const k of ['pitch', 'roll', 'yaw'] as const) {
      lp[k] += (a[k] - lp[k]) * this.alpha;
      out[k] = a[k] + (boost - 1) * (a[k] - lp[k]);
    }
    return out;
  }
}

function axisAngle(x: number, y: number, z: number, rad: number): Quat {
  const s = Math.sin(rad / 2);
  return [x * s, y * s, z * s, Math.cos(rad / 2)];
}

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qnormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Model-space head rotation: turn (yaw) first, then nod (pitch), then tilt (roll). */
export function headQuaternion(a: Euler3): Quat {
  const qYaw = axisAngle(0, 1, 0, a.yaw * D2R);
  const qPitch = axisAngle(1, 0, 0, -a.pitch * D2R);    // positive pitch = chin up -> negative X rotation in three.js
  const qRoll = axisAngle(0, 0, 1, -a.roll * D2R);
  return qnormalize(qmul(qmul(qYaw, qPitch), qRoll));
}

/** Spherical interpolation, shortest path. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    return qnormalize([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  }
  const th = Math.acos(cos), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Frame-rate independent smoothing factor for a time constant tau (s). */
export function smoothingFactor(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}

/** Rotates a vector by a quaternion (used in tests and for the 2D view). */
export function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const p: Quat = [v[0], v[1], v[2], 0];
  const qc: Quat = [-q[0], -q[1], -q[2], q[3]];
  const r = qmul(qmul(q, p), qc);
  return [r[0], r[1], r[2]];
}
