// Turns the 50 Hz frame stream of one connection into a Session, Episodes and 1 Hz Samples.
// Pure and synchronous: the caller (data/recorder.ts) supplies timestamps and stores the output.
import { EPISODES, SESSIONS, SEVERITY } from '../config/thresholds';
import type { Axis, Frame } from './csv';
import { isDemoSource, type Episode, type Sample, type Session, type Source } from './model';
import { displacementDeg, episodeScore } from './severity';

export type TrackerEvent =
  | { type: 'episode'; episode: Episode }
  | { type: 'sample'; sample: Sample };

interface OpenEpisode {
  start: number; lastAlert: number; n: number;
  axisN: [number, number, number];
  ampSum: number; peak: number; freqSum: number; freqN: number; qSum: number; cycSum: number; walkN: number;
  bpmSum: number; bpmN: number;
}

interface OpenSecond {
  t: number; n: number;
  p: number; r: number; y: number; p2: number; r2: number; y2: number;
  tremorN: number; amp: number; freq: number; walkN: number;
  bpm: number | null; spo2: number | null; ppg: number;
}

let counter = 0;
export const newId = (prefix: string, t: number) => `${prefix}_${t.toString(36)}_${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class SessionTracker {
  readonly session: Session;
  private ep: OpenEpisode | null = null;
  private sec: OpenSecond | null = null;
  private lastT = 0;

  constructor(source: Source, t: number, sensitivity: number, id = newId('s', t)) {
    this.session = {
      id, source, demo: isDemoSource(source), start: t, end: t, open: true,
      monitoredS: 0, tremorS: 0, walkingS: 0, episodes: 0, frames: 0, sensitivity,
    };
  }

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

    // ----- 1 Hz samples -----
    const sec = Math.floor(t / 1000) * 1000;
    if (this.sec && this.sec.t !== sec) out.push({ type: 'sample', sample: this.finishSecond(this.sec) });
    if (!this.sec || this.sec.t !== sec) {
      this.sec = { t: sec, n: 0, p: 0, r: 0, y: 0, p2: 0, r2: 0, y2: 0, tremorN: 0, amp: 0, freq: 0, walkN: 0, bpm: null, spo2: null, ppg: -1 };
    }
    const c = this.sec;
    c.n++;
    c.p += f.pitch; c.r += f.roll; c.y += f.yaw;
    c.p2 += f.pitch * f.pitch; c.r2 += f.roll * f.roll; c.y2 += f.yaw * f.yaw;
    if (f.tremor) c.tremorN++;
    c.amp = Math.max(c.amp, f.ampP, f.ampR, f.ampY);
    if (f.freq > 0) c.freq = f.freq;
    if (f.walking) c.walkN++;
    if (f.ppgState === 3 && f.bpm > 0) { c.bpm = f.bpm; c.spo2 = f.spo2 > 0 ? f.spo2 : c.spo2; }
    c.ppg = Math.max(c.ppg, f.ppgState);

    // ----- episodes -----
    if (f.tremor) {
      if (!this.ep) {
        this.ep = { start: t, lastAlert: t, n: 0, axisN: [0, 0, 0], ampSum: 0, peak: 0, freqSum: 0, freqN: 0, qSum: 0, cycSum: 0, walkN: 0, bpmSum: 0, bpmN: 0 };
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
    if (this.sec) { out.push({ type: 'sample', sample: this.finishSecond(this.sec) }); this.sec = null; }
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
    const ampDps = e.n ? e.ampSum / e.n : 0;
    const freqHz = e.freqN ? e.freqSum / e.freqN : 0;
    const durationS = Math.max(0, (e.lastAlert - e.start) / 1000 + 0.02);   // + one frame
    const sc = episodeScore({ ampDps, freqHz, durationS });
    return {
      id: newId('e', e.start), sessionId: s.id, source: s.source, demo: s.demo,
      start: e.start, end: e.lastAlert, durationS, axis,
      axisShare: e.n ? (e.axisN.map((x) => x / e.n) as [number, number, number]) : [0, 0, 0],
      ampDps, peakAmpDps: e.peak, freqHz, q: e.n ? e.qSum / e.n : 0, cycles: e.n ? e.cycSum / e.n : 0,
      walkingFrac: e.n ? e.walkN / e.n : 0, bpm: e.bpmN ? e.bpmSum / e.bpmN : null,
      displacementDeg: displacementDeg(ampDps, freqHz), score: sc.score, scoreVersion: SEVERITY.version, sensitivity: s.sensitivity,
    };
  }

  private finishSecond(c: OpenSecond): Sample {
    const n = c.n || 1;
    const v = (s: number, s2: number) => Math.max(0, s2 / n - (s / n) ** 2);
    return {
      sessionId: this.session.id, t: c.t, demo: this.session.demo,
      pitch: c.p / n, roll: c.r / n, yaw: c.y / n,
      motionDeg: Math.sqrt(v(c.p, c.p2) + v(c.r, c.r2) + v(c.y, c.y2)),
      tremorFrac: c.tremorN / n, ampDps: c.amp, freqHz: c.freq, walkingFrac: c.walkN / n,
      bpm: c.bpm, spo2: c.spo2, ppgState: c.ppg,
    };
  }
}
