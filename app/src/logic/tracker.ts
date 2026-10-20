// Turns the 50 Hz frame stream of one connection into a Session, Episodes and 1 Hz Samples.
// Pure and synchronous: the caller (data/recorder.ts) supplies timestamps and stores the output.
import { EPISODES, FALL, MULTIAXIS, POSTURE, RESTING, SESSIONS, SEVERITY } from '../config/thresholds';
import type { Axis, Frame } from './csv';
import { isDemoSource, type Episode, type Sample, type Session, type Source } from './model';
import { displacementDeg, episodeScore } from './severity';
import { analyzeCombined, type ComboPattern } from './multiaxis';
import { FallDetector, type FallCandidate } from './fall';
import { deviation, motionState, PosturePrompter, zoneOf, type NeutralPose, type PoseZone } from './posture';
import { RestingTracker, type RestingReading } from './vitals';
import { DEFAULT_MAPPING, type AxisMapping } from './orientation';

export interface TrackerContext {
  neutral: NeutralPose | null;
  mapping: AxisMapping;
  fall?: typeof FALL;
  posture?: typeof POSTURE;
  resting?: typeof RESTING;
}

const SIG_N = 75;          // 1.5 s of band-passed signal at 50 Hz for the combined-axis analysis

export type TrackerEvent =
  | { type: 'episode'; episode: Episode }
  | { type: 'sample'; sample: Sample }
  | { type: 'fall'; candidate: FallCandidate }
  | { type: 'resting'; reading: RestingReading }
  | { type: 'posture'; zone: Exclude<PoseZone, 'ok'> };

interface OpenEpisode {
  start: number; lastAlert: number; n: number;
  axisN: [number, number, number];
  ampSum: number; peak: number; freqSum: number; freqN: number; qSum: number; cycSum: number; walkN: number;
  bpmSum: number; bpmN: number;
  axActN: [number, number, number]; axAmpSum: [number, number, number]; axPeak: [number, number, number];
  patternN: Partial<Record<ComboPattern, number>>;
}

interface OpenSecond {
  t: number; n: number;
  p: number; r: number; y: number; p2: number; r2: number; y2: number;
  tremorN: number; amp: number; freq: number; walkN: number; axes: number;
  bpm: number | null; spo2: number | null; ppg: number;
}

