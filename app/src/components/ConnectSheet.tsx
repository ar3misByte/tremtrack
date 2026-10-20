import { useEffect, useRef, useState, type ReactElement } from 'react';
import { gunzipToText, parseRecording } from '../logic/recording';
import { live, useLive } from '../device/live';
import { bleSupported, serialSupported, type SourceKind } from '../device/sources';
import { useSettings } from '../state/settings';
import { useFocusTrap } from './useFocusTrap';
import { IconBluetooth, IconClose, IconPlay, IconReplay, IconUsb, IconWifi } from './icons';

export default function ConnectSheet({ onClose }: { onClose: () => void }) {
  const snap = useLive();
  const wsUrl = useSettings((s) => s.wsUrl);
  const set = useSettings((s) => s.set);
  const dialog = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useFocusTrap(dialog);
  const [replayErr, setReplayErr] = useState<string | null>(null);

  const replay = async (load: () => Promise<Blob>, label: string) => {
    setReplayErr(null);
    try {
      const rec = parseRecording(await gunzipToText(await load()));
      await live.connect('replay', { rec, label });
      onClose();
    } catch (e) { setReplayErr((e as Error).message); }
  };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);

  const go = async (k: SourceKind) => { await live.connect(k); if (live.getSnapshot().conn !== 'error') onClose(); };
  const current = snap.conn !== 'idle' ? snap.source : null;

  const opt = (k: SourceKind, icon: ReactElement, title: string, sub: string, disabled = false) => (
    <button className="option" onClick={() => go(k)} disabled={disabled} aria-describedby={`opt-${k}`}>
      <span className="ico">{icon}</span>
      <span className="option-text"><b>{title}</b><span id={`opt-${k}`}>{sub}</span></span>
      {current === k ? <span className="chip ok">Connected</span> : <span />}
    </button>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="connect-title" ref={dialog} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="connect-title">Connect a device</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>

        {opt('serial', <IconUsb />, 'USB cable', serialSupported() ? 'Chrome or Edge on a computer. Close the Arduino Serial Monitor first.' : 'Not available in this browser (needs Chrome or Edge on a computer).', !serialSupported())}
        {opt('ble', <IconBluetooth />, 'Bluetooth (phone)', bleSupported() ? 'Direct link to the headset, no router needed. Chrome on Android, or Chrome / Edge on a computer.' : 'Not available in this browser. Use Chrome on Android.', !bleSupported())}
        {opt('websocket', <IconWifi />, 'Wi-Fi or simulator', `Streams from ${wsUrl}. The headset prints its address as ws://<ip>:81 once Wi-Fi is set up (Settings → Headset).`)}
        <div className="field" style={{ marginTop: 0 }}>
          <label htmlFor="wsurl" className="fine">WebSocket address</label>
          <input id="wsurl" type="url" value={wsUrl} onChange={(e) => set({ wsUrl: e.target.value })} spellCheck={false} />
        </div>
        {opt('demo', <IconPlay />, 'Demo mode', 'Simulated data: a scripted 2-minute showcase, or steer it yourself.')}
        <div className="option" style={{ cursor: 'default' }}>
          <span className="ico"><IconReplay /></span>
          <span className="option-text"><b>Replay a recording</b><span>Real firmware output played back in real time.</span>
            <span className="btn-row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => replay(async () => { const r = await fetch(`${import.meta.env.BASE_URL}demo/showcase.rec.gz`); if (!r.ok) throw new Error(`Could not load the showcase (${r.status})`); return r.blob(); }, 'showcase (firmware in simulator)')}>Showcase, 2 min</button>
              <button className="btn sm" onClick={() => fileInput.current?.click()}>Open a file…</button>
            </span>
          </span>
          {current === 'replay' ? <span className="chip ok">Playing</span> : <span />}
          <input ref={fileInput} type="file" accept=".rec,.gz,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void replay(async () => f, f.name); e.target.value = ''; }} />
        </div>
        {replayErr && <p className="notice warn" role="alert">{replayErr}</p>}

        {snap.conn === 'error' && <p className="notice warn" role="alert">{snap.message}</p>}
        {current && (
          <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
            <button className="btn" onClick={async () => { await live.disconnect(); onClose(); }}>Disconnect</button>
          </div>
        )}
        <p className="fine" style={{ marginTop: 'var(--s-4)' }}>
          Bluetooth works from the installed app or any https page. A Wi-Fi address that starts with ws:// can only be reached from a page opened over
          http (for example the laptop-served copy, <code>npm run serve:lan</code>), not from an https page. The simulator runs on your computer:
          <code>npm run sim -- --ws</code>.
        </p>
      </div>
    </div>
  );
}
