import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { live, useLive, type LiveSnapshot } from '../device/live';
import { axesOf, type Axis } from '../logic/csv';
import { useSettings, thresholds } from '../state/settings';
import Circle2D from '../components/Circle2D';
import { PulseTrace, Waveform } from '../components/Traces';
import { IconCircle, IconCube, IconRecenter } from '../components/icons';
import { recorder, useRecorder } from '../data/recorder';
import { download } from '../data/csvExport';
import { formatRecording, gzipText } from '../logic/recording';
import { scoreBand } from '../logic/severity';
import { PATTERN_LABEL } from '../logic/multiaxis';
import { PROMPT_TEXT } from '../logic/posture';
import { AXIS_LONG, AXIS_SHORT, AXIS_VAR, axesLong, axesShort, fmtDuration, fmtMinutes, fmtPct, fmtScore } from '../logic/labels';

const Head3D = lazy(() => import('../components/Head3D'));

function headline(s: LiveSnapshot): { title: string; sub: string; tone: 'alert' | 'ok' | 'quiet' } {
  const f = s.frame;
  if (!s.fresh || !f) {
    if (s.conn === 'open' || s.conn === 'connecting') return { title: 'Waiting for data', sub: s.message || 'The board calibrates for about 2 seconds after it starts. Keep it still.', tone: 'quiet' };
    return { title: 'Not connected', sub: 'Connect the headset, or try demo mode.', tone: 'quiet' };
  }
  if (s.tremorActive) {
    const axes = axesOf(f.axes);
    const what = axes.length > 1 ? `${axesLong(axes)}${s.combo && s.combo.pattern !== 'single' ? `, ${PATTERN_LABEL[s.combo.pattern]}` : ''}` : AXIS_LONG[f.dir];
    return { title: 'Tremor detected', sub: `${what}${f.freq > 0 ? `, about ${f.freq.toFixed(1)} Hz` : ''}${f.walking ? ', while walking' : ''}`, tone: 'alert' };
  }
  if (f.walking) return { title: 'Walking', sub: `Step rhythm ${f.stepHz > 0 ? f.stepHz.toFixed(1) + ' steps/s' : 'detected'} is ignored. Tremor needs a stronger signal now.`, tone: 'ok' };
  return { title: 'Steady', sub: 'No rhythmic shaking between 3.5 and 8.5 Hz.', tone: 'ok' };
}

function useTremorAnnouncer(active: boolean, axes: number) {
  const [msg, setMsg] = useState('');
  const prev = useRef(false);
  const prevAxes = useRef(0);
  useEffect(() => {
    if (active !== prev.current || (active && axes !== prevAxes.current)) {
      setMsg(active ? `Tremor detected: ${axesLong(axesOf(axes))}` : 'Tremor ended');
      prev.current = active;
      prevAxes.current = axes;
    }
  }, [active, axes]);
  return msg;
}

