import { useCallback, useEffect, useMemo, useState } from 'react';
import DailyChart from '../components/charts/DailyChart';
import MiniLine from '../components/charts/MiniLine';
import EpisodeSheet from '../components/EpisodeSheet';
import { importRecords, listEpisodes, listEvents, listSessions, listVitals, onDataChanged } from '../data/db';
import { useRecorder } from '../data/recorder';
import { DAY_MS, nextDay, rollingMean, startOfDay, summarizeDays, summarizeWeeks } from '../logic/daily';
import { AXIS_VAR, SOURCE_LABEL, axesShort, episodeAxes, fmtDate, fmtDuration, fmtMinutes, fmtPct, fmtScore, fmtTime } from '../logic/labels';
import { summarizeVitals, vitalsFlags, type RestingReading } from '../logic/vitals';
import { thresholds } from '../state/settings';
import type { Episode, FallEvent, Session } from '../logic/model';
import { generateSampleHistory } from '../logic/sampleHistory';
import { scoreBand } from '../logic/severity';
import { SEVERITY } from '../config/thresholds';
import { useSettings } from '../state/settings';

const RANGES = [7, 30, 90] as const;

function useHistory(rangeDays: number, includeDemo: boolean) {
  const [data, setData] = useState<{ sessions: Session[]; episodes: Episode[]; vitals: RestingReading[]; events: FallEvent[]; from: number; to: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const to = nextDay(Date.now()) - 1;
    const from = startOfDay(to - (rangeDays - 1) * DAY_MS);
    try {
      const f = { includeDemo };
      const [sessions, episodes, vitals, events] = await Promise.all([listSessions(from, to, f), listEpisodes(from, to, f), listVitals(from, to, f), listEvents(from, to, f)]);
      setData({ sessions, episodes, vitals, events, from, to });
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [rangeDays, includeDemo]);
  useEffect(() => { void load(); return onDataChanged(() => void load()); }, [load]);
  return { data, err };
}

export default function Trends() {
  const [range, setRange] = useState<number>(30);
  const showDemo = useSettings((s) => s.showDemoData);
  const set = useSettings((s) => s.set);
  const { data, err } = useHistory(range, showDemo);
  const rec = useRecorder();
  const [open, setOpen] = useState<Episode | null>(null);
  const [limit, setLimit] = useState(20);

  const days = useMemo(() => (data ? summarizeDays(data.sessions, data.episodes, data.from, Math.min(data.to, Date.now())) : []), [data]);
  const avg = useMemo(() => rollingMean(days), [days]);
  const weeks = useMemo(() => summarizeWeeks(days).reverse(), [days]);
  const episodes = useMemo(() => (data ? [...data.episodes].sort((a, b) => b.start - a.start) : []), [data]);
  const sessions = useMemo(() => (data ? [...data.sessions].sort((a, b) => b.start - a.start) : []), [data]);
  const hasDemo = !!data && (data.sessions.some((s) => s.demo) || data.episodes.some((e) => e.demo));
  const today = rec.today;
  const vdays = useMemo(() => (data ? summarizeVitals(data.vitals, data.from, Math.min(data.to, Date.now())) : []), [data]);
  const flags = useMemo(() => vitalsFlags(vdays, thresholds().resting), [vdays]);
  const events = useMemo(() => (data ? [...data.events].sort((a, b) => b.t - a.t) : []), [data]);
  const postureDays = useMemo(() => [...days].reverse().filter((d) => d.monitoredS > 0).slice(0, 7), [days]);

  const loadSample = async () => {
    const h = generateSampleHistory(28, Date.now(), Math.floor(Math.random() * 1000));
    await importRecords(h.sessions, h.episodes, h.vitals, h.events);
    if (!showDemo) set({ showDemoData: true });
  };

  if (err) return <div className="page"><p className="notice warn" role="alert">Could not read local history: {err}</p></div>;
  const empty = data && data.sessions.length === 0;

  return (
    <div className="page wide">
      <div className="topline full">
        <div className="hero-text"><h1>Trends</h1><p>Tremor severity over time, from data stored on this device.</p></div>
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r} days</button>)}
        </div>
      </div>

      {hasDemo && (
        <p className="notice full" style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span>Includes demo, replay or sample data (not from a real person).</span>
          <button className="btn sm" onClick={() => set({ showDemoData: false })}>Hide demo data</button>
        </p>
      )}
      {!showDemo && <p className="notice full">Demo data is hidden. <button className="btn sm ghost" onClick={() => set({ showDemoData: true })}>Show it</button></p>}

      {empty ? (
        <section className="card full">
          <div className="card-title"><span>No history yet</span></div>
          <p className="muted">History builds up while a device (or the demo) is connected. Every connection becomes a session, and every tremor alert longer than a second becomes an episode.</p>
          <div className="btn-row" style={{ marginTop: 'var(--s-4)' }}>
            <a className="btn primary" href="#/live">Go to Live</a>
            <button className="btn" onClick={loadSample}>Load 4 weeks of sample history</button>
          </div>
        </section>
      ) : (
        <>
          <div className="col">
            <section className="card" aria-label="Today">
              <div className="card-title"><span>Today</span><span className="fine">{rec.recording ? 'recording now' : ''}</span></div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
                {today?.score != null ? <div className="hero-figure">{fmtScore(today.score)}<small>/ 10</small></div> : <div className="stat muted">No score yet</div>}
                <span className="chip quiet">{scoreBand(today?.score ?? null)}</span>
              </div>
              {today && today.score === null && <p className="fine">Needs at least {SEVERITY.minMonitoredS / 60} minutes of monitoring today ({fmtMinutes(today.monitoredS)} so far).</p>}
              <div className="grid-2 stats" style={{ marginTop: 'var(--s-4)' }}>
                <div><div className="fine">Episodes</div><div className="stat">{today?.episodes ?? 0}</div></div>
                <div><div className="fine">Time shaking</div><div className="stat">{fmtMinutes(today?.tremorS ?? 0)}</div></div>
                <div><div className="fine">Share of time</div><div className="stat">{today && today.monitoredS > 0 ? fmtPct(today.tremorS / Math.max(today.monitoredS, today.tremorS)) : '–'}</div></div>
                <div><div className="fine">Monitored</div><div className="stat">{fmtMinutes(today?.monitoredS ?? 0)}</div></div>
              </div>
            </section>

            <section className="card" aria-label="Daily severity">
              <div className="card-title"><span>Daily severity, last {range} days</span><span className="fine">0–10</span></div>
              <DailyChart days={days} avg={avg} title={`Daily severity score, last ${range} days`} />
            </section>

            <section className="card" aria-label="Resting heart rate and SpO2">
              <div className="card-title"><span>Resting heart rate and SpO₂</span><span className="fine">daily median</span></div>
              {vdays.every((d) => d.bpm === null)
                ? <p className="muted">No resting readings yet. They are taken after {Math.round(thresholds().resting.restMinS / 60)} minutes of keeping still with a fingertip on the sensor.</p>
                : <>
                    <p className="fine" style={{ marginBottom: 'var(--s-2)' }}>Heart rate (bpm)</p>
                    <MiniLine title="Daily median resting heart rate" unit="bpm" domain={[40, 120]} ticks={[40, 60, 80, 100, 120]} points={vdays.map((d) => ({ t: d.dayStart, v: d.bpm, note: d.n ? `${d.n} reading${d.n === 1 ? '' : 's'}` : undefined }))} color="var(--heart)" />
                    <p className="fine" style={{ margin: 'var(--s-4) 0 var(--s-2)' }}>SpO₂ estimate (%)</p>
                    <MiniLine title="Daily median resting SpO2 estimate" unit="%" domain={[85, 100]} ticks={[85, 90, 95, 100]} points={vdays.map((d) => ({ t: d.dayStart, v: d.spo2, note: d.n ? `${d.n} reading${d.n === 1 ? '' : 's'}` : undefined }))} band={{ from: 85, to: thresholds().resting.lowSpo2Pct, label: `Below ${thresholds().resting.lowSpo2Pct} %` }} />
                  </>}
              {flags.map((f) => <p key={f.kind} className="notice warn" style={{ marginTop: 'var(--s-3)' }}>{f.text}</p>)}
              <p className="fine" style={{ marginTop: 'var(--s-3)' }}>Only readings taken while still, with a valid pulse signal, and rated good or fair are used. The SpO₂ value is an uncalibrated estimate from a hobby sensor.</p>
            </section>

            <section className="card" aria-label="Weekly summary">
              <div className="card-title"><span>By week</span></div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th scope="col">Week of</th><th scope="col">Avg score</th><th scope="col">Episodes</th><th scope="col">Shaking</th><th scope="col">Monitored</th></tr></thead>
                  <tbody>
                    {weeks.map((w) => (
                      <tr key={w.weekStart}>
                        <th scope="row">{fmtDate(w.weekStart, { day: 'numeric', month: 'short' })}</th>
                        <td>{w.meanScore === null ? '–' : `${fmtScore(w.meanScore)} (${w.scoredDays} d)`}</td>
                        <td>{w.episodes}</td><td>{fmtMinutes(w.tremorS)}</td><td>{fmtMinutes(w.monitoredS)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="col">
            <section className="card" aria-label="Episodes">
              <div className="card-title"><span>Episodes</span><span className="fine">{episodes.length} in range</span></div>
              {episodes.length === 0 && <p className="muted">No tremor episodes in this period.</p>}
              <ul className="ep-list">
                {episodes.slice(0, limit).map((e) => (
                  <li key={e.id}>
                    <button className="ep-row" onClick={() => setOpen(e)} aria-label={`Episode ${fmtDate(e.start)} ${fmtTime(e.start)}, ${fmtDuration(e.durationS)}, ${axesShort(episodeAxes(e))}, score ${fmtScore(e.score)}`}>
                      <span className="ep-when"><b>{fmtTime(e.start)}</b><span>{fmtDate(e.start, { day: 'numeric', month: 'short' })}</span></span>
                      <span className="ep-mid">
                        <span>{episodeAxes(e).map((a) => <i key={a} className="sw" style={{ background: `var(${AXIS_VAR[a]})` }} />)}{axesShort(episodeAxes(e))} · {e.freqHz.toFixed(1)} Hz{e.pattern && e.pattern !== 'single' ? ` · ${e.pattern === 'independent' ? 'two rhythms' : e.pattern}` : ''}</span>
                        <span className="fine">{fmtDuration(e.durationS)}{e.demo ? ' · demo' : ''}</span>
                      </span>
                      <span className="score-pill">{fmtScore(e.score)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {episodes.length > limit && <button className="btn sm" onClick={() => setLimit((l) => l + 30)}>Show more</button>}
            </section>

            <section className="card" aria-label="Posture and stillness">
              <div className="card-title"><span>Posture and stillness</span><span className="fine">last 7 days with data</span></div>
              {postureDays.length === 0 ? <p className="muted">No data yet.</p> : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead><tr><th scope="col">Day</th><th scope="col">Still</th><th scope="col">Restless</th><th scope="col">Outside range</th></tr></thead>
                    <tbody>{postureDays.map((d) => (
                      <tr key={d.day}><th scope="row">{fmtDate(d.dayStart, { weekday: 'short', day: 'numeric' })}</th><td>{fmtMinutes(d.stillS)}</td><td>{fmtMinutes(d.restlessS)}</td><td>{d.poseMonitoredS > 0 ? fmtPct(d.outsidePoseS / d.poseMonitoredS) : 'not calibrated'}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              <p className="fine" style={{ marginTop: 'var(--s-2)' }}>"Outside range" is measured against your calibrated neutral position (Live screen).</p>
            </section>

            <section className="card" aria-label="Impact events">
              <div className="card-title"><span>Falls and impacts</span><span className="fine">{events.length} in range</span></div>
              {events.length === 0 ? <p className="muted">No fall or impact candidates.</p> : (
                <ul className="ep-list">
                  {events.slice(0, 10).map((e) => (
                    <li key={e.id} className="sess-row">
                      <span className="ep-when"><b>{fmtTime(e.t)}</b><span>{fmtDate(e.t, { day: 'numeric', month: 'short' })}</span></span>
                      <span className="ep-mid"><span>Peak {e.peakG.toFixed(1)} g{e.freeFallMs ? `, free fall ${e.freeFallMs} ms` : ''}</span><span className="fine">{e.path === 'impact' ? 'impact without free fall' : 'free fall, then impact'}{e.demo ? ' · demo' : ''}</span></span>
                      <span className={`chip ${e.outcome === 'cancelled' ? 'quiet' : e.outcome === 'pending' ? '' : 'warn'}`}>{e.outcome === 'cancelled' ? "Said I'm OK" : e.outcome === 'confirmed' ? 'Help requested' : e.outcome === 'no-response' ? 'No response' : 'Pending'}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="fine" style={{ marginTop: 'var(--s-2)' }}>Heuristic candidates: some falls are missed, and dropping the headset looks like a fall.</p>
            </section>

            <section className="card" aria-label="Sessions">
              <div className="card-title"><span>Sessions</span><span className="fine">{sessions.length}</span></div>
              <ul className="ep-list">
                {sessions.slice(0, 12).map((s) => (
                  <li key={s.id} className="sess-row">
                    <span className="ep-when"><b>{fmtDate(s.start, { day: 'numeric', month: 'short' })}</b><span>{fmtTime(s.start)}–{fmtTime(s.end)}</span></span>
                    <span className="ep-mid"><span>{fmtMinutes(s.monitoredS)} monitored</span><span className="fine">{s.episodes} episode{s.episodes === 1 ? '' : 's'} · {fmtMinutes(s.tremorS)} shaking</span></span>
                    <span className={`chip ${s.demo ? 'quiet' : ''}`}>{s.open ? 'Live' : SOURCE_LABEL[s.source]}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card flat">
              <details className="disclosure" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
                <summary>How the score is computed</summary>
                <div className="body">
                  <p><b>Episode score.</b> Combines how far the head moves (θ = amplitude ÷ 2π·frequency, in degrees) on a log scale from {SEVERITY.theta0Deg}° to {SEVERITY.thetaMaxDeg}°, weighted {SEVERITY.wIntensity}, with duration on a log scale from {SEVERITY.d0S} s to {SEVERITY.dMaxS / 60} min, weighted {SEVERITY.wDuration}. Each part is capped, so the score stays between 0 and 10.</p>
                  <p><b>Daily score.</b> Sum of (duration × intensity) over the day's episodes, divided by monitored time: the intensity-weighted share of time spent shaking, on a log scale. Days with less than {SEVERITY.minMonitoredS / 60} minutes of monitoring show no score. A stronger, longer or additional episode never lowers it.</p>
                  <p>An engineering score for tracking your own trend. It is not a clinical rating and cannot be compared with clinical scales. Full details: docs/SEVERITY.md.</p>
                </div>
              </details>
            </section>
          </div>
        </>
      )}
      {open && <EpisodeSheet ep={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