let counter = 0;
export const newId = (prefix: string, t: number) => `${prefix}_${t.toString(36)}_${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class SessionTracker {
  readonly session: Session;
  private ep: OpenEpisode | null = null;
  private sec: OpenSecond | null = null;
  private lastT = 0;
  private sig: [Float64Array, Float64Array, Float64Array] = [new Float64Array(SIG_N), new Float64Array(SIG_N), new Float64Array(SIG_N)];
  private sigHead = 0;
  private sigN = 0;
  /** The most recent finished 1 s sample (with posture / motion state). */
  lastSample: Sample | null = null;
  private fall: FallDetector;
  private resting: RestingTracker;
  private prompter: PosturePrompter;

  constructor(source: Source, t: number, sensitivity: number, private ctx: TrackerContext = { neutral: null, mapping: DEFAULT_MAPPING }, id = newId('s', t)) {
    this.session = {
      id, source, demo: isDemoSource(source), start: t, end: t, open: true,
      monitoredS: 0, tremorS: 0, walkingS: 0, episodes: 0, frames: 0, sensitivity,
      stillS: 0, restlessS: 0, poseMonitoredS: 0, outsidePoseS: 0,
    };
    // thresholds are fixed for the life of a session; changes in Settings apply from the next session
    this.fall = new FallDetector(ctx.fall ?? FALL);
    this.prompter = new PosturePrompter(ctx.posture ?? POSTURE);
    this.resting = new RestingTracker(id, this.session.demo, ctx.resting ?? RESTING);
  }

  /** New neutral pose or axis mapping (posture is measured against it from now on). */
  setContext(ctx: TrackerContext) { this.ctx = { ...ctx, fall: this.ctx.fall, posture: this.ctx.posture, resting: this.ctx.resting }; }
  get fallSupported() { return this.fall.supported; }

  setSensitivity(level: number) { this.session.sensitivity = level; }

  /** Feed one frame received at time t (ms). Returns finished episodes and seconds. */
  push(f: Frame, t: number): TrackerEvent[] {
    const out: TrackerEvent[] = [];
    const s = this.session;
    if (s.frames > 0) {
      const dt = (t - this.lastT) / 1000;
      if (dt > 0 && dt <= SESSIONS.maxFrameGapS) {
        s.monitoredS += dt;
        if (f.walking) s.walkingS += dt;
      }
    }
    s.frames++;
    s.end = t;
    this.lastT = t;
    this.sig[0][this.sigHead] = f.fPitch; this.sig[1][this.sigHead] = f.fRoll; this.sig[2][this.sigHead] = f.fYaw;
    this.sigHead = (this.sigHead + 1) % SIG_N;
    this.sigN++;

    // ----- 1 Hz samples -----
    const sec = Math.floor(t / 1000) * 1000;
    if (this.sec && this.sec.t !== sec) this.second(this.sec, out);
    if (!this.sec || this.sec.t !== sec) {
      this.sec = { t: sec, n: 0, p: 0, r: 0, y: 0, p2: 0, r2: 0, y2: 0, tremorN: 0, amp: 0, freq: 0, walkN: 0, axes: 0, bpm: null, spo2: null, ppg: -1 };
    }
    const c = this.sec;
    c.n++;
    c.p += f.pitch; c.r += f.roll; c.y += f.yaw;
    c.p2 += f.pitch * f.pitch; c.r2 += f.roll * f.roll; c.y2 += f.yaw * f.yaw;
    if (f.tremor) c.tremorN++;
    c.amp = Math.max(c.amp, f.ampP, f.ampR, f.ampY);
    if (f.freq > 0) c.freq = f.freq;
    if (f.walking) c.walkN++;
    c.axes |= f.axes;
    if (f.ppgState === 3 && f.bpm > 0) { c.bpm = f.bpm; c.spo2 = f.spo2 > 0 ? f.spo2 : c.spo2; }
    c.ppg = Math.max(c.ppg, f.ppgState);

    // ----- falls / impacts -----
    const cand = this.fall.push(f, t);
    if (cand) out.push({ type: 'fall', candidate: cand });

    // ----- episodes -----
    if (f.tremor) {
      if (!this.ep) {
        this.ep = { start: t, lastAlert: t, n: 0, axisN: [0, 0, 0], ampSum: 0, peak: 0, freqSum: 0, freqN: 0, qSum: 0, cycSum: 0, walkN: 0, bpmSum: 0, bpmN: 0, axActN: [0, 0, 0], axAmpSum: [0, 0, 0], axPeak: [0, 0, 0], patternN: {} };
      }
      const e = this.ep;
      const amp = [f.ampP, f.ampR, f.ampY][f.dir];
      e.lastAlert = t;
      e.n++;
      e.axisN[f.dir]++;
      e.ampSum += amp;
      e.peak = Math.max(e.peak, amp);
      if (f.freq > 0) { e.freqSum += f.freq; e.freqN++; }
      e.qSum += f.q;
      e.cycSum += f.cycles;
      if (f.walking) e.walkN++;
      if (f.ppgState === 3 && f.bpm > 0) { e.bpmSum += f.bpm; e.bpmN++; }
      const amps = [f.ampP, f.ampR, f.ampY];
      const mask = f.axes | (1 << f.dir);
      for (let i = 0; i < 3; i++) if ((mask >> i) & 1) { e.axActN[i]++; e.axAmpSum[i] += amps[i]; e.axPeak[i] = Math.max(e.axPeak[i], amps[i]); }
      // how the axes move together: analyse the last 1.5 s about twice a second while several axes shake
      if ((mask & (mask - 1)) !== 0 && this.sigN >= SIG_N && this.sigN % 25 === 0) {
        const ordered = this.sig.map((b) => Float64Array.from({ length: SIG_N }, (_, k) => b[(this.sigHead + k) % SIG_N])) as [Float64Array, Float64Array, Float64Array];
        const p = analyzeCombined(ordered, mask).pattern;
        e.patternN[p] = (e.patternN[p] ?? 0) + 1;
      }
    } else if (this.ep && t - this.ep.lastAlert > EPISODES.mergeGapS * 1000) {
      const done = this.finishEpisode(this.ep);
      this.ep = null;
      if (done) out.push({ type: 'episode', episode: done });
    }
    return out;
  }

  /** Ends the session (disconnect or stale). Flushes the open episode and second. */
  close(): TrackerEvent[] {
    const out: TrackerEvent[] = [];
    if (this.ep) { const done = this.finishEpisode(this.ep); if (done) out.push({ type: 'episode', episode: done }); this.ep = null; }
    if (this.sec) { this.second(this.sec, out); this.sec = null; }
    this.session.open = false;
    return out;
  }

  /** The episode in progress, if any, as it would be stored now (for the live view). */
  currentEpisode(): Episode | null {
    return this.ep ? this.build(this.ep) : null;
  }

  private finishEpisode(e: OpenEpisode): Episode | null {
    const ep = this.build(e);
    if (ep.durationS < EPISODES.minDurationS) return null;
    this.session.episodes++;
    this.session.tremorS += ep.durationS;
    return ep;
  }

  private build(e: OpenEpisode): Episode {
    const s = this.session;
    const axis = (e.axisN.indexOf(Math.max(...e.axisN)) as Axis);
    const axesActiveFrac = e.axActN.map((x) => (e.n ? x / e.n : 0)) as [number, number, number];
    const ampByAxis = e.axActN.map((x, i) => (x ? e.axAmpSum[i] / x : 0)) as [number, number, number];
    const axes = ([0, 1, 2] as Axis[]).filter((i) => i === axis || axesActiveFrac[i] >= MULTIAXIS.episodeAxisMinShare);
    // one axis: mean alert-axis amplitude (as before); several: combined magnitude of the axes involved
    const ampDps = axes.length > 1 ? Math.sqrt(axes.reduce<number>((s, i) => s + ampByAxis[i] ** 2, 0)) : e.n ? e.ampSum / e.n : 0;
    let pattern: ComboPattern = 'single';
    if (axes.length > 1) {
      const counts = Object.entries(e.patternN).filter(([k]) => k !== 'single') as [ComboPattern, number][];
      pattern = counts.length ? counts.sort((a, b) => b[1] - a[1])[0][0] : 'mixed';
    }
    const freqHz = e.freqN ? e.freqSum / e.freqN : 0;
    const durationS = Math.max(0, (e.lastAlert - e.start) / 1000 + 0.02);   // + one frame
    const sc = episodeScore({ ampDps, freqHz, durationS });
    return {
      id: newId('e', e.start), sessionId: s.id, source: s.source, demo: s.demo,
      start: e.start, end: e.lastAlert, durationS, axis,
      axisShare: e.n ? (e.axisN.map((x) => x / e.n) as [number, number, number]) : [0, 0, 0],
      axes, axesActiveFrac, ampByAxis, pattern,
      ampDps, peakAmpDps: axes.length > 1 ? Math.sqrt(axes.reduce<number>((s, i) => s + e.axPeak[i] ** 2, 0)) : e.peak, freqHz, q: e.n ? e.qSum / e.n : 0, cycles: e.n ? e.cycSum / e.n : 0,
      walkingFrac: e.n ? e.walkN / e.n : 0, bpm: e.bpmN ? e.bpmSum / e.bpmN : null,
      displacementDeg: displacementDeg(ampDps, freqHz), score: sc.score, scoreVersion: SEVERITY.version, sensitivity: s.sensitivity,
    };
  }

  /** Finishes a second: sample + posture / stillness counters + resting vitals + posture prompt. */
  private second(c: OpenSecond, out: TrackerEvent[]) {
    const smp = this.finishSecond(c);
    const s = this.session;
    const pc = this.ctx.posture ?? POSTURE;
    const state = motionState(smp, pc);
    smp.state = state;
    if (state === 'still') s.stillS = (s.stillS ?? 0) + 1;
    if (state === 'restless') s.restlessS = (s.restlessS ?? 0) + 1;
    let zone: PoseZone | null = null;
    if (this.ctx.neutral && state !== 'walking') {
      const dev = deviation(smp.pitch, smp.roll, this.ctx.neutral, this.ctx.mapping);
      zone = zoneOf(dev, pc);
      smp.devForward = dev.forward; smp.devTilt = dev.tilt; smp.zone = zone;
      s.poseMonitoredS = (s.poseMonitoredS ?? 0) + 1;
      if (zone !== 'ok') s.outsidePoseS = (s.outsidePoseS ?? 0) + 1;
    } else { smp.devForward = null; smp.devTilt = null; smp.zone = null; }
    out.push({ type: 'sample', sample: smp });
    this.lastSample = smp;
    const r = this.resting.push(smp);
    if (r) out.push({ type: 'resting', reading: r });
    const p = this.prompter.push(smp.t, zone);
    if (p && p !== 'ok') out.push({ type: 'posture', zone: p });
  }

  private finishSecond(c: OpenSecond): Sample {
    const n = c.n || 1;
    const v = (s: number, s2: number) => Math.max(0, s2 / n - (s / n) ** 2);
    return {
      sessionId: this.session.id, t: c.t, demo: this.session.demo,
      pitch: c.p / n, roll: c.r / n, yaw: c.y / n,
      motionDeg: Math.sqrt(v(c.p, c.p2) + v(c.r, c.r2) + v(c.y, c.y2)),
      tremorFrac: c.tremorN / n, ampDps: c.amp, axes: c.axes, freqHz: c.freq, walkingFrac: c.walkN / n,
      bpm: c.bpm, spo2: c.spo2, ppgState: c.ppg,
    };
  }
}
