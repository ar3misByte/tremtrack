// Turns the 50 Hz frame stream into the cloud protocol: telemetry every `period` seconds (0.2-1 Hz) and
// events on change. Reference implementation used by the device simulator; the firmware (milestone 7)
// implements the same behaviour in C. Pure and unit-tested (cloudSummary.test.ts).
import type { Frame } from './csv';
import { axesOf } from './csv';
import type { Telemetry, DeviceEvent } from './protocol';
import { SessionTracker, type TrackerContext } from './tracker';
import { motionState } from './posture';

export type CloudMessage = { kind: 'telemetry'; msg: Telemetry } | { kind: 'event'; msg: DeviceEvent };

const r1 = (x: number) => Math.round(x * 10) / 10;

export class CloudSummarizer {
  private tracker: SessionTracker;
  private seq = 0;
  private evSeq = 0;
  private windowStart = 0;
  private last: Frame | null = null;
  private wasTremor = false;
  private hr: number | null = null;
  private sp: number | null = null;
  private rssi: number | null = null;
  periodS: number;

  constructor(t0: number, periodS = 5, ctx?: TrackerContext) {
    this.tracker = new SessionTracker('websocket', t0, 2, ctx);
    this.periodS = periodS;
    this.windowStart = t0;
  }

  /** Switch rate, e.g. 1 s while someone watches the live view (Viewer message), else 5 s. */
  setPeriod(s: number) { this.periodS = Math.min(5, Math.max(1, s)); }
  setRssi(dbm: number | null) { this.rssi = dbm; }

  push(f: Frame, t: number): CloudMessage[] {
    const out: CloudMessage[] = [];
    this.last = f;
    if (f.ppgState === 3 && f.bpm > 0) { this.hr = f.bpm; this.sp = f.spo2 > 0 ? f.spo2 : this.sp; }
    if (f.ppgState !== 3) { this.hr = null; this.sp = null; }
    if (f.tremor && !this.wasTremor) out.push(this.event(t, { type: 'tremor_start', ax: f.axes || 1 << f.dir, f: r1(f.freq) }));
    this.wasTremor = f.tremor;
    for (const ev of this.tracker.push(f, t)) {
      if (ev.type === 'episode') {
        const e = ev.episode;
        out.push(this.event(t, { type: 'episode', ep: { start: e.start, end: e.end, durationS: r1(e.durationS), axes: e.axes ?? [e.axis], pattern: e.pattern ?? 'single', ampDps: r1(e.ampDps), freqHz: r1(e.freqHz), score: r1(e.score), bpm: e.bpm === null ? null : Math.round(e.bpm) } }));
      } else if (ev.type === 'fall') {
        const c = ev.candidate;
        out.push(this.event(t, { type: 'fall', fall: { t: c.t, path: c.path, peakG: r1(c.peakG), freeFallMs: Math.round(c.freeFallMs), orientationChangeDeg: Math.round(c.orientationChangeDeg), outcome: 'pending' } }));
      }
    }
    if (t - this.windowStart >= this.periodS * 1000) {
      out.push({ kind: 'telemetry', msg: this.telemetry(t) });
      this.windowStart = t;
    }
    return out;
  }

  /** The user's answer to the fall countdown, reported as a second fall event. */
  fallOutcome(t: number, fall: Omit<DeviceEvent & { type: 'fall' }, 'v' | 'seq' | 'ts' | 'type'>['fall']): CloudMessage {
    return this.event(t, { type: 'fall', fall });
  }

  /** The device sensitivity was changed (by the app or a cloud command). */
  sensitivity(t: number, level: number): CloudMessage { return this.event(t, { type: 'sensitivity', level }); }

  close(t: number): CloudMessage[] {
    return this.tracker.close().filter((e) => e.type === 'episode').map((ev) => {
      const e = (ev as { episode: import('./model').Episode }).episode;
      return this.event(t, { type: 'episode', ep: { start: e.start, end: e.end, durationS: r1(e.durationS), axes: e.axes ?? [e.axis], pattern: e.pattern ?? 'single', ampDps: r1(e.ampDps), freqHz: r1(e.freqHz), score: r1(e.score), bpm: e.bpm === null ? null : Math.round(e.bpm) } });
    });
  }

  private event(t: number, body: Record<string, unknown>): CloudMessage {
    return { kind: 'event', msg: { v: 1, seq: this.evSeq++, ts: t, ...body } as DeviceEvent };
  }

  private telemetry(t: number): Telemetry {
    const f = this.last!;
    const cur = this.tracker.currentEpisode();
    const axes = f.tremor ? axesOf(f.axes || 1 << f.dir) : [];
    const amp = axes.length > 1 ? Math.hypot(...axes.map((a) => [f.ampP, f.ampR, f.ampY][a])) : Math.max(f.ampP, f.ampR, f.ampY);
    const smp = this.tracker.lastSample;
    return {
      v: 1, seq: this.seq++, ts: t, per: this.periodS,
      p: r1(f.pitch), r: r1(f.roll), y: r1(((f.yaw + 540) % 360) - 180), tr: f.tremor ? 1 : 0, ax: f.tremor ? f.axes || 1 << f.dir : 0, dir: f.dir,
      f: r1(f.freq), a: r1(amp), sev: cur ? r1(cur.score) : 0, wk: f.walking ? 1 : 0,
      hr: this.hr === null ? null : Math.round(this.hr), sp: this.sp === null ? null : Math.round(this.sp), ppg: (f.ppgState < 0 ? 0 : f.ppgState) as 0 | 1 | 2 | 3,
      pf: smp?.devForward == null ? null : r1(smp.devForward), pt: smp?.devTilt == null ? null : r1(smp.devTilt),
      st: f.walking ? 'walking' : smp ? motionState(smp) : 'normal', rssi: this.rssi, bat: null,
    };
  }
}
