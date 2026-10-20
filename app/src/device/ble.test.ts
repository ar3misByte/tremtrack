import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BleSource, BLE_CHUNK, BLE_UUID, type ConnState } from './sources';
import { parseInfo } from './live';

// A tiny fake of the Web Bluetooth objects the source touches.
class FakeChar extends EventTarget {
  written: Uint8Array[] = [];
  async startNotifications() { return this; }
  async writeValueWithoutResponse(v: Uint8Array) { this.written.push(new Uint8Array(v)); }
  notify(text: string) {
    const b = new TextEncoder().encode(text);
    (this as unknown as { value: DataView }).value = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}
class FakeDevice extends EventTarget {
  name = 'HeadTremor-A1B2';
  tx = new FakeChar();
  rx = new FakeChar();
  connects = 0;
  failNext = 0;
  gatt = {
    connect: async () => {
      this.connects++;
      if (this.failNext > 0) { this.failNext--; throw new Error('out of range'); }
      return { getPrimaryService: async (u: string) => { expect(u).toBe(BLE_UUID.service); return { getCharacteristic: async (c: string) => (c === BLE_UUID.tx ? this.tx : this.rx) }; } };
    },
    disconnect: () => { this.dispatchEvent(new Event('gattserverdisconnected')); },
  };
}
const bt = (dev: FakeDevice) => () => ({ requestDevice: async (o: { filters: { services: string[] }[] }) => { expect(o.filters[0].services).toEqual([BLE_UUID.service]); return dev; } }) as unknown as Bluetooth;

describe('BleSource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reassembles lines that span several notifications', async () => {
    const dev = new FakeDevice(); const lines: string[] = []; const states: ConnState[] = [];
    const src = new BleSource(bt(dev));
    await src.start({ line: (l) => lines.push(l), state: (s) => states.push(s) });
    expect(states.at(-1)).toBe('open');
    const full = '$,1.0,2.0,3.0,0.10,0.20,0.30,0,0,0.0,0.0,0.0,0.0,0.00,0,0.00,0,0,0,1,0.0,0,1.00,1.00\n';
    for (let i = 0; i < full.length; i += BLE_CHUNK) dev.tx.notify(full.slice(i, i + BLE_CHUNK));
    dev.tx.notify('# INFO fw=x\n$,4,5\n$,6,');
    dev.tx.notify('7\n');
    expect(lines).toEqual([full.trim(), '# INFO fw=x', '$,4,5', '$,6,7']);
  });

  it('writes commands in small chunks, in order, with a newline', async () => {
    const dev = new FakeDevice();
    const src = new BleSource(bt(dev));
    await src.start({ line: () => {}, state: () => {} });
    const cmd = '!wifi My Home Network\tcorrect horse battery staple';
    await Promise.all([src.send(cmd), src.send('3')]);
    const bytes = dev.rx.written;
    expect(bytes.every((b) => b.length <= BLE_CHUNK)).toBe(true);
    const text = new TextDecoder().decode(Uint8Array.from(bytes.flatMap((b) => [...b])));
    expect(text).toBe(cmd + '\n3\n');
  });

  it('reconnects after the link drops, with back-off, and gives up with a clear message', async () => {
    const dev = new FakeDevice(); const msgs: string[] = []; const states: ConnState[] = [];
    const src = new BleSource(bt(dev));
    await src.start({ line: () => {}, state: (s, m) => { states.push(s); if (m) msgs.push(m); } });
    dev.dispatchEvent(new Event('gattserverdisconnected'));
    expect(states.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1100);
    expect(dev.connects).toBe(2);
    expect(states.at(-1)).toBe('open');
    // out of range for good
    dev.failNext = 100;
    dev.dispatchEvent(new Event('gattserverdisconnected'));
    for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(9000);
    expect(states.at(-1)).toBe('error');
    expect(msgs.at(-1)).toMatch(/Move closer/);
  });

  it('stop() ends the connection without reconnecting', async () => {
    const dev = new FakeDevice(); const states: ConnState[] = [];
    const src = new BleSource(bt(dev));
    await src.start({ line: () => {}, state: (s) => states.push(s) });
    await src.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(dev.connects).toBe(1);
    expect(states.at(-1)).toBe('idle');
  });

  it('can list every nearby device when the service filter finds nothing', async () => {
    const dev = new FakeDevice(); let asked: unknown;
    const src = new BleSource(() => ({ requestDevice: async (o: unknown) => { asked = o; return dev; } }) as unknown as Bluetooth, true);
    await src.start({ line: () => {}, state: () => {} });
    expect(asked).toEqual({ acceptAllDevices: true, optionalServices: [BLE_UUID.service] });
    expect(dev.connects).toBe(1);
  });

  it('explains when the browser has no Bluetooth', async () => {
    const src = new BleSource(() => undefined);
    await expect(src.start({ line: () => {}, state: () => {} })).rejects.toThrow(/Chrome on Android/);
  });
});

describe('device info line', () => {
  it('parses the firmware INFO status', () => {
    const i = parseInfo('INFO fw=htm-0.7.0 name=HeadTremor-A1B2 wifi=up ip=192.168.1.23 rssi=-55 cloud=off time=ok tz=330 ble=1 ws=0', 5);
    expect(i).toMatchObject({ fw: 'htm-0.7.0', name: 'HeadTremor-A1B2', wifi: 'up', ip: '192.168.1.23', rssi: -55, cloud: 'off', time: 'ok', tz: 330 });
    expect(parseInfo('Sensitivity 3')).toBeNull();
  });
});