export default function Live({ onConnect }: { onConnect: () => void }) {
  const s = useLive();
  const st = useSettings();
  const rec = useRecorder();
  const h = headline(s);
  const f = s.fresh ? s.frame : null;
  const announce = useTremorAnnouncer(s.tremorActive, f?.axes ?? 0);
  const axes = f && s.tremorActive ? axesOf(f.axes) : [];

  return (
    <div className="page wide">
      <p className="sr-only" role="status" aria-live="assertive">{announce}</p>

      <div className="col">
        <div className="hero-text">
          <h1 className={h.tone === 'alert' ? 'alert' : undefined}>{h.title}</h1>
          <p>{h.sub}</p>
        </div>

        {rec.posturePrompt && (
          <div className="notice prompt" role="status">
            <span>{PROMPT_TEXT[rec.posturePrompt]}</span>
            <button className="btn sm" onClick={() => recorder.dismissPosturePrompt()}>OK</button>
          </div>
        )}

        <section className={`card stage${s.tremorActive ? ' alert' : ''}`} aria-label="Head orientation">
          <div className="stage-view" role="img" aria-label={f ? `Head: nod ${live.disp.pitch.toFixed(0)}°, tilt ${live.disp.roll.toFixed(0)}°, turn ${live.disp.yaw.toFixed(0)}°` : 'Head view, no data'}>
            {st.viewMode === '3d'
              ? <Suspense fallback={<div className="stage-loading fine">Loading 3D view…</div>}><Head3D /></Suspense>
              : <div className="stage-2d"><Circle2D /></div>}
          </div>
          <div className="stage-top">
            {s.tremorActive && f
              ? <span className="chip alert">{axesShort(axes)} · {f.freq.toFixed(1)} Hz</span>
              : f ? <span className="chip ok">{f.walking ? 'Walking' : 'Steady'}</span> : <span className="chip quiet">No data</span>}
            {s.tremorActive && s.combo && s.combo.pattern !== 'single' && <span className="chip">{s.combo.pattern === 'independent' ? 'Two rhythms' : s.combo.pattern[0].toUpperCase() + s.combo.pattern.slice(1)}</span>}
            {(s.source === 'demo' || s.source === 'replay') && <span className="chip quiet">{s.source === 'demo' ? 'Demo' : 'Replay'}</span>}
          </div>
          <div className="stage-bottom">
            <div className="segmented" role="group" aria-label="View">
              <button aria-pressed={st.viewMode === '3d'} onClick={() => st.set({ viewMode: '3d' })}><span className="seg-ico"><IconCube /></span>3D</button>
              <button aria-pressed={st.viewMode === '2d'} onClick={() => st.set({ viewMode: '2d' })}><span className="seg-ico"><IconCircle /></span>2D</button>
            </div>
            <button className="icon-btn" onClick={() => live.recenter()} aria-label="Recenter: make the current pose straight ahead" title="Recenter (C)"><IconRecenter /></button>
          </div>
        </section>

        {!f && <button className="btn primary" onClick={onConnect}>Connect a device</button>}

        <div className="grid-3">
          <div className="card metric">
            <div className="label">Frequency</div>
            <div className="value">{f && f.freq > 0 ? f.freq.toFixed(1) : '–'}<small>Hz</small></div>
          </div>
          <div className="card metric">
            <div className="label">Amplitude</div>
            <div className="value">{f ? (axes.length > 1 ? Math.hypot(...axes.map((a) => [f.ampP, f.ampR, f.ampY][a])) : Math.max(f.ampP, f.ampR, f.ampY)).toFixed(1) : '–'}<small>°/s</small></div>
          </div>
          <div className="card metric">
            <div className="label">{f?.walking ? 'Steps' : 'Cycles'}</div>
            <div className="value">{f ? (f.walking ? f.stepHz.toFixed(1) : f.tremor && f.cycles > 0 ? f.cycles : '–') : '–'}<small>{f?.walking ? '/s' : ''}</small></div>
          </div>
        </div>
        <TodayCard />
        <PostureCard fresh={!!f} />
      </div>

      <div className="col">
        <VitalsCard s={s} />
        <AxisCard s={s} />
        <section className="card">
          <div className="card-title"><span>Motion in the tremor band</span></div>
          <Waveform />
        </section>
        {s.source === 'demo' && <DemoCard label={s.demoLabel} />}
        {s.source === 'replay' && <p className="notice">Replaying: {s.replayLabel}. Recorded data, not live.</p>}
        <DisplayCard canSend={s.canSend} />
        <RecordCard s={s} />
        <HowComputed />
      </div>
    </div>
  );
}

