// Synthetic device stream for demo mode and the device simulator.
// Produces protocol lines (same format as the firmware, including the axes mask and |a| extremes) so
// everything downstream goes through the real parser. It imitates the firmware's behaviour, including
// its ~1.7 s detection delay and 0.5 s release, but it is NOT the firmware's detector: the host
// simulator (tools/hostsim) is.
import { formatLine, type Axis } from './csv';

export interface DemoControls {
  tremorAxes: Axis[];          // [] = no tremor; the first axis is the strongest
  tremorHz: number;
  tremorDps: number;           // peak angular rate of the strongest axis (others at 80 %)
  comboPhaseDeg: number;       // phase of the other axes relative to the first: 0 diagonal, 90 circular
  walking: boolean;
  finger: boolean;             // fingertip on the PPG sensor
  droopDeg: number;            // head held forward (chin down) by this much: posture demo
  still: boolean;              // hold the head still: no slow wandering
  fall: boolean;               // a fall happens when this turns on; lying still while it stays on
  pointer: { x: number; y: number } | null;   // -1..1 steering in the demo UI, null = slow wandering
}

export const DEFAULT_CONTROLS: DemoControls = {
  tremorAxes: [], tremorHz: 5.2, tremorDps: 14, comboPhaseDeg: 0, walking: false, finger: true,
  droopDeg: 0, still: false, fall: false, pointer: null,
};

const ON_DELAY_S = 1.7;        // firmware: 1.5 s window + 2 analysis ticks
const OFF_DELAY_S = 0.5;       // firmware: 5 missed ticks
const STEP_HZ = 1.9;
const FREEFALL_S = 0.35, IMPACT_G = 6.5, LYING_PITCH = 80;

export class DemoGenerator {
  private pose = { x: 0, y: 0 };
  private tremorSince: number | null = null;
  private tremorStopped: number | null = null;
  private lastAxes: Axis[] = [0];
  private fingerSince = 0;
  private hadFinger = true;
  private t0: number | null = null;
  private beat = 0;
  private lastT = 0;
  private noise = 1;
  private fallSince: number | null = null;
  private droop = 0;

  private rnd() { this.noise = (this.noise * 16807) % 2147483647; return this.noise / 1073741823.5 - 1; }

