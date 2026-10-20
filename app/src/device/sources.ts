// Device transports. Each one delivers protocol lines (see logic/csv.ts) to a sink.
import { LineSplitter } from '../logic/csv';
import { DemoGenerator, scriptAt, type DemoAction, type DemoControls } from '../logic/demoGen';
import type { Recording } from '../logic/recording';

import type { DeviceSource, SourceCallbacks } from './types';
export type { ConnState, DeviceSource, SourceCallbacks, SourceKind } from './types';

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

// ---------- Bluetooth LE (Web Bluetooth: Chrome on Android, or Chrome / Edge on a computer) ----------
// The firmware exposes a Nordic-UART-style service (firmware/tremor_monitor/link.h): the same '$' lines as USB
// arrive as notifications, commands go out as writes. A line can span several notifications, so lines are
// reassembled here.
export const BLE_UUID = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',      // app -> device
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',      // device -> app
};
export const BLE_CHUNK = 20;                       // the minimum ATT payload; larger writes need the negotiated MTU
const BLE_RETRIES = 8;

export class BleSource implements DeviceSource {
  readonly kind = 'ble' as const;
  private dev: BluetoothDevice | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private cb: SourceCallbacks | null = null;
  private stopped = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private split = new LineSplitter(65536);
  private dec = new TextDecoder();
  private writes: Promise<void> = Promise.resolve();

  /**
   * `getBluetooth` is replaceable so tests can supply a fake. `showAll`: list every Bluetooth device nearby instead of only
   * those advertising the headset's service (a fallback when the headset is not listed; pick the one named HeadTremor-…).
   */
  constructor(
    private readonly getBluetooth: () => Bluetooth | undefined = () => (typeof navigator !== 'undefined' ? navigator.bluetooth : undefined),
    private readonly showAll = false,
  ) {}

  async start(cb: SourceCallbacks): Promise<void> {
    const bt = this.getBluetooth();
    if (!bt) throw new Error('This browser has no Bluetooth access. Use Chrome on Android, or Chrome / Edge on a computer.');
    this.cb = cb;
    this.stopped = false;
    this.retry = 0;
    cb.state('connecting', 'Choose your headset in the list (it is named HeadTremor-…).');
    this.dev = await bt.requestDevice(this.showAll ? { acceptAllDevices: true, optionalServices: [BLE_UUID.service] } : { filters: [{ services: [BLE_UUID.service] }] });
    this.dev.addEventListener('gattserverdisconnected', this.onDrop);
    await this.connectGatt();
  }

  private async connectGatt() {
    const dev = this.dev!, cb = this.cb!;
    cb.state('connecting', `Connecting to ${dev.name ?? 'the headset'}…`);
    const server = await dev.gatt!.connect();
    const svc = await server.getPrimaryService(BLE_UUID.service);
    this.tx = await svc.getCharacteristic(BLE_UUID.tx);
    this.rx = await svc.getCharacteristic(BLE_UUID.rx);
    this.split = new LineSplitter(65536);
    this.dec = new TextDecoder();
    this.tx.addEventListener('characteristicvaluechanged', this.onNotify);
    await this.tx.startNotifications();
    this.retry = 0;
    cb.state('open', `Connected to ${dev.name ?? 'the headset'} over Bluetooth.`);
  }

  private onNotify = (ev: Event) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!v || !this.cb) return;
    const text = this.dec.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), { stream: true });
    for (const l of this.split.push(text)) this.cb.line(l);
  };

  private onDrop = () => {
    const cb = this.cb;
    if (!cb) return;
    if (this.stopped) { cb.state('idle'); return; }
    this.reconnect();
  };

  private reconnect() {
    const cb = this.cb!;
    if (this.retry >= BLE_RETRIES) { cb.state('error', 'Bluetooth connection lost. Move closer to the headset and connect again.'); return; }
    const delay = Math.min(8000, 1000 * 2 ** this.retry);
    cb.state('connecting', `Bluetooth connection lost. Reconnecting in ${(delay / 1000).toFixed(0)} s (attempt ${this.retry + 1} of ${BLE_RETRIES})…`);
    this.retry++;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.connectGatt().catch(() => { if (!this.stopped) this.reconnect(); });
    }, delay);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.tx?.removeEventListener('characteristicvaluechanged', this.onNotify);
    this.dev?.removeEventListener('gattserverdisconnected', this.onDrop);
    try { this.dev?.gatt?.disconnect(); } catch { /* already disconnected */ }
    this.cb?.state('idle');
  }

  /** Writes are queued one after another (a second write while one is pending fails on Android). */
  send(text: string): Promise<void> {
    const rx = this.rx;
    if (!rx) return Promise.reject(new Error('Not connected'));
    const bytes = new TextEncoder().encode(text.endsWith('\n') ? text : text + '\n');
    const job = this.writes.then(async () => {
      for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
        const part = bytes.slice(i, i + BLE_CHUNK);
        if (rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(part); else await rx.writeValue(part);
      }
    });
    this.writes = job.catch(() => undefined);
    return job;
  }
}

// ---------- Demo: synthetic stream, manual controls or the scripted showcase ----------
export class DemoSource implements DeviceSource {
  readonly kind = 'demo' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gen = new DemoGenerator();
  private t0 = 0;
  private lastStep = -1;
  constructor(private readonly getControls: () => { scripted: boolean; manual: DemoControls }, private readonly onLabel?: (l: string) => void, private readonly onAction?: (a: DemoAction) => void) {}

  async start(cb: SourceCallbacks) {
    this.t0 = performance.now();
    cb.state('open', 'Demo mode: simulated data, no device connected.');
    this.timer = setInterval(() => {
      const t = (performance.now() - this.t0) / 1000;
      const c = this.getControls();
      let controls = c.manual;
      if (c.scripted) {
        const s = scriptAt(t);
        controls = { ...s.controls, pointer: c.manual.pointer };
        this.onLabel?.(s.label);
        if (s.step !== this.lastStep) { this.lastStep = s.step; if (s.action) this.onAction?.(s.action); }   // each scripted action once per loop
      }
      cb.line(this.gen.next(t, controls));
    }, 20);
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async send(text: string) { this.onLabel?.(`(demo) sensitivity ${text.trim()} would be sent to the device`); }
}

// ---------- Replay: plays a recorded stream (.rec) in real time, looping ----------
export class ReplaySource implements DeviceSource {
  readonly kind = 'replay' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly rec: Recording, readonly label: string, private readonly loop = true) {}

  async start(cb: SourceCallbacks) {
    const e = this.rec.entries;
    const total = e[e.length - 1][0];
    let i = 0;
    let t0 = performance.now();
    cb.state('open', `Replaying ${this.label} (${Math.round(total / 1000)} s${this.loop ? ', looping' : ''}).`);
    this.timer = setInterval(() => {
      const el = performance.now() - t0;
      while (i < e.length && e[i][0] <= el) cb.line(e[i++][1]);
      if (i >= e.length) {
        if (!this.loop) { void this.stop(); cb.state('idle', 'Replay finished.'); return; }
        i = 0; t0 = performance.now();
      }
    }, 20);
  }

  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