function VitalsCard({ s }: { s: LiveSnapshot }) {
  const r = useRecorder();
  const f = s.fresh ? s.frame : null;
  const st = f?.ppgState ?? -2;
  const ok = st === 3;
  const msg = !f ? 'Waiting for data'
    : st === -1 ? 'This firmware does not send heart rate. Flash the latest sketch.'
    : st === 0 ? 'Pulse sensor not found. Check its wiring (SDA 21, SCL 22, 3V3, GND).'
    : st === 1 ? 'Rest a fingertip gently on the sensor (no pressing, keep it still).'
    : st === 2 ? 'Measuring. Hold still for about 10 seconds.'
    : 'Live reading. SpO₂ is an uncalibrated estimate from a hobby sensor.';
  const rest = r.lastResting;
  const restMin = Math.round(thresholds().resting.restMinS / 60);
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
      <div className="rest-line">
        <span className="fine">Resting</span>
        {rest
          ? <span>{Math.round(rest.bpm)} bpm{rest.spo2 ? ` · ${Math.round(rest.spo2)} %` : ''} <span className={`chip ${rest.quality === 'good' ? 'ok' : rest.quality === 'fair' ? 'quiet' : 'warn'}`}>{rest.quality}</span></span>
          : <span className="fine">after {restMin} min of keeping still</span>}
      </div>
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
        const on = s.tremorActive && !!f && ((f.axes >> i) & 1) === 1;
        return (
          <div className={`axis-row${on ? ' on' : ''}`} key={i}>
            <i className="sw" style={{ background: `var(${AXIS_VAR[i]})` }} />
            <span>{AXIS_LONG[i]}</span>
            <div className="track" role="meter" aria-valuemin={0} aria-valuemax={30} aria-valuenow={Number(amps[i].toFixed(1))} aria-label={`${AXIS_LONG[i]} amplitude${on ? ', shaking' : ''}`}>
              <i style={{ width: `${Math.min(1, amps[i] / 30) * 100}%`, background: on ? 'var(--accent)' : `var(${AXIS_VAR[i]})` }} />
            </div>
            <b>{amps[i].toFixed(1)}</b>
          </div>
        );
      })}
      {s.combo && s.combo.pair && (
        <p className="fine" style={{ marginTop: 'var(--s-2)' }}>
          {AXIS_SHORT[s.combo.pair[0]]} {s.combo.freqHz[s.combo.pair[0]].toFixed(1)} Hz, {AXIS_SHORT[s.combo.pair[1]]} {s.combo.freqHz[s.combo.pair[1]].toFixed(1)} Hz
          {s.combo.phaseDeg !== null && s.combo.pattern !== 'independent' ? `, ${Math.round(Math.abs(s.combo.phaseDeg))}° apart` : ''}: {PATTERN_LABEL[s.combo.pattern]}.
        </p>
      )}
    </section>
  );
}

function TodayCard() {
  const r = useRecorder();
  const t = r.today;
  return (
    <section className="card" aria-label="Today so far">
      <div className="card-title"><span>Today so far</span><a className="fine" href="#/trends">Trends</a></div>
      <div className="grid-3">
        <div><div className="fine">Severity</div><div className="stat">{fmtScore(t?.score ?? null)}<span className="fine"> / 10</span></div><div className="fine">{scoreBand(t?.score ?? null)}</div></div>
        <div><div className="fine">Episodes</div><div className="stat">{t?.episodes ?? 0}</div><div className="fine">{fmtMinutes(t?.tremorS ?? 0)} shaking</div></div>
        <div><div className="fine">{r.current ? 'This episode' : 'This session'}</div><div className="stat">{r.current ? fmtDuration(r.current.durationS) : r.recording ? fmtMinutes(r.sessionMonitoredS) : '–'}</div><div className="fine">{r.current ? `score ${fmtScore(r.current.score)} so far` : r.recording ? `${r.sessionEpisodes} episode${r.sessionEpisodes === 1 ? '' : 's'}` : 'not recording'}</div></div>
      </div>
      {r.storageError && <p className="notice warn" role="alert" style={{ marginTop: 'var(--s-3)' }}>{r.storageError}</p>}
    </section>
  );
}

