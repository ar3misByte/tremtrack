// Doctor dashboard: the patients who chose to share their data, most urgent first, and one patient at a time.
// Everything here comes through the API with the doctor's own sign-in; the patient can stop it at any moment.
import { useEffect, useMemo, useState } from 'react';
import DailyChart from '../components/charts/DailyChart';
import MiniLine, { type MiniPoint } from '../components/charts/MiniLine';
import { cloud, useCloud } from '../cloud/client';
import { cloudDaySummaries } from '../cloud/days';
import type { PatientDetail, SyncedEpisode } from '../cloud/aws';
import { eventText } from '../cloud/eventText';
import { overview, type PatientOverview } from '../cloud/doctorView';
import { fmtDuration, fmtScore } from '../logic/labels';

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};
const dayMs = (day: string) => Date.parse(day + 'T00:00:00');

/** A 14-day score trace. Decorative: the numbers beside it say the same thing. */
function Spark({ values }: { values: (number | null)[] }) {
  const W = 84, H = 24;
  const pts = values.map((v, i) => (v === null ? null : [(i / (values.length - 1)) * W, H - 2 - (Math.min(10, v) / 10) * (H - 4)] as const));
  const segs: string[] = [];
  let cur: string[] = [];
  for (const p of pts) { if (p) cur.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`); else if (cur.length) { segs.push(cur.join(' ')); cur = []; } }
  if (cur.length) segs.push(cur.join(' '));
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ flex: 'none' }}>
      {segs.map((p, i) => (p.includes(' ') ? <polyline key={i} points={p} fill="none" stroke="var(--chart-line)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : <circle key={i} cx={p.split(',')[0]} cy={p.split(',')[1]} r="2" fill="var(--chart-line)" />))}
    </svg>
  );
}

const trendText = (o: PatientOverview) => (o.trend === 'worse' ? 'worse than the week before' : o.trend === 'better' ? 'better than the week before' : o.trend === 'steady' ? 'about the same as the week before' : '');

function PatientCard({ o, active }: { o: PatientOverview; active: boolean }) {
  const alert = o.flags.some((f) => f.level === 'alert');
  return (
    <li>
      <button className="card" onClick={() => void cloud.doctorOpen(o.id)} aria-current={active ? 'true' : undefined}
        style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'grid', gap: 'var(--s-2)', borderColor: active ? 'var(--accent, currentColor)' : undefined }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'center' }}>
          <b>{o.label}</b>
          <span className={`chip ${o.online ? 'ok' : 'quiet'}`}>{o.online ? 'Online' : o.hasDevice ? 'Offline' : 'No headset'}</span>
        </span>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'center' }}>
          <span className="fine">
            {o.avg7 !== null ? <>7-day average <b>{fmtScore(o.avg7)}</b> of 10{trendText(o) ? `, ${trendText(o)}` : ''}</> : 'No scored days in the last 7 days'}
            <br />{o.episodes7} episodes · {o.falls7} fall{o.falls7 === 1 ? '' : 's'} · {o.lastSeen ? `heard ${ago(o.lastSeen)}` : 'never heard'}
          </span>
          <Spark values={o.spark} />
        </span>
        {o.flags.length > 0 && (
          <span className={`notice ${alert ? 'warn' : ''}`} style={{ margin: 0 }}>
            {o.flags.map((f) => <span key={f.text} style={{ display: 'block' }}>{f.level === 'alert' ? 'Needs attention: ' : 'Look at: '}{f.text}</span>)}
          </span>
        )}
      </button>
    </li>
  );
}

function EpisodeTable({ eps }: { eps: SyncedEpisode[] }) {
  if (eps.length === 0) return <p className="fine">No episode details yet. They appear after the patient taps Sync now in their app.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <caption className="sr-only">Tremor episodes the patient's app uploaded</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Length</th><th scope="col">Frequency</th><th scope="col">Amplitude</th><th scope="col">Score</th></tr></thead>
        <tbody>
          {eps.slice(0, 25).map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.start).toLocaleString()}</td>
              <td>{fmtDuration(e.durationS)}</td>
              <td>{e.freqHz ? `${e.freqHz.toFixed(1)} Hz` : '–'}</td>
              <td>{e.ampDps ? `${e.ampDps.toFixed(1)} °/s` : '–'}</td>
              <td>{typeof e.score === 'number' ? fmtScore(e.score) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {eps.length > 25 && <p className="fine">Showing the latest 25 of {eps.length}.</p>}
    </div>
  );
}

function PatientView({ detail, o }: { detail: PatientDetail; o: PatientOverview | undefined }) {
  const [confirm, setConfirm] = useState(false);
  const { days, avg } = useMemo(() => cloudDaySummaries(detail.days, 30), [detail.days]);
  const scored = days.filter((d) => d.score !== null);
  const sorted = useMemo(() => [...detail.days].sort((a, b) => a.day.localeCompare(b.day)), [detail.days]);
  const bpm: MiniPoint[] = sorted.map((d) => ({ t: dayMs(d.day), v: typeof d.restingBpm === 'number' ? d.restingBpm : null }));
  const spo2: MiniPoint[] = sorted.map((d) => ({ t: dayMs(d.day), v: typeof d.restingSpo2 === 'number' ? d.restingSpo2 : null }));
  const hasBpm = bpm.some((p) => p.v !== null), hasSpo2 = spo2.some((p) => p.v !== null);
  const events = detail.events.filter((e) => e.type === 'episode' || e.type === 'fall').slice(0, 15);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--s-4)', minWidth: 0 }}>
      <section className="card" aria-label="Patient">
        <div className="card-title">
          <span>{detail.label}</span>
          <span style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            {detail.devices.map((d) => <span key={d.thing} className={`chip ${d.online ? 'ok' : 'quiet'}`}>{d.thing} · {d.online ? 'online' : d.lastSeen ? `heard ${ago(d.lastSeen)}` : 'offline'}</span>)}
          </span>
        </div>
        <p className="fine">Sharing since {new Date(detail.since).toLocaleDateString()}. The patient can stop sharing at any time.</p>
        {o && o.flags.length > 0 && (
          <div className={`notice ${o.flags.some((f) => f.level === 'alert') ? 'warn' : ''}`} role="status">
            {o.flags.map((f) => <span key={f.text} style={{ display: 'block' }}>{f.level === 'alert' ? 'Needs attention: ' : 'Look at: '}{f.text}</span>)}
          </div>
        )}
        <dl className="grid-3 stats" style={{ marginTop: 'var(--s-3)' }} aria-label="Summary">
          <div><dt className="fine">Latest score</dt><dd className="stat" style={{ margin: 0 }}>{o?.latestScore != null ? fmtScore(o.latestScore) : '–'}<small className="fine"> / 10</small></dd></div>
          <div><dt className="fine">7-day average</dt><dd className="stat" style={{ margin: 0 }}>{o?.avg7 != null ? fmtScore(o.avg7) : '–'}</dd></div>
          <div><dt className="fine">Episodes, 7 days</dt><dd className="stat" style={{ margin: 0 }}>{o?.episodes7 ?? '–'}</dd></div>
          <div><dt className="fine">Falls, 7 days</dt><dd className="stat" style={{ margin: 0 }}>{o?.falls7 ?? '–'}</dd></div>
          <div><dt className="fine">Resting heart rate</dt><dd className="stat" style={{ margin: 0 }}>{o?.restingBpm != null ? `${Math.round(o.restingBpm)} bpm` : '–'}</dd></div>
          <div><dt className="fine">Resting SpO₂ (estimate)</dt><dd className="stat" style={{ margin: 0 }}>{o?.restingSpo2 != null ? `${Math.round(o.restingSpo2)} %` : '–'}</dd></div>
        </dl>
      </section>

      <section className="card" aria-label="Daily severity score">
        <div className="card-title"><span>Severity, last 30 days</span></div>
        {scored.length === 0 ? <p className="fine">No scored days yet. A day needs at least 10 minutes of wear to get a score.</p> : <DailyChart days={days} avg={avg} title={`Daily severity score for ${detail.label}, last 30 days`} />}
      </section>

      {(hasBpm || hasSpo2) && (
        <section className="card" aria-label="Resting vitals">
          <div className="card-title"><span>Resting vitals (estimates)</span></div>
          {hasBpm && <MiniLine points={bpm} unit="bpm" title={`Resting heart rate for ${detail.label}`} domain={[40, 120]} ticks={[50, 70, 90, 110]} />}
          {hasSpo2 && <MiniLine points={spo2} unit="%" title={`Resting SpO2 estimate for ${detail.label}`} domain={[85, 100]} ticks={[88, 92, 96, 100]} band={{ from: 85, to: 92, label: 'below 92 %' }} />}
          <p className="fine">From a wearable sensor on the head, measured after a few minutes of rest. Treat these as trends, not as clinical readings.</p>
        </section>
      )}

      <section className="card" aria-label="Recent events">
        <div className="card-title"><span>Falls and tremor episodes</span></div>
        {events.length === 0 && <p className="fine">Nothing in the last 30 days.</p>}
        <ul className="plain">
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="fine">{new Date(e.ts).toLocaleString()} · {e.thing}</span><br />{eventText(e)}
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-label="Episode details">
        <div className="card-title"><span>Episode details</span></div>
        <EpisodeTable eps={detail.episodes} />
      </section>

      <section className="card" aria-label="Stop seeing this patient">
        {!confirm
          ? <div className="btn-row"><button className="btn sm" onClick={() => setConfirm(true)}>Stop seeing this patient…</button></div>
          : (
            <div className="notice warn stack" role="alertdialog" aria-label="Confirm removal">
              <span>Remove {detail.label} from your list? You will need a new code from them to see their data again.</span>
              <span className="btn-row">
                <button className="btn sm" onClick={() => { setConfirm(false); void cloud.doctorRemove(detail.id); }}>Yes, remove</button>
                <button className="btn sm" onClick={() => setConfirm(false)}>Cancel</button>
              </span>
            </div>
          )}
      </section>
    </div>
  );
}

function AddPatient() {
  const c = useCloud();
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (
    <section className="card" aria-label="Add a patient">
      <div className="card-title"><span>Add a patient</span></div>
      <p className="fine">Ask the patient to open <b>Cloud → Share with my doctor</b> in their app and read you the code. It works once and expires after 24 hours.</p>
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); void cloud.doctorAdd(clean).then((ok) => { if (ok) setCode(''); }); }}>
        <label htmlFor="share-code" className="sr-only">Patient's code</label>
        <input id="share-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7M2Q-9XPD4" autoComplete="off" autoCapitalize="characters" spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', flex: 1, minWidth: 0 }} />
        <button className="btn primary" type="submit" disabled={clean.length !== 10 || !!c.doctor.busy}>Add</button>
      </form>
    </section>
  );
}

export default function Doctor() {
  const c = useCloud();
  const d = c.doctor;
  // load once after sign-in; the Refresh button does the rest
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (c.config && c.signedIn && c.isDoctor && !d.loadedAt && !d.busy) void cloud.doctorRefresh(); }, [c.config, c.signedIn, c.isDoctor]);
  // keep the list fresh while the tab is open (a fall should not wait for a manual refresh)
  useEffect(() => {
    if (!c.isDoctor) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !useCloud.getState().doctor.busy) void cloud.doctorRefresh(); }, 60_000);
    return () => clearInterval(t);
  }, [c.isDoctor]);

  const selected = d.patients.find((p) => p.id === d.selected);
  return (
    <div className="page" style={{ maxWidth: 'min(1100px, 100%)' }}>
      <div className="hero-text"><h1>Doctor dashboard</h1><p>Patients who chose to share their data with you.</p></div>

      {!c.config && <p className="notice">Set up the cloud first on the <a href="#/cloud">Cloud</a> screen, then sign in with your doctor account.</p>}
      {c.config && !c.signedIn && <p className="notice">Sign in with your doctor account on the <a href="#/cloud">Cloud</a> screen.</p>}
      {c.config && c.signedIn && !c.isDoctor && (
        <p className="notice warn" role="alert">
          {c.email ?? 'This account'} is not a doctor account. An administrator adds doctors with <code>node tools/aws/make-doctor.mjs --email …</code>; sign out and in again afterwards.
        </p>
      )}

      {c.config && c.signedIn && c.isDoctor && (
        <>
          {d.error && <p className="notice warn" role="alert">{d.error}</p>}
          {d.notice && <p className="notice" role="status">{d.notice}</p>}
          <div className="doc-grid">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--s-4)', alignContent: 'start', minWidth: 0 }}>
              <section aria-label="Patients" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--s-3)' }}>
                <div className="card-title" style={{ margin: 0 }}>
                  <span>Patients ({d.patients.length})</span>
                  <button className="btn sm" disabled={!!d.busy} onClick={() => void cloud.doctorRefresh()}>{d.busy ? 'Loading…' : 'Refresh'}</button>
                </div>
                {d.patients.length === 0 && !d.busy && <p className="fine">No patients yet. Add one with a code below.</p>}
                <ul className="plain" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--s-3)' }}>
                  {d.patients.map((o) => <PatientCard key={o.id} o={o} active={o.id === d.selected} />)}
                </ul>
                {d.loadedAt > 0 && <p className="fine">Updated {ago(d.loadedAt)}. Refreshes every minute while this page is open.</p>}
              </section>
              <AddPatient />
            </div>
            <div style={{ minWidth: 0 }}>
              {d.selected && d.detail && d.detail.id === d.selected
                ? <PatientView key={d.selected} detail={d.detail} o={selected ?? overview({ id: d.detail.id, label: d.detail.label, since: d.detail.since, devices: d.detail.devices, days: [], falls7: 0, lastFallTs: null })} />
                : d.selected ? <p className="fine" role="status">Loading…</p>
                  : <p className="fine">{d.patients.length ? 'Choose a patient to see the details.' : ''}</p>}
            </div>
          </div>
          <p className="fine">Severity scores and vitals come from a prototype head-worn sensor. They support a conversation; they are not a diagnosis or a clinical measurement.</p>
        </>
      )}
    </div>
  );
}
