// Live device state. Lives outside React: 50 frames/s go into plain fields and ring buffers;
// canvases and the 3D view read them every animation frame, React re-renders at 10 Hz via useLive().
import { useSyncExternalStore } from 'react';
import { parseLine, type Frame } from '../logic/csv';
import { analyzeCombined, type ComboResult } from '../logic/multiaxis';
import { applyMapping, Exaggerator, relativeTo, YawHold, type Euler3 } from '../logic/orientation';
import { DEFAULT_CONTROLS, type DemoControls } from '../logic/demoGen';
import { useSettings } from '../state/settings';
import { DemoSource, SerialSource, WebSocketSource, BleSource, ReplaySource, type ConnState, type DeviceSource, type SourceKind } from './sources';
import type { Recording } from '../logic/recording';

/** Hooks for the recorder: every parsed frame (with arrival time, ms epoch) and every connection change. */
export type FrameHook = (f: Frame, t: number) => void;
export type ConnHook = (kind: SourceKind | null, state: ConnState) => void;

/** What the firmware reports about itself ('# INFO key=value ...' line, requested with the !info command). */
export interface DeviceInfo { fw: string; name: string; wifi: string; ip: string; rssi: number; cloud: string; time: string; tz: number; orient: string; at: number }
export function parseInfo(text: string, now = Date.now()): DeviceInfo | null {
  if (!text.startsWith('INFO ')) return null;
  const kv = Object.fromEntries(text.slice(5).split(/\s+/).map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2));
  return { fw: kv.fw ?? '', name: kv.name ?? '', wifi: kv.wifi ?? '', ip: kv.ip ?? '', rssi: Number(kv.rssi ?? 0), cloud: kv.cloud ?? '', time: kv.time ?? '', tz: Number(kv.tz ?? 0), orient: kv.orient ?? '', at: now };
}

export const RING = 250;                       // 5 s at 50 Hz
const STALE_MS = 1500;

export interface LiveSnapshot {
  conn: ConnState;
  source: SourceKind | null;
  message: string;
  fresh: boolean;               // data arrived within the last 1.5 s
  rate: number;                 // frames per second
  frame: Frame | null;
  tremorActive: boolean;
  lastStatus: string;           // last '#' line from the firmware
  lastRaw: string;
  invalidCount: number;
  combo: ComboResult | null;     // how the axes move together while several shake (null otherwise)
  demoLabel: string;
  canSend: boolean;
  recordingRaw: boolean;
  rawLines: number;
  replayLabel: string;
  statusLog: string[];          // recent '#' lines from the firmware, newest last
  info: DeviceInfo | null;      // from the last '# INFO' line
}

class Live {
  frame: Frame | null = null;
  disp: Euler3 = { pitch: 0, roll: 0, yaw: 0 };       // recentred, mapped, exaggerated: what the views draw
  wave = [new Float32Array(RING), new Float32Array(RING), new Float32Array(RING)];
  pulse = new Float32Array(RING);
  head = 0;
  pulseHead = 0;
  lastRx = 0;

  private zero: Euler3 = { pitch: 0, roll: 0, yaw: 0 };
  private needZero = true;
  private ex = new Exaggerator();
  private hold = new YawHold();
  private lastFrameMs = 0;
  private source: DeviceSource | null = null;
  private conn: ConnState = 'idle';
  private message = '';
  private lastStatus = '';
  private lastRaw = '';
  private invalid = 0;
  private count = 0;
  private rate = 0;
  private rateT = performance.now();
  private demoLabel = '';
  demo = { scripted: true, manual: { ...DEFAULT_CONTROLS } as DemoControls };

  private frameHooks = new Set<FrameHook>();
  private connHooks = new Set<ConnHook>();
  private raw: Recording | null = null;
  private replayLabel = '';
  private statusLog: string[] = [];
  private info: DeviceInfo | null = null;
  private listeners = new Set<() => void>();
  private snap: LiveSnapshot = this.makeSnap();

  constructor() {
    setInterval(() => this.tick(), 100);
  }