function PostureCard({ fresh }: { fresh: boolean }) {
  const r = useRecorder();
  const st = useSettings();
  const pc = thresholds().posture;
  const smp = r.lastSample;
  const p = r.todayPosture;
  const cal = r.calibration;
  const dev = smp && smp.devForward !== null && smp.devForward !== undefined ? { forward: smp.devForward, tilt: smp.devTilt ?? 0 } : null;
  const zoneText = { ok: 'Within your usual range', forward: 'Head forward', back: 'Head back', tilt: 'Tilted to one side' } as const;
  return (
    <section className="card" aria-label="Posture and stillness">
      <div className="card-title"><span>Posture and stillness</span>{smp?.state && <span className="chip quiet">{smp.state === 'still' ? 'Still' : smp.state === 'restless' ? 'Restless' : smp.state === 'walking' ? 'Walking' : 'Moving a little'}</span>}</div>
      {!st.neutralPose && cal.state !== 'collecting' && <p className="fine">Calibrate once while sitting comfortably upright. Posture is then measured against your own neutral position.</p>}
      {dev && (
        <div className="pose-grid">
          <div><div className="fine">Forward / back</div><div className="stat">{dev.forward >= 0 ? `${dev.forward.toFixed(0)}° forward` : `${(-dev.forward).toFixed(0)}° back`}</div></div>
          <div><div className="fine">Side tilt</div><div className="stat">{Math.abs(dev.tilt).toFixed(0)}°{Math.abs(dev.tilt) >= 1 ? (dev.tilt > 0 ? ' right' : ' left') : ''}</div></div>
          <div className="pose-zone"><span className={`chip ${smp?.zone === 'ok' ? 'ok' : 'warn'}`}>{zoneText[smp?.zone ?? 'ok']}</span></div>
        </div>
      )}
      <div className="grid-3" style={{ marginTop: 'var(--s-3)' }}>
        <div><div className="fine">Still today</div><div className="stat">{fmtMinutes(p.stillS)}</div></div>
        <div><div className="fine">Restless</div><div className="stat">{fmtMinutes(p.restlessS)}</div></div>
        <div><div className="fine">Outside range</div><div className="stat">{p.poseMonitoredS > 0 ? fmtPct(p.outsidePoseS / p.poseMonitoredS) : '–'}</div></div>
      </div>
      {cal.state === 'collecting' && (
        <div style={{ marginTop: 'var(--s-3)' }} role="status">
          <p className="fine">Hold your head comfortably upright and still…</p>
          <div className="progress"><i style={{ width: `${Math.round(cal.progress * 100)}%` }} /></div>
        </div>
      )}
      {cal.state === 'failed' && <p className="notice warn" role="alert" style={{ marginTop: 'var(--s-3)' }}>{cal.reason}</p>}
      {cal.state === 'done' && <p className="fine" role="status" style={{ marginTop: 'var(--s-3)' }}>Neutral position saved.</p>}
      <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
        <button className="btn sm" onClick={() => recorder.calibrate()} disabled={!fresh || cal.state === 'collecting'}>{st.neutralPose ? 'Recalibrate neutral position' : 'Calibrate neutral position'}</button>
        <label className="check"><input type="checkbox" checked={st.postureMonitoring} onChange={(e) => st.set({ postureMonitoring: e.target.checked })} /> Gentle reminders</label>
      </div>
      <details className="disclosure">
        <summary>How this is measured</summary>
        <div className="body">
          <p>Each second the app looks at how much your head moved. Under {pc.stillMaxDeg}° is "still", over {pc.restlessMinDeg}° (not walking) is "restless".</p>
          <p>After calibration, more than {pc.droopMaxDeg}° forward, {pc.backMaxDeg}° back or {pc.tiltMaxDeg}° to the side counts as outside your range. A gentle reminder appears after about {Math.round(pc.promptAfterS / 60)} minutes mostly outside it, at most once every {Math.round(pc.promptCooldownS / 60)} minutes.</p>
          <p>Headsets sit differently on each person and can shift. Recalibrate if the numbers look off. These are comfort reminders, not a medical assessment.</p>
        </div>
      </details>
    </section>
  );
}

