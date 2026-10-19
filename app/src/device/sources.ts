// Device transports. Each one delivers protocol lines (see logic/csv.ts) to a sink.
import { LineSplitter } from '../logic/csv';
import { DemoGenerator, scriptAt, type DemoControls } from '../logic/demoGen';

export type SourceKind = 'serial' | 'websocket' | 'ble' | 'demo';
export type ConnState = 'idle' | 'connecting' | 'open' | 'error';

export interface SourceCallbacks {
  line: (line: string) => void;
  state: (s: ConnState, message?: string) => void;
}

export interface DeviceSource {
  readonly kind: SourceKind;
  start(cb: SourceCallbacks): Promise<void>;
  stop(): Promise<void>;
  /** Sends text to the device (sensitivity '1'..'5'). Not all sources support it. */
  send?(text: string): Promise<void>;
}

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;
export const bleSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

// ---------- USB: Web Serial (Chrome / Edge on desktop) ----------
export class SerialSource implements DeviceSource {
  readonly kind = 'serial' as const;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  async start(cb: SourceCallbacks) {
    if (!serialSupported()) throw new Error('This browser cannot open serial ports. Use Chrome or Edge on a computer.');
    cb.state('connecting');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;
    cb.state('open', 'Port open. The board restarts and calibrates for about 2 seconds: keep it still.');
    void this.readLoop(port, cb);
  }

  private async readLoop(port: SerialPort, cb: SourceCallbacks) {
    const dec = new TextDecoder();
    const split = new LineSplitter();
    const reader = port.readable!.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const l of split.push(dec.decode(value, { stream: true }))) cb.line(l);
      }
      cb.state('idle');
    } catch (e) {
      cb.state('error', 'Serial connection lost: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      try { await port.close(); } catch { /* already closed */ }
      this.port = null; this.reader = null;
    }
  }

  async stop() { if (this.reader) { try { await this.reader.cancel(); } catch { /* ignore */ } } }

  async send(text: string) {
    if (!this.port?.writable) throw new Error('Not connected');
    const w = this.port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
  }
}

// ---------- Wi-Fi / simulator: WebSocket with reconnect + back-off ----------
export class WebSocketSource implements DeviceSource {
  readonly kind = 'websocket' as const;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly url: string) {}

  async start(cb: SourceCallbacks) {
    this.stopped = false;
    this.open(cb);
  }

  private open(cb: SourceCallbacks) {
    cb.state('connecting', this.retry ? `Reconnecting to ${this.url} (attempt ${this.retry + 1})…` : `Connecting to ${this.url}…`);
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch (e) { cb.state('error', String(e)); return; }
    this.ws = ws;
    const split = new LineSplitter(65536);
    ws.onopen = () => { this.retry = 0; cb.state('open', `Connected to ${this.url}`); };
    ws.onmessage = (ev) => { if (typeof ev.data === 'string') for (const l of split.push(ev.data.endsWith('\n') ? ev.data : ev.data + '\n')) cb.line(l); };
    ws.onclose = () => {
      this.ws = null;
      if (this.stopped) { cb.state('idle'); return; }
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      cb.state('connecting', `Connection lost. Retrying in ${(delay / 1000).toFixed(1)} s…`);
      this.timer = setTimeout(() => this.open(cb), delay);
    };
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  async send(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    this.ws.send(text);
  }
}

// ---------- Bluetooth LE (Android Chrome): arrives with the firmware networking milestone ----------
export class BleSource implements DeviceSource {
  readonly kind = 'ble' as const;
  async start(): Promise<void> {
    throw new Error('Bluetooth streaming needs the new firmware (milestone 7). Use USB, the simulator, or demo mode for now.');
  }
  async stop() { /* nothing */ }
}

// ---------- Demo: synthetic stream, manual controls or the scripted showcase ----------
export class DemoSource implements DeviceSource {
  readonly kind = 'demo' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gen = new DemoGenerator();
  private t0 = 0;
  constructor(private readonly getControls: () => { scripted: boolean; manual: DemoControls }, private readonly onLabel?: (l: string) => void) {}

  async start(cb: SourceCallbacks) {
    this.t0 = performance.now();
    cb.state('open', 'Demo mode: simulated data, no device connected.');
    this.timer = setInterval(() => {
      const t = (performance.now() - this.t0) / 1000;
      const c = this.getControls();
      let controls = c.manual;
      if (c.scripted) { const s = scriptAt(t); controls = { ...s.controls, pointer: c.manual.pointer }; this.onLabel?.(s.label); }
      cb.line(this.gen.next(t, controls));
    }, 20);
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async send(text: string) { this.onLabel?.(`(demo) sensitivity ${text} would be sent to the device`); }
}