  // ----- data in -----
  handleLine = (line: string) => {
    if (this.raw && this.raw.entries.length < 200_000) this.raw.entries.push([Date.now() - this.raw.start, line]);
    const p = parseLine(line);
    if (!p) return;
    if (p.kind === 'status') {
      this.lastStatus = p.text; this.lastRaw = line;
      const info = parseInfo(p.text);
      if (info) this.info = info; else this.statusLog = [...this.statusLog.slice(-29), p.text];
      return;
    }
    if (p.kind === 'invalid') { this.invalid++; return; }
    const f = p.frame;
    this.frame = f;
    this.lastRaw = line;
    this.lastRx = performance.now();
    this.count++;
    this.wave[0][this.head] = f.fPitch; this.wave[1][this.head] = f.fRoll; this.wave[2][this.head] = f.fYaw;
    this.head = (this.head + 1) % RING;
    if (f.pulse !== null) { this.pulse[this.pulseHead] = f.pulse; this.pulseHead = (this.pulseHead + 1) % RING; }

    const s = useSettings.getState();
    const raw = applyMapping({ pitch: f.pitch, roll: f.roll, yaw: f.yaw }, s.mapping);
    // a real headset without a compass drifts slowly in yaw: remove drift while the head is still
    const k = this.source?.kind;
    const nowMs = performance.now();
    const dt = this.lastFrameMs ? Math.min(0.2, Math.max(0.005, (nowMs - this.lastFrameMs) / 1000)) : 0.02;
    this.lastFrameMs = nowMs;
    if (s.holdYaw && (k === 'serial' || k === 'ble' || k === 'websocket')) raw.yaw -= this.hold.step(raw.yaw, dt);
    if (this.needZero) { this.zero = { pitch: 0, roll: 0, yaw: raw.yaw }; this.needZero = false; this.ex.reset(); }
    this.disp = this.ex.step(relativeTo(raw, this.zero), s.exaggeration);
    const now = Date.now();
    this.frameHooks.forEach((h) => h(f, now));
  };

  onFrame(h: FrameHook) { this.frameHooks.add(h); return () => { this.frameHooks.delete(h); }; }
  onConn(h: ConnHook) { this.connHooks.add(h); return () => { this.connHooks.delete(h); }; }
  get sourceKind(): SourceKind | null { return this.source?.kind ?? null; }

  // ----- raw stream recording (for replay) -----
  startRawRecording() { this.raw = { start: Date.now(), source: this.source?.kind ?? 'unknown', entries: [] }; this.emit(); }
  stopRawRecording(): Recording | null { const r = this.raw; this.raw = null; this.emit(); return r && r.entries.length ? r : null; }

  /** Recenter: the current pose becomes "straight ahead" (zeroes yaw and the tilt offsets). */
  recenter() {
    const f = this.frame;
    if (!f) { this.needZero = true; return; }
    this.zero = applyMapping({ pitch: f.pitch, roll: f.roll, yaw: f.yaw }, useSettings.getState().mapping);
    const k = this.source?.kind;
    if (useSettings.getState().holdYaw && (k === 'serial' || k === 'ble' || k === 'websocket')) this.zero.yaw -= this.hold.offset;   // the picture's yaw has this drift removed already
    this.ex.reset();
  }