function DemoCard({ label }: { label: string }) {
  const [, force] = useState(0);
  const d = live.demo;
  const m = d.manual;
  const upd = (fn: () => void) => { fn(); force((x) => x + 1); };
  const toggleAxis = (a: Axis) => upd(() => { m.tremorAxes = m.tremorAxes.includes(a) ? m.tremorAxes.filter((x) => x !== a) : [...m.tremorAxes, a]; });
  return (
    <section className="card sunk" aria-label="Demo controls">
      <div className="card-title"><span>Demo controls</span>{d.scripted && label && <span className="chip quiet">{label}</span>}</div>
      <div className="segmented" role="group" aria-label="Demo mode">
        <button aria-pressed={d.scripted} onClick={() => upd(() => { d.scripted = true; })}>Scripted showcase</button>
        <button aria-pressed={!d.scripted} onClick={() => upd(() => { d.scripted = false; })}>Manual</button>
      </div>
      {!d.scripted && (
        <>
          <p className="fine" style={{ marginTop: 'var(--s-3)' }}>Tremor axes (pick one or more)</p>
          <div className="btn-row" style={{ marginTop: 'var(--s-2)' }}>
            {([0, 2, 1] as Axis[]).map((a) => (
              <button key={a} className="btn sm" aria-pressed={m.tremorAxes.includes(a)} onClick={() => toggleAxis(a)}>{AXIS_SHORT[a]}</button>
            ))}
            {m.tremorAxes.length > 1 && (
              <div className="segmented" role="group" aria-label="Timing between the axes">
                <button aria-pressed={m.comboPhaseDeg === 0} onClick={() => upd(() => { m.comboPhaseDeg = 0; })}>In step</button>
                <button aria-pressed={m.comboPhaseDeg === 90} onClick={() => upd(() => { m.comboPhaseDeg = 90; })}>Quarter cycle</button>
              </div>
            )}
          </div>
          <div className="btn-row" style={{ marginTop: 'var(--s-2)' }}>
            <button className="btn sm" aria-pressed={m.walking} onClick={() => upd(() => { m.walking = !m.walking; })}>Walking</button>
            <button className="btn sm" aria-pressed={m.droopDeg > 0} onClick={() => upd(() => { m.droopDeg = m.droopDeg > 0 ? 0 : 22; m.still = m.droopDeg > 0; })}>Head forward</button>
            <button className="btn sm" aria-pressed={m.still} onClick={() => upd(() => { m.still = !m.still; })}>Hold still</button>
            <button className="btn sm" aria-pressed={!m.finger} onClick={() => upd(() => { m.finger = !m.finger; })}>Finger off</button>
            <button className="btn sm" aria-pressed={m.fall} onClick={() => upd(() => { m.fall = !m.fall; })}>{m.fall ? 'Get up' : 'Simulate a fall'}</button>
          </div>
        </>
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

function RecordCard({ s }: { s: LiveSnapshot }) {
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    const rec = live.stopRawRecording();
    if (!rec) return;
    setBusy(true);
    try {
      const name = `tremor-${new Date(rec.start).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.rec.gz`;
      download(name, await gzipText(formatRecording(rec)));
    } finally { setBusy(false); }
  };
  return (
    <section className="card flat" aria-label="Raw stream recording">
      <div className="card-title"><span>Record the raw stream</span>{s.recordingRaw && <span className="chip"><span className="rec-dot" />{s.rawLines} lines</span>}</div>
      <p className="fine">Saves the exact data from the device to a file you can replay later, for example as a backup for a live demo. Not needed for history, which is saved automatically.</p>
      <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
        {s.recordingRaw
          ? <button className="btn accent sm" onClick={stop} disabled={busy}>Stop and download</button>
          : <button className="btn sm" onClick={() => live.startRawRecording()} disabled={!s.fresh}>Start recording</button>}
      </div>
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
          <p><b>Several axes at once.</b> When another axis (for example "yes-yes" alongside "no-no") passes the same tests on its own and is at least 30 % as strong, it is reported too. The app then compares the two signals: in step = diagonal, a quarter cycle apart = circular, different frequencies = two separate rhythms.</p>
          <p><b>Walking.</b> Step bounce has harmonics inside the tremor band. While a step rhythm is detected, motion at a multiple of the step rate is ignored and a stronger signal is needed. A real tremor at exactly a step harmonic can't be told apart while walking.</p>
          <p><b>Heart rate and SpO₂.</b> From the red and infrared light of a hobby sensor. SpO₂ uses a generic curve and is not calibrated. "Resting" values only use readings taken after several minutes of keeping still.</p>
          <p>This is a prototype for demonstration. It does not diagnose anything and has not been clinically validated.</p>
        </div>
      </details>
    </section>
  );
}
