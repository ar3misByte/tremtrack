// Posture relative to a calibrated neutral head pose, and stillness per second.
// Thresholds: config/thresholds.ts (POSTURE). The board is treated as head-mounted, but mounting differs
// between people, so everything is relative to the user's own calibrated neutral pose.
//   forward > 0  = head forward / chin down,  forward < 0 = chin up
//   tilt    > 0  = tilted towards the right shoulder (after axis mapping)
import { POSTURE } from '../config/thresholds';
import type { Frame } from './csv';
import { applyMapping, DEFAULT_MAPPING, type AxisMapping } from './orientation';

export type PostureConfig = typeof POSTURE;
export interface NeutralPose { pitch: number; roll: number; t: number }
export type MotionState = 'still' | 'normal' | 'restless' | 'walking';
export type PoseZone = 'ok' | 'forward' | 'back' | 'tilt';

/** Collects a few seconds of still frames and returns the neutral pose, or why it failed. */
export class PoseCalibrator {
  private p: number[] = [];
  private r: number[] = [];
  private t0: number | null = null;
  constructor(private readonly mapping: AxisMapping = DEFAULT_MAPPING, private readonly c: PostureConfig = POSTURE) {}

  push(f: Frame, t: number): { state: 'collecting'; progress: number } | { state: 'done'; pose: NeutralPose } | { state: 'failed'; reason: string } {
    if (this.t0 === null) this.t0 = t;
    const m = applyMapping(f, this.mapping);
    this.p.push(m.pitch); this.r.push(m.roll);
    const el = (t - this.t0) / 1000;
    if (f.walking || f.tremor) return { state: 'failed', reason: f.walking ? 'Walking was detected. Sit or stand still and try again.' : 'Shaking was detected. Try again when it settles.' };
    if (el < this.c.calibrateS) return { state: 'collecting', progress: Math.min(1, el / this.c.calibrateS) };
    const spread = Math.max(range(this.p), range(this.r));
    if (spread > this.c.calibrateMaxSpreadDeg) return { state: 'failed', reason: `The head moved ${spread.toFixed(1)}° while calibrating. Hold still and try again.` };
    return { state: 'done', pose: { pitch: mean(this.p), roll: mean(this.r), t } };
  }
}

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
const range = (x: number[]) => (x.length ? Math.max(...x) - Math.min(...x) : 0);

export function deviation(pitch: number, roll: number, neutral: NeutralPose, mapping: AxisMapping = DEFAULT_MAPPING) {
  const m = applyMapping({ pitch, roll, yaw: 0 }, mapping);
  return { forward: -(m.pitch - neutral.pitch), tilt: m.roll - neutral.roll };
}

export function zoneOf(dev: { forward: number; tilt: number }, c: PostureConfig = POSTURE): PoseZone {
  if (dev.forward > c.droopMaxDeg) return 'forward';
  if (-dev.forward > c.backMaxDeg) return 'back';
  if (Math.abs(dev.tilt) > c.tiltMaxDeg) return 'tilt';
  return 'ok';
}

export function motionState(s: { motionDeg: number; walkingFrac: number }, c: PostureConfig = POSTURE): MotionState {
  if (s.walkingFrac >= 0.5) return 'walking';
  if (s.motionDeg <= c.stillMaxDeg) return 'still';
  if (s.motionDeg >= c.restlessMinDeg) return 'restless';
  return 'normal';
}

/** Raises a gentle prompt after a sustained deviation; then stays quiet for the cooldown. */
export class PosturePrompter {
  private win: { t: number; out: PoseZone }[] = [];
  private quietUntil = 0;
  constructor(private readonly c: PostureConfig = POSTURE) {}

  /** One call per second. Returns the zone to prompt about, or null. */
  push(t: number, zone: PoseZone | null): PoseZone | null {
    this.win.push({ t, out: zone ?? 'ok' });
    while (this.win.length && this.win[0].t <= t - this.c.promptAfterS * 1000) this.win.shift();
    if (t < this.quietUntil || this.win.length < this.c.promptAfterS * 0.9) return null;
    const counts = new Map<PoseZone, number>();
    for (const w of this.win) if (w.out !== 'ok') counts.set(w.out, (counts.get(w.out) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['ok' as PoseZone, 0];
    if (top === 'ok' || n / this.win.length < this.c.promptMinShare) return null;
    this.quietUntil = t + this.c.promptCooldownS * 1000;
    this.win = [];
    return top;
  }
}

export const PROMPT_TEXT: Record<Exclude<PoseZone, 'ok'>, string> = {
  forward: 'Your head has been forward of your usual position for a couple of minutes. A gentle reminder to sit up, if that feels comfortable.',
  back: 'Your head has been tilted back for a couple of minutes. A gentle reminder to rest it in a neutral position, if that feels comfortable.',
  tilt: 'Your head has been tilted to one side for a couple of minutes. A gentle reminder to straighten up, if that feels comfortable.',
};