  /** t = seconds (any monotonic clock). Returns one protocol line. */
  next(tAbs: number, c: DemoControls): string {
    if (this.t0 === null) this.t0 = tAbs;
    const t = tAbs - this.t0;
    const dt = Math.max(0, t - this.lastT);

    // slow pose: wander, hold still, or follow the pointer
    const R = 25;
    const quiet = c.still || c.fall;
    const bx = c.pointer ? c.pointer.x * R * 0.95 : quiet ? 0 : Math.sin(t * 0.6) * R * 0.45;
    const by = c.pointer ? c.pointer.y * R * 0.95 : quiet ? 0 : Math.sin(t * 0.45 + 1.2) * R * 0.35;
    this.pose.x += (bx - this.pose.x) * 0.15;
    this.pose.y += (by - this.pose.y) * 0.15;
    this.droop += (c.droopDeg - this.droop) * Math.min(1, dt * 1.5);
    const ang = [this.pose.y - this.droop, this.pose.x, quiet ? 0 : Math.sin(t * 0.3) * 20];
    const gyro = [this.rnd() * 0.25, this.rnd() * 0.25, this.rnd() * 0.25];   // sensor noise after the band-pass
    const amp = [0.3, 0.3, 0.3];
    let aMax = 1 + 0.02 * Math.abs(this.rnd()), aMin = 1 - 0.02 * Math.abs(this.rnd());

    if (c.walking && !c.fall) {
      const p = 2 * Math.PI * STEP_HZ * t;
      ang[0] += 2.0 * Math.sin(p); ang[1] += 1.5 * Math.sin(p / 2); ang[2] += 3 * Math.sin(p / 2 + 1);
      gyro[0] = 2.0 * 2 * Math.PI * STEP_HZ * Math.cos(p);
      amp[0] = 1.2;                                   // step bounce is filtered out of the tremor band by the firmware
      aMax = 1.22 + 0.05 * Math.sin(p); aMin = 0.8 - 0.05 * Math.sin(p);
    }

    // fall: free fall, impact, then lying still (pitched over) until the control turns off
    if (c.fall) {
      if (this.fallSince === null) this.fallSince = t;
      const s = t - this.fallSince;
      const k = Math.min(1, s / FREEFALL_S);
      ang[0] = ang[0] * (1 - k) + LYING_PITCH * k;
      if (s < FREEFALL_S) { aMax = 0.15; aMin = 0.06; }
      else if (s < FREEFALL_S + 0.06) { aMax = IMPACT_G; aMin = 0.9; }
    } else this.fallSince = null;

    // tremor motion and the firmware-like detection flag
    let flag = false;
    let freq = 0, q = 0.2, cycles = 0;
    const axes = c.fall ? [] : c.tremorAxes;
    if (axes.length) {
      if (this.tremorSince === null) this.tremorSince = t;
      this.tremorStopped = null;
      this.lastAxes = axes;
      const f = c.tremorHz;
      const w = 2 * Math.PI * f;
      const A0 = c.tremorDps * (1 + 0.15 * Math.sin(t * 1.3));
      const ramp = Math.min(1, (t - this.tremorSince) / ON_DELAY_S);
      axes.forEach((d, i) => {
        const A = i === 0 ? A0 : 0.8 * A0;
        const ph = i === 0 ? 0 : (c.comboPhaseDeg * Math.PI) / 180;
        ang[d] += (A / w) * Math.sin(w * t + ph);
        gyro[d] += A * Math.cos(w * t + ph);
        amp[d] = A * ramp;
      });
      flag = t - this.tremorSince >= ON_DELAY_S;
      if (flag) { freq = f + 0.15 * Math.sin(t * 2); q = 0.85; cycles = 7; }
    } else {
      if (this.tremorSince !== null && this.tremorStopped === null) this.tremorStopped = t;
      if (this.tremorStopped !== null && this.tremorSince !== null && t - this.tremorSince >= ON_DELAY_S && t - this.tremorStopped < OFF_DELAY_S) {
        flag = true; freq = c.tremorHz; q = 0.6; cycles = 4;
      } else { this.tremorSince = null; }
    }

    // heart rate / SpO2: measuring for 8 s after the finger arrives, as on the device
    if (c.finger && !this.hadFinger) this.fingerSince = t;
    this.hadFinger = c.finger;
    const ppgState = !c.finger ? 1 : t - this.fingerSince < 8 ? 2 : 3;
    const bpmNow = 72 + 3 * Math.sin(t * 0.2) + (flag ? 4 : 0);
    this.beat += dt * (bpmNow / 60);                  // integrate the phase so a rate change does not jump
    this.lastT = t;
    const ph = 2 * Math.PI * this.beat;
    const pulse = c.finger ? 60 * (Math.sin(ph) + 0.35 * Math.sin(2 * ph + 1)) : 0;

    const dir = (flag ? this.lastAxes[0] : amp.indexOf(Math.max(...amp))) as Axis;
    const mask = flag ? this.lastAxes.reduce<number>((m, a) => m | (1 << a), 0) : 0;
    return formatLine({
      pitch: ang[0], roll: ang[1], yaw: ang[2], fPitch: gyro[0], fRoll: gyro[1], fYaw: gyro[2],
      tremor: flag, dir, ampP: amp[0], ampR: amp[1], ampY: amp[2], freq, q,
      walking: c.walking && !c.fall, stepHz: c.walking && !c.fall ? STEP_HZ : 0, cycles,
      bpm: ppgState === 3 ? bpmNow : 0, spo2: ppgState === 3 ? 97 : 0, ppgState, pulse,
      axes: mask, aMax, aMin,
    });
  }
}

// ---------- scripted showcase (loops) ----------
export interface ScriptStep { at: number; label: string; set: Partial<DemoControls> }

export const SHOWCASE: { length: number; steps: ScriptStep[] } = {
  length: 160,
  steps: [
    { at: 0, label: 'Sitting still', set: { tremorAxes: [], walking: false, finger: true, droopDeg: 0, still: false, fall: false } },
    { at: 10, label: "'No-no' tremor, about 5 Hz", set: { tremorAxes: [2], tremorHz: 5.2, tremorDps: 14 } },
    { at: 25, label: 'Tremor stops', set: { tremorAxes: [] } },
    { at: 32, label: 'Walking (ignored by the detector)', set: { walking: true } },
    { at: 50, label: 'Stops walking', set: { walking: false } },
    { at: 55, label: "'Yes-yes' and 'no-no' together (diagonal)", set: { tremorAxes: [2, 0], tremorHz: 4.8, tremorDps: 12, comboPhaseDeg: 0 } },
    { at: 70, label: 'Tremor stops', set: { tremorAxes: [] } },
    { at: 76, label: 'Head held forward and still (posture)', set: { droopDeg: 22, still: true } },
    { at: 100, label: 'Sits up again', set: { droopDeg: 0, still: false } },
    { at: 104, label: 'Finger off the pulse sensor', set: { finger: false } },
    { at: 114, label: 'Finger back on', set: { finger: true } },
    { at: 126, label: 'A fall: free fall, impact, lying still', set: { fall: true } },
    { at: 150, label: 'Gets up', set: { fall: false } },
  ],
};

export function scriptAt(t: number, script = SHOWCASE): { controls: DemoControls; label: string } {
  const tt = ((t % script.length) + script.length) % script.length;
  let controls = { ...DEFAULT_CONTROLS };
  let label = '';
  for (const s of script.steps) {
    if (s.at > tt) break;
    controls = { ...controls, ...s.set };
    label = s.label;
  }
  return { controls, label };
}