  // ----- connections -----
  async connect(kind: SourceKind, replay?: { rec: Recording; label: string }, custom?: DeviceSource) {
    await this.disconnect();
    const s = useSettings.getState();
    const src: DeviceSource = custom ??
      (kind === 'serial' ? new SerialSource()
      : kind === 'websocket' ? new WebSocketSource(s.wsUrl)
      : kind === 'ble' ? new BleSource()
      : kind === 'replay' ? new ReplaySource(replay!.rec, replay!.label)
      : new DemoSource(() => this.demo, (l) => { this.demoLabel = l; }, (a) => { void import('../data/demoActions').then((m) => m.runDemoAction(a)); }));
    this.source = src;
    this.needZero = true;
    this.hold.reset(); this.lastFrameMs = 0;
    this.demoLabel = '';
    this.replayLabel = kind === 'replay' ? replay?.label ?? '' : '';
    try {
      await src.start({
        line: this.handleLine,
        state: (st, msg) => { if (this.source === src) { this.conn = st; if (msg !== undefined) this.message = msg; this.connHooks.forEach((h) => h(src.kind, st)); this.emit(); } },
      });
      if (src.send && (kind === 'serial' || kind === 'ble' || kind === 'websocket')) {
        void this.sendSensitivity(s.sensitivity, true);
        // tell the headset the local time zone (the cloud uses it for local days) and ask what it is
        void this.sendCommand(`!tz ${-new Date().getTimezoneOffset()}`).then(() => this.sendCommand('!info'));
      }
    } catch (e) {
      this.source = null;
      const err = e as Error;
      if (err?.name === 'NotFoundError') { this.conn = 'idle'; this.message = ''; }   // chooser dismissed
      else { this.conn = 'error'; this.message = err?.message ?? String(e); }
      this.emit();
    }
  }

  async disconnect() {
    const src = this.source;
    this.source = null;
    if (src) await src.stop();
    this.conn = 'idle';
    this.message = '';
    this.lastRx = 0;
    this.info = null;
    this.statusLog = [];
    this.connHooks.forEach((h) => h(src?.kind ?? null, 'idle'));
    this.emit();
  }

  /** A command line for the firmware ('!info', '!wifi ssid<TAB>password', …). */
  async sendCommand(cmd: string): Promise<boolean> {
    if (!this.source?.send || this.conn !== 'open') return false;
    try { await this.source.send(cmd + '\n'); return true; }
    catch (e) { this.message = 'Could not send: ' + (e as Error).message; this.emit(); return false; }
  }

  /** Clears the stored device info (e.g. before asking again). */
  async refreshInfo() { this.info = null; return this.sendCommand('!info'); }

  async sendSensitivity(level: number, quiet = false) {
    if (!this.source?.send) return false;
    try {
      await this.source.send(String(level) + '\n');
      if (!quiet) this.message = `Sensitivity ${level} sent to the device.`;
      this.emit();
      return true;
    } catch (e) {
      this.message = 'Could not send: ' + (e as Error).message;
      this.emit();
      return false;
    }
  }

  // ----- React bridge -----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  private emit() { this.snap = this.makeSnap(); this.listeners.forEach((l) => l()); }

  private tick() {
    const now = performance.now();
    if (now - this.rateT >= 1000) { this.rate = Math.round((this.count * 1000) / (now - this.rateT)); this.count = 0; this.rateT = now; }
    this.emit();
  }

  /** Combined-axis analysis over the last 1.5 s of band-passed signal. */
  private combo(): ComboResult {
    const N = 75;
    const sig = this.wave.map((w) => Float64Array.from({ length: N }, (_, k) => w[(this.head - N + k + RING) % RING])) as [Float64Array, Float64Array, Float64Array];
    return analyzeCombined(sig, this.frame!.axes);
  }

  private makeSnap(): LiveSnapshot {
    const fresh = this.lastRx > 0 && performance.now() - this.lastRx < (this.source?.staleMs ?? STALE_MS);
    return {
      conn: this.conn, source: this.source?.kind ?? null, message: this.message, fresh, rate: this.rate,
      frame: this.frame, tremorActive: fresh && !!this.frame?.tremor, lastStatus: this.lastStatus,
      lastRaw: this.lastRaw, invalidCount: this.invalid, demoLabel: this.demoLabel,
      canSend: !!this.source?.send && this.conn === 'open',
      recordingRaw: !!this.raw, rawLines: this.raw?.entries.length ?? 0, replayLabel: this.replayLabel,
      statusLog: this.statusLog, info: this.info,
      combo: fresh && this.frame && this.frame.tremor && (this.frame.axes & (this.frame.axes - 1)) !== 0 ? this.combo() : null,
    };
  }
}

export const live = new Live();
export const useLive = () => useSyncExternalStore(live.subscribe, live.getSnapshot);
