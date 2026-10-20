import { useEffect, useState } from 'react';
import { live, useLive } from '../device/live';
import { DEFAULT_DIRS, DIRS, MOUNTING_PRESETS, dirsFromOrient, mountingCommand, type Dir } from '../logic/mounting';
import { useSettings } from '../state/settings';

const ROWS = [
  { key: 'flipPitch', label: 'Up / down', sub: 'nodding', val: 'pitch' },
  { key: 'flipYaw', label: 'Left / right', sub: 'turning', val: 'yaw' },
  { key: 'flipRoll', label: 'Sideways', sub: 'ear to shoulder', val: 'roll' },
] as const;

/**
 * "The head moves the wrong way": reverse each direction as shown, and tell the headset how its board sits on the head
 * (which way each of the board's X, Y, Z axes points). The second part is applied inside the headset, so tremor axes, falls
 * and posture all use the head's own directions. Explained in docs/ORIENTATION.md.
 */
export default function OrientationCard() {
  const st = useSettings();
  const snap = useLive();
  const m = st.mapping;
  const [dirs, setDirs] = useState<[Dir, Dir, Dir]>(DEFAULT_DIRS);
  const [note, setNote] = useState('');
  const reported = snap.info?.orient ? dirsFromOrient(snap.info.orient) : null;
  const orient = snap.info?.orient;
  // show what the headset says it is using
  useEffect(() => { const d = orient ? dirsFromOrient(orient) : null; if (d) setDirs(d); }, [orient]);

  const res = mountingCommand(dirs);
  const real = snap.source === 'serial' || snap.source === 'ble' || snap.source === 'websocket';
  const canApply = res.ok && real && snap.canSend;
  const apply = async () => {
    if (!res.ok) return;
    const ok = await live.sendCommand(res.command);
    setNote(ok ? 'Sent. The headset re-calibrates for about 2 seconds: keep it still, then check the three values above.' : 'Could not send. Check the connection.');
    if (ok) { setTimeout(() => void live.refreshInfo(), 4000); }
  };
  const setDir = (k: number, d: Dir) => { const n = [...dirs] as [Dir, Dir, Dir]; n[k] = d; setDirs(n); setNote(''); };
  const d = live.disp;
  const shown = { pitch: d.pitch, yaw: d.yaw, roll: d.roll };

  return (
    <section className="card" aria-label="Orientation">
      <div className="card-title"><span>Orientation</span></div>
      <p className="fine">If the head on screen moves the wrong way, move your head and tick <b>Reverse</b> for the direction that is wrong.</p>
      <ul className="plain" style={{ marginTop: 'var(--s-2)' }}>
        {ROWS.map((r) => (
          <li key={r.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center', gap: 'var(--s-3)', borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
            <span><b>{r.label}</b> <span className="fine">{r.sub}</span></span>
            <span className="fine" style={{ fontVariantNumeric: 'tabular-nums', minWidth: '4.5rem', textAlign: 'right' }} aria-label={`${r.label} now ${shown[r.val].toFixed(0)} degrees`}>{snap.fresh ? `${shown[r.val] >= 0 ? '+' : ''}${shown[r.val].toFixed(0)}°` : '–'}</span>
            <label className="check"><input type="checkbox" checked={m[r.key]} onChange={(e) => st.set({ mapping: { ...m, [r.key]: e.target.checked } })} /> Reverse</label>
          </li>
        ))}
      </ul>
      <label className="check" style={{ marginTop: 'var(--s-2)' }}>
        <input type="checkbox" checked={st.holdYaw} onChange={(e) => st.set({ holdYaw: e.target.checked })} /> Keep the head steady when it is still
      </label>
      <p className="fine">Removes the slow drift of left/right on a headset without a compass. Turns slower than about 1° per second are not shown.</p>

      <details className="disclosure">
        <summary>Board mounted differently? Say how it sits on the head</summary>
        <div className="body">
          <p>Look at the X, Y and Z arrows printed on the motion sensor (MPU6050). For each one, choose which way it points when the headset is worn, as seen by the wearer.</p>
          <div className="field">
            <label htmlFor="mount-preset" className="fine">Common mountings</label>
            <select id="mount-preset" value="" onChange={(e) => { const p = MOUNTING_PRESETS[Number(e.target.value)]; if (p) { setDirs([...p.dirs]); setNote(''); } }}>
              <option value="">Choose…</option>
              {MOUNTING_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
            </select>
          </div>
          {(['X', 'Y', 'Z'] as const).map((ax, k) => (
            <div className="field" key={ax}>
              <label htmlFor={`mount-${ax}`} className="fine">Sensor {ax} arrow points</label>
              <select id={`mount-${ax}`} value={dirs[k]} onChange={(e) => setDir(k, e.target.value as Dir)}>
                {DIRS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          ))}
          {!res.ok && <p className="notice warn" role="alert">{res.error}</p>}
          <div className="btn-row">
            <button className="btn sm" onClick={() => void apply()} disabled={!canApply}>Apply to the headset</button>
            <button className="btn sm" onClick={() => { setDirs(DEFAULT_DIRS); setNote(''); }}>Reset to default</button>
          </div>
          {!real && <p className="fine">Connect the headset (USB, Bluetooth or Wi-Fi) to apply this. Demo mode has no board.</p>}
          {reported
            ? <p className="fine">The headset is using: {reported.map((x, i) => `${'XYZ'[i]} ${DIRS.find((o) => o.id === x)?.label}`).join(', ')}.</p>
            : real && <p className="fine">The headset has not reported its mounting (older firmware, or not asked yet).</p>}
          {note && <p className="fine" role="status">{note}</p>}
          <label className="check" style={{ marginTop: 'var(--s-2)' }}>
            <input type="checkbox" checked={m.swapPitchRoll} onChange={(e) => st.set({ mapping: { ...m, swapPitchRoll: e.target.checked } })} /> Swap up/down and sideways on screen only (older headsets without the setting above)
          </label>
        </div>
      </details>
    </section>
  );
}
