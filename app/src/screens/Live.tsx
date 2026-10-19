import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { live, useLive, type LiveSnapshot } from '../device/live';
import type { Axis } from '../logic/csv';
import { useSettings } from '../state/settings';
import Circle2D from '../components/Circle2D';
import { PulseTrace, Waveform } from '../components/Traces';
import { IconCircle, IconCube, IconRecenter } from '../components/icons';

const Head3D = lazy(() => import('../components/Head3D'));

export const AXIS_LONG = ['Nodding ("yes-yes")', 'Tilting side to side', 'Turning ("no-no")'] as const;
export const AXIS_SHORT = ['Nod', 'Tilt', 'Turn'] as const;
const AXIS_VAR = ['--axis-pitch', '--axis-roll', '--axis-yaw'];

function headline(s: LiveSnapshot): { title: string; sub: string; tone: 'alert' | 'ok' | 'quiet' } {
  const f = s.frame;
  if (!s.fresh || !f) {
    if (s.conn === 'open' || s.conn === 'connecting') return { title: 'Waiting for data', sub: s.message || 'The board calibrates for about 2 seconds after it starts. Keep it still.', tone: 'quiet' };
    return { title: 'Not connected', sub: 'Connect the headset, or try demo mode.', tone: 'quiet' };
  }
  if (s.tremorActive) {
    return { title: 'Tremor detected', sub: `${AXIS_LONG[f.dir]}${f.freq > 0 ? `, about ${f.freq.toFixed(1)} Hz` : ''}${f.walking ? ', while walking' : ''}`, tone: 'alert' };
  }
  if (f.walking) return { title: 'Walking', sub: `Step rhythm ${f.stepHz > 0 ? f.stepHz.toFixed(1) + ' steps/s' : 'detected'} is ignored. Tremor needs a stronger signal now.`, tone: 'ok' };
  return { title: 'Steady', sub: 'No rhythmic shaking between 3.5 and 8.5 Hz.', tone: 'ok' };
}

function useTremorAnnouncer(active: boolean, dir: Axis | undefined) {
  const [msg, setMsg] = useState('');
  const prev = useRef(false);
  useEffect(() => {
    if (active !== prev.current) {
      setMsg(active ? `Tremor detected: ${dir !== undefined ? AXIS_LONG[dir] : ''}` : 'Tremor ended');
      prev.current = active;
    }
  }, [active, dir]);
  return msg;
}

export default function Live({ onConnect }: { onConnect: () => void }) {
  const s = useLive();
  const st = useSettings();
  const h = headline(s);
  const f = s.fresh ? s.frame : null;
  const announce = useTremorAnnouncer(s.tremorActive, f?.dir);

  return (
    <div className="page wide">
      <p className="sr-only" role="status" aria-live="assertive">{announce}</p>

      <div className="col">
        <div className="hero-text">
          <h1 className={h.tone === 'alert' ? 'alert' : undefined}>{h.title}</h1>
          <p>{h.sub}</p>
        </div>

        <section className={`card stage${s.tremorActive ? ' alert' : ''}`} aria-label="Head orientation">
          <div className="stage-view" role="img" aria-label={f ? `Head: nod ${live.disp.pitch.toFixed(0)}°, tilt ${live.disp.roll.toFixed(0)}°, turn ${live.disp.yaw.toFixed(0)}°` : 'Head view, no data'}>
            {st.viewMode === '3d'
              ? <Suspense fallback={<div className="stage-loading fine">Loading 3D view…</div>}><Head3D /></Suspense>
              : <div className="stage-2d"><Circle2D /></div>}
          </div>
          <div className="stage-top">
            {s.tremorActive && f
              ? <span className="chip alert">{AXIS_SHORT[f.dir]} · {f.freq.toFixed(1)} Hz</span>
              : f ? <span className="chip ok">{f.walking ? 'Walking' : 'Steady'}</span> : <span className="chip quiet">No data</span>}
            {s.source === 'demo' && <span className="chip quiet">Demo</span>}
          </div>
          <div className="stage-bottom">
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={st.viewMode === '3d'} onClick={() => st.set({ viewMode: '3d' })}><span className="seg-ico"><IconCube /></span>3D</button>
              <button aria-pressed={st.viewMode === '2d'} onClick={() => st.set({ viewMode: '2d' })}><span className="seg-ico"><IconCircle /></span>2D</button>
            </div>
            <button className="icon-btn" onClick={() => live.recenter()} aria-label="Recenter: make the current pose straight ahead" title="Recenter (C)"><IconRecenter /></button>
          </div>
        </section>

        {!f && (
          <button className="btn primary" onClick={onConnect}>Connect a device</button>
        )}

        <div className="grid-3">
          <div className="card metric">
            <div className="label">Frequency</div>
            <div className="value">{f && f.freq > 0 ? f.freq.toFixed(1) : '–'}<small>Hz</small></div>
          </div>
          <div className="card metric">
            <div className="label">Amplitude</div>
            <div className="value">{f ? Math.max(f.ampP, f.ampR, f.ampY).toFixed(1) : '–'}<small>°/s</small></div>
          </div>
          <div className="card metric">
            <div className="label">{f?.walking ? 'Steps' : 'Cycles'}</div>
            <div className="value">{f ? (f.walking ? f.stepHz.toFixed(1) : f.tremor && f.cycles > 0 ? f.cycles : '–') : '–'}<small>{f?.walking ? '/s' : ''}</small></div>
          </div>
        </div>
      </div>

      <div className="col">
        <VitalsCard s={s} />
        <AxisCard s={s} />
        <section className="card">
          <div className="card-title"><span>Motion in the tremor band</span></div>
          <Waveform />
        </section>
        {s.source === 'demo' && <DemoCard label={s.demoLabel} />}
        <DisplayCard canSend={s.canSend} />
        <HowComputed />
      </div>
    </div>
  );
}

