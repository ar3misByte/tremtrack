// A fake Web Bluetooth headset for browser tests (Playwright cannot drive the real API headless): follows the same calls the
// app makes (requestDevice -> gatt.connect -> service -> characteristics -> notifications and writes), streams the given
// firmware lines in 20-byte notifications at 50 lines per second, answers !info, and records the commands in window.__cmds.
// Used through context.addInitScript(fakeHeadset, { lines }): it must stay self-contained.
export const fakeHeadset = ({ lines }) => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e', TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const tx = new EventTarget(), rx = {};
  tx.startNotifications = async () => { started = true; return tx; };
  let started = false, acc = '', i = 0, orient = '+x+y+z';
  window.__written = [];
  const notify = (text) => { const b = enc.encode(text); for (let o = 0; o < b.length; o += 20) { const part = b.slice(o, o + 20); tx.value = new DataView(part.buffer); tx.dispatchEvent(new Event('characteristicvaluechanged')); } };
  rx.writeValueWithoutResponse = async (v) => {
    window.__written.push(v.length);
    acc += dec.decode(v);
    let n;
    while ((n = acc.indexOf('\n')) >= 0) {
      const cmd = acc.slice(0, n); acc = acc.slice(n + 1);
      window.__cmds = [...(window.__cmds ?? []), cmd];
      if (cmd.startsWith('!orient ')) orient = cmd.slice(8).replace(/ /g, '');
        if (cmd === '!info') notify(`# INFO fw=htm-0.8.0 name=HeadTremor-TEST wifi=unset ip=0.0.0.0 rssi=0 cloud=off time=no tz=330 ble=1 ws=0 mag=1 orient=${orient}\n`);
    }
  };
  setInterval(() => { if (!started) return; do { notify(lines[i++ % lines.length] + '\n'); } while (!lines[(i - 1) % lines.length].startsWith('$')); }, 20);
  const device = new EventTarget();
  device.name = 'HeadTremor-TEST';
  device.gatt = { connect: async () => ({ getPrimaryService: async (u) => { if (u !== SERVICE) throw new Error('bad service'); return { getCharacteristic: async (c) => (c === TX ? tx : c === RX ? rx : (() => { throw new Error('bad characteristic'); })()) }; } }), disconnect: () => {} };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async (o) => { if (o.filters[0].services[0] !== SERVICE) throw new Error('wrong filter'); return device; } }, configurable: true });
};
