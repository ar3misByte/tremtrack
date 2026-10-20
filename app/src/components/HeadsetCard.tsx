import { useState } from 'react';
import { live, useLive } from '../device/live';
import { useSettings } from '../state/settings';

const COMPASS: Record<number, string> = {
  0: 'Not fitted. Yaw (turning left and right) comes from the gyro only and drifts slowly; Recentre fixes it.',
  1: 'Fitted but not calibrated. Calibrate it once (below) and yaw stops drifting.',
  2: 'Calibrated, ignoring it for the moment (a magnet or steel is close, or the head is tilted far).',
  3: 'Calibrated and keeping the yaw steady.',
  4: 'Calibrating: turn the headset slowly, level, one full circle (two is better).',
};

const stateText = (s: string) => ({ up: 'connected', down: 'not connected', unset: 'not set up', off: 'off (not provisioned)', ok: 'synchronised', no: 'not yet' } as Record<string, string>)[s] ?? s;

/** Headset status from the firmware's '# INFO' line, and the one-time Wi-Fi setup sent over the current link. */
export default function HeadsetCard() {
  const snap = useLive();
  const setSettings = useSettings((s) => s.set);
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [note, setNote] = useState('');
  const info = snap.info;
  const real = snap.source === 'serial' || snap.source === 'ble' || snap.source === 'websocket';
  const ready = real && snap.canSend;
  const mag = snap.frame?.magQ ?? null;                    // null = firmware without a compass field
  const magLines = snap.statusLog.filter((l) => l.startsWith('MAG '));
  const progress = [...magLines].reverse().map((l) => /^MAG progress (d+)%/.exec(l)?.[1]).find(Boolean);
  const magResult = [...magLines].reverse().find((l) => !l.startsWith('MAG progress') && !l.startsWith('MAG calibrating'));

  const sendWifi = async () => {
    if (!ssid.trim()) { setNote('Enter the Wi-Fi network name.'); return; }
    const ok = await live.sendCommand(`!wifi ${ssid.trim()}\t${pass}`);
    setNote(ok ? 'Sent. The headset is joining the network; the status below updates in a few seconds.' : 'Could not send. Check the connection.');
    if (ok) { setPass(''); setTimeout(() => void live.refreshInfo(), 6000); setTimeout(() => void live.refreshInfo(), 12000); }
  };

  return (
    <section className="card" aria-label="Headset">
      <div className="card-title"><span>Headset</span></div>
      {!ready && (
        <p className="fine">Connect to the headset first (the connection button at the top). Then its status and Wi-Fi setup appear here.
          {snap.source === 'demo' || snap.source === 'replay' ? ' Demo and replay have no headset.' : ''}</p>
      )}
      {ready && !info && <p className="fine">Asking the headset for its status… <button className="btn sm" onClick={() => void live.refreshInfo()}>Ask again</button><br />
        Older firmware (before milestone 7) does not answer; it still streams normally.</p>}
      {ready && info && (
        <dl className="kv" aria-label="Headset status">
          <div><dt>Name</dt><dd>{info.name || '–'}</dd></div>
          <div><dt>Firmware</dt><dd>{info.fw || '–'}</dd></div>
          <div><dt>Wi-Fi</dt><dd>{stateText(info.wifi)}{info.wifi === 'up' ? `, ${info.ip}, ${info.rssi} dBm` : ''}</dd></div>
          <div><dt>Clock (internet time)</dt><dd>{stateText(info.time)}</dd></div>
          <div><dt>Cloud</dt><dd>{stateText(info.cloud)}</dd></div>
        </dl>
      )}
      {ready && (
        <>
          <div className="field" style={{ marginTop: 'var(--s-3)' }}>
            <label htmlFor="hs-ssid" className="fine">Wi-Fi network (2.4 GHz)</label>
            <input id="hs-ssid" value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="hs-pass" className="fine">Wi-Fi password</label>
            <input id="hs-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" />
          </div>
          <div className="btn-row">
            <button className="btn sm" onClick={sendWifi}>Send to headset</button>
            <button className="btn sm" onClick={() => void live.refreshInfo()}>Refresh status</button>
            {info?.wifi === 'up' && info.ip && (
              <button className="btn sm" onClick={() => { setSettings({ wsUrl: `ws://${info.ip}:81` }); setNote(`Wi-Fi address saved: ws://${info.ip}:81. Choose "Wi-Fi or simulator" to use it.`); }}>Use its Wi-Fi address</button>
            )}
            <button className="btn sm" onClick={() => void live.sendCommand('!recenter')}>Recentre yaw</button>
          </div>
          {note && <p className="fine" role="status" style={{ marginTop: 'var(--s-2)' }}>{note}</p>}
          <p className="fine" style={{ marginTop: 'var(--s-2)' }}>
            The Wi-Fi password is sent once, unencrypted, over the link you are using right now (Bluetooth range is a few metres). The headset only accepts
            Wi-Fi setup over Bluetooth or Wi-Fi for 10 minutes after it is powered on; over USB it always does. The password is stored in the headset's flash memory.
            Wi-Fi is only needed for the cloud and for streaming over your network; Bluetooth works without it.
          </p>
        </>
      )}
      {ready && mag !== null && (
        <div style={{ marginTop: 'var(--s-4)' }} aria-label="Compass">
          <div className="card-title"><span>Compass</span></div>
          <p className="fine" role="status">{COMPASS[mag] ?? 'Unknown compass state.'}{mag === 4 && progress ? ` ${progress}% of a full turn done.` : ''}</p>
          {magResult && mag !== 4 && <p className="fine">Last result: {magResult.replace(/^MAG /, '')}</p>}
          {mag === 4 && <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(progress ?? 0)}><i style={{ width: `${progress ?? 0}%` }} /></div>}
          <div className="btn-row" style={{ marginTop: 'var(--s-2)' }}>
            {mag !== 0 && mag !== 4 && <button className="btn sm" onClick={() => void live.sendCommand('!mag start')}>{mag === 1 ? 'Calibrate compass' : 'Calibrate again'}</button>}
            {mag === 4 && <button className="btn sm" onClick={() => void live.sendCommand('!mag stop')}>Cancel</button>}
            {(mag === 2 || mag === 3) && <button className="btn sm" onClick={() => void live.sendCommand('!mag clear')}>Forget calibration</button>}
          </div>
          {mag !== 0 && (
            <p className="fine" style={{ marginTop: 'var(--s-2)' }}>
              Put the headset on a table or hold it flat, away from steel, speakers and phones, and turn it slowly about the vertical axis. It finishes by
              itself after one full circle and remembers the result. The compass only steadies the yaw (the 3D head's left-right direction); tremor
              detection never uses it.
            </p>
          )}
        </div>
      )}
      {snap.statusLog.length > 0 && (
        <details style={{ marginTop: 'var(--s-3)' }}>
          <summary className="fine">Messages from the headset</summary>
          <pre className="fine" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{snap.statusLog.slice(-8).join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