function VitalsCard({ s }: { s: LiveSnapshot }) {
  const f = s.fresh ? s.frame : null;
  const st = f?.ppgState ?? -2;
  const ok = st === 3;
  const msg = !f ? 'Waiting for data'
    : st === -1 ? 'This firmware does not send heart rate. Flash the latest sketch.'
    : st === 0 ? 'Pulse sensor not found. Check its wiring (SDA 21, SCL 22, 3V3, GND).'
    : st === 1 ? 'Rest a fingertip gently on the sensor (no pressing, keep it still).'
    : st === 2 ? 'Measuring. Hold still for about 10 seconds.'
    : 'Live reading. SpO₂ is an uncalibrated estimate from a hobby sensor.';
  return (
    <section className="card" aria-label="Heart rate and oxygen">
      <div className="grid-2">
        <div>
          <div className="fine">Heart rate</div>
          <div className="big-number" style={{ color: ok ? 'var(--ink)' : 'var(--ink-3)' }}>{ok && f!.bpm > 0 ? f!.bpm : '–'}<small>bpm</small></div>
        </div>
        <div>
          <div className="fine">SpO₂ (estimate)</div>
          <div className="big-number" style={{ color: ok ? 'var(--ink)' : 'var(--ink-3)' }}>{ok && f!.spo2 > 0 ? f!.spo2 : '–'}<small>%</small></div>
        </div>
      </div>
      <div style={{ marginTop: 'var(--s-3)' }}><PulseTrace active={ok} /></div>
      <p className="fine" style={{ marginTop: 'var(--s-2)' }} aria-live="polite">{msg}</p>
    </section>
  );
}

function AxisCard({ s }: { s: LiveSnapshot }) {
  const f = s.fresh ? s.frame : null;
  const amps = f ? [f.ampP, f.ampR, f.ampY] : [0, 0, 0];
  return (
    <section className="card" aria-label="Shaking by axis">
      <div className="card-title"><span>Shaking by axis</span><span className="fine">°/s in 3.5–8.5 Hz</span></div>
      {([0, 1, 2] as Axis[]).map((i) => {
        const on = s.tremorActive && f?.dir === i;
        return (
          <div className={`axis-row${on ? ' on' : ''}`} key={i}>
            <i className="sw" style={{ background: `var(${AXIS_VAR[i]})` }} />
            <span>{AXIS_LONG[i]}</span>
            <div className="track" role="meter" aria-valuemin={0} aria-valuemax={30} aria-valuenow={Number(amps[i].toFixed(1))} aria-label={`${AXIS_LONG[i]} amplitude`}>
              <i style={{ width: `${Math.min(1, amps[i] / 30) * 100}%`, background: on ? 'var(--accent)' : `var(${AXIS_VAR[i]})` }} />
            </div>
            <b>{amps[i].toFixed(1)}</b>
          </div>
        );
      })}
    </section>
  );
}

function DemoCard({ label }: { label: string }) {
  const [, force] = useState(0);
  const d = live.demo;
  const upd = (fn: () => void) => { fn(); force((x) => x + 1); };
  return (
    <section className="card sunk" aria-label="Demo controls">
      <div className="card-title"><span>Demo controls</span>{d.scripted && label && <span className="chip quiet">{label}</span>}</div>
      <div className="segmented" role="group" aria-label="Demo mode">
        <button aria-pressed={d.scripted} onClick={() => upd(() => { d.scripted = true; })}>Scripted showcase</button>
        <button aria-pressed={!d.scripted} onClick={() => upd(() => { d.scripted = false; })}>Manual</button>
      </div>
      {!d.scripted && (
        <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
          {([0, 2, 1] as Axis[]).map((a) => (
            <button key={a} className="btn sm" aria-pressed={d.manual.tremorAxis === a} onClick={() => upd(() => { d.manual.tremorAxis = d.manual.tremorAxis === a ? null : a; })}>
              {AXIS_SHORT[a]} tremor
            </button>
          ))}
          <button className="btn sm" aria-pressed={d.manual.walking} onClick={() => upd(() => { d.manual.walking = !d.manual.walking; })}>Walking</button>
          <button className="btn sm" aria-pressed={!d.manual.finger} onClick={() => upd(() => { d.manual.finger = !d.manual.finger; })}>Finger off</button>
        </div>
      )}
      <p className="fine" style={{ marginTop: 'var(--s-3)' }}>Simulated data that imitates the firmware's output. Not a recording of a real person.</p>
    </section>
  );
}

function DisplayCard({ canSend }: { canSend: boolean }) {
  const st = useSettings();
  const m = st.mapping;
  return (
    <section className="card" aria-label="Display and detection">
      <div className="card-title"><span>Display and detection</span></div>
      {st.viewMode === '3d' && (
        <div className="field">
          <span className="label">Camera</span>
          <div className="segmented" role="group" aria-label="Camera">
            {(['three-quarter', 'front', 'side'] as const).map((v) => (
              <button key={v} aria-pressed={st.cameraView === v} onClick={() => st.set({ cameraView: v })}>{v === 'three-quarter' ? '¾' : v === 'front' ? 'Front' : 'Side'}</button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <div className="field-row"><label htmlFor="ex">Tremor exaggeration</label><output htmlFor="ex">{st.exaggeration}×</output></div>
        <input id="ex" type="range" min={1} max={10} step={0.5} value={st.exaggeration} onChange={(e) => st.set({ exaggeration: +e.target.value })} />
        <p className="fine">Only the fast part of the motion is enlarged, so small shakes are visible. 1× shows the true motion.</p>
      </div>
      {st.viewMode === '2d' && (
        <div className="field">
          <div className="field-row"><label htmlFor="rng">Circle range</label><output htmlFor="rng">±{st.range2d}°</output></div>
          <input id="rng" type="range" min={8} max={60} value={st.range2d} onChange={(e) => st.set({ range2d: +e.target.value })} />
          <label className="check"><input type="checkbox" checked={st.trail} onChange={(e) => st.set({ trail: e.target.checked })} /> Trail</label>
        </div>
      )}
      <div className="field">
        <label htmlFor="sens">Tremor sensitivity (sent to the device)</label>
        <select id="sens" value={st.sensitivity} disabled={!canSend} onChange={async (e) => { const v = +e.target.value; st.set({ sensitivity: v }); await live.sendSensitivity(v); }}>
          <option value={1}>1 – strict</option><option value={2}>2 – default</option><option value={3}>3</option><option value={4}>4</option><option value={5}>5 – very sensitive</option>
        </select>
        <p className="fine">{canSend ? 'Raise it if real shaking is missed, lower it if ordinary movement is flagged.' : 'Connect a device to change this.'}</p>
      </div>
      <details className="disclosure">
        <summary>Axis mapping (how the board sits on the head)</summary>
        <div className="body">
          <label className="check"><input type="checkbox" checked={m.flipPitch} onChange={(e) => st.set({ mapping: { ...m, flipPitch: e.target.checked } })} /> Flip nod</label>
          <label className="check"><input type="checkbox" checked={m.flipRoll} onChange={(e) => st.set({ mapping: { ...m, flipRoll: e.target.checked } })} /> Flip tilt</label>
          <label className="check"><input type="checkbox" checked={m.flipYaw} onChange={(e) => st.set({ mapping: { ...m, flipYaw: e.target.checked } })} /> Flip turn</label>
          <label className="check"><input type="checkbox" checked={m.swapPitchRoll} onChange={(e) => st.set({ mapping: { ...m, swapPitchRoll: e.target.checked } })} /> Swap nod and tilt (board turned 90°)</label>
        </div>
      </details>
    </section>
  );
}

function HowComputed() {
  return (
    <section className="card flat">
      <details className="disclosure" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <summary>How this is computed</summary>
        <div className="body">
          <p><b>Orientation.</b> The board's gyroscope and accelerometer are blended (complementary filter) into nod and tilt angles. Turn is integrated from the gyroscope only, so it drifts slowly: use Recenter.</p>
          <p><b>Tremor.</b> Every 0.1 s the board looks at the last 1.5 s of motion on each axis. An alert needs all of: strong motion between 3.5 and 8.5 Hz, most of the energy in that band, shaking across the whole window, and at least 4 evenly spaced, repeating cycles. It takes about 1.7 s to raise an alert.</p>
          <p><b>Walking.</b> Step bounce has harmonics inside the tremor band. While a step rhythm is detected, motion at a multiple of the step rate is ignored and a stronger signal is needed. A real tremor at exactly a step harmonic can't be told apart while walking.</p>
          <p><b>Heart rate and SpO₂.</b> From the red and infrared light of a hobby sensor. SpO₂ uses a generic curve and is not calibrated.</p>
          <p>This is a prototype for demonstration. It does not diagnose anything and has not been clinically validated.</p>
        </div>
      </details>
    </section>
  );
}
