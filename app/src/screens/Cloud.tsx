import { useEffect, useMemo, useState } from 'react';
import DailyChart from '../components/charts/DailyChart';
import { cloud, useCloud } from '../cloud/client';
import { cloudDaySummaries } from '../cloud/days';
import { parseSetup, type CloudConfig } from '../cloud/config';
import { formatCode } from '../cloud/doctorView';
import type { CloudEventRow } from '../cloud/aws';
import { eventText } from '../cloud/eventText';
import { useLive } from '../device/live';

const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`;
};

/** Patient side of the doctor dashboard: the patient decides who sees their data, with a one-time code, and can take it back. */
function ShareWithDoctor() {
  const c = useCloud();
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [meds, setMeds] = useState(false);
  const left = c.shareCode ? Math.max(0, c.shareCode.expiresAt - Date.now()) : 0;
  return (
    <section className="card" aria-label="Share with my doctor">
      <div className="card-title"><span>Share with my doctor</span></div>
      <p className="fine">
        A doctor with a doctor account can see your daily scores, falls, tremor episodes and resting heart rate and SpO₂ estimates, only after you give them a code.
        They cannot see your tags or notes, and medications only if you tick the box below. You choose how long they keep access, and you can stop sharing at any time.
      </p>
      {c.shareCode && left > 0 && (
        <div className="notice" role="status">
          <span>Code for your doctor: <b style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-lg)', letterSpacing: '0.1em' }}>{formatCode(c.shareCode.code)}</b></span>
          <span className="fine" style={{ display: 'block' }}>Works once. Valid for about {Math.max(1, Math.round(left / 3_600_000))} h. Give it to your doctor in person or by phone, not in a public place.</span>
        </div>
      )}
      <form className="field-row" onSubmit={(e) => { e.preventDefault(); void cloud.makeShareCode(name.trim(), days, meds); }}>
        <label htmlFor="share-name" className="sr-only">Name your doctor will see (optional)</label>
        <input id="share-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name your doctor will see (optional)" maxLength={60} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn sm" type="submit" disabled={!!c.busy}>{c.shareCode && left > 0 ? 'New code' : 'Make a code'}</button>
      </form>
      <div className="field-row" style={{ marginTop: 'var(--s-2)', flexWrap: 'wrap' }}>
        <label htmlFor="share-days" className="fine">Doctor keeps access for</label>
        <select id="share-days" style={{ width: "auto" }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
          <option value={0}>until I stop it</option>
        </select>
      </div>
      <label className="check" style={{ marginTop: 'var(--s-2)' }}><input type="checkbox" checked={meds} onChange={(e) => setMeds(e.target.checked)} /> Also share my medication list and dose log (you must have synced them with the box ticked above)</label>
      <h2 className="fine" style={{ margin: 'var(--s-3) 0 var(--s-1)' }}>Who can see your data</h2>
      {c.shares.length === 0 && <p className="fine">Nobody.</p>}
      <ul className="plain">
        {c.shares.map((s) => (
          <li key={s.doctor} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span>
              {s.email ?? 'A doctor'}<br />
              <span className="fine">
                since {new Date(s.since).toLocaleDateString()} · {s.expiresAt ? `until ${new Date(s.expiresAt).toLocaleDateString()}` : 'until you stop it'} · {s.meds ? 'sees medications' : 'no medications'}
                <br />{s.lastViewed ? `last looked ${ago(s.lastViewed)}` : 'has not looked yet'}
              </span>
            </span>
            <button className="btn sm" disabled={!!c.busy} onClick={() => void cloud.revokeShare(s.doctor)}>Stop sharing</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Setup() {
  const [text, setText] = useState(() => (location.hash.includes('cfg=') ? location.hash : ''));
  const [cfg, setCfg] = useState<CloudConfig | null>(null);
  const [err, setErr] = useState('');
  const check = () => { const r = parseSetup(text); if (r.ok) { setCfg(r.config); setErr(''); } else { setCfg(null); setErr(r.error); } };
  // a setup link opened from a message is checked once, on arrival
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (text.includes('cfg=')) check(); }, []);
  return (
    <section className="card" aria-label="Cloud setup">
      <div className="card-title"><span>Set up the cloud</span></div>
      <p className="fine">
        The cloud is optional: the app works fully without it. It adds a live view of the headset from anywhere, history in your own AWS account, and
        caregiver alerts. After deploying the backend (<code>docs/AWS_SETUP.md</code>), run <code>node tools/aws/app-link.mjs</code>, and paste the link or code it prints here.
      </p>
      <div className="field">
        <label htmlFor="cloud-setup" className="fine">Setup link or code</label>
        <textarea id="cloud-setup" rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }} />
      </div>
      <div className="btn-row"><button className="btn sm" onClick={check}>Check</button></div>
      {err && <p className="notice warn" role="alert" style={{ marginTop: 'var(--s-2)' }}>{err}</p>}
      {cfg && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <dl className="kv" aria-label="Setup details">
            <div><dt>Region</dt><dd>{cfg.region}</dd></div>
            <div><dt>Sign-in</dt><dd>{cfg.authBase ?? cfg.domain}</dd></div>
            <div><dt>API</dt><dd>{cfg.apiUrl.replace(/^https?:\/\//, '')}</dd></div>
          </dl>
          <p className="fine">Only continue if you made this setup yourself or it came from someone you trust: it decides where you sign in.</p>
          <div className="btn-row"><button className="btn primary" onClick={() => { cloud.setup(cfg); history.replaceState(null, '', location.pathname + '#/cloud'); }}>Use this setup</button></div>
        </div>
      )}
    </section>
  );
}

export default function Cloud() {
  const c = useCloud();
  const lv = useLive();
  const [confirm, setConfirm] = useState<'data' | 'account' | null>(null);
  // load once after sign-in; the Refresh button does the rest
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (c.config && c.signedIn && !c.loadedAt && !c.busy) void cloud.refresh(); }, [c.config, c.signedIn]);
  const { days, avg } = useMemo(() => cloudDaySummaries(c.days), [c.days]);
  const scored = days.filter((d) => d.score !== null);
  const week = days.slice(-7);

  return (
    <div className="page">
      <div className="hero-text"><h1>Cloud</h1><p>Optional. Your data stays in your own AWS account.</p></div>

      {c.error && <p className="notice warn" role="alert">{c.error}</p>}
      {c.notice && <p className="notice" role="status">{c.notice}</p>}
      {c.alert && (
        <div className="notice prompt" role="alert">
          <span><b>{c.alert.thing}</b>: {c.alert.text} ({ago(c.alert.at)})</span>
          <button className="btn sm" onClick={() => useCloud.setState({ alert: null })}>Dismiss</button>
        </div>
      )}

      {!c.config && <Setup />}

      {c.config && !c.signedIn && (
        <section className="card" aria-label="Sign in">
          <div className="card-title"><span>Sign in</span></div>
          <p className="fine">Signing in opens your Cognito login page and returns here. The app keeps the sign-in on this device until you sign out.</p>
          <div className="btn-row">
            <button className="btn primary" onClick={() => void cloud.signIn()}>Sign in</button>
            <button className="btn sm" onClick={() => void cloud.forgetSetup()}>Forget this setup</button>
          </div>
        </section>
      )}

      {c.config && c.signedIn && (
        <>
          <section className="card" aria-label="Account">
            <div className="card-title"><span>Account</span><span className="chip ok">Signed in</span></div>
            <p className="fine">{c.email ?? 'Signed in'} · {c.config.region}{c.loadedAt ? ` · updated ${ago(c.loadedAt)}` : ''}</p>
            <div className="btn-row">
              <button className="btn sm" disabled={!!c.busy} onClick={() => void cloud.refresh()}>{c.busy && /Loading/.test(c.busy) ? 'Loading…' : 'Refresh'}</button>
              {c.isDoctor && <a className="btn sm primary" href="#/doctor">Doctor dashboard</a>}
              <button className="btn sm" onClick={() => void cloud.signOut()}>Sign out</button>
            </div>
          </section>

          <section className="card" aria-label="Headsets">
            <div className="card-title"><span>Headsets</span></div>
            {c.devices.length === 0 && <p className="fine">No headset has reported yet. Provision one with <code>node tools/aws/provision-device.mjs</code> (see <code>docs/AWS_SETUP.md</code>), flash it, and give it Wi-Fi (Settings → Headset).</p>}
            <ul className="plain">
              {c.devices.map((d) => {
                const thing = d.thing ?? d.sk?.replace(/^D#/, '') ?? '?';
                const r = c.remote[thing];
                const online = r?.online ?? d.online;
                const watching = c.watching === thing && lv.source === 'cloud';
                return (
                  <li key={thing} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                    <span>
                      <b>{thing}</b> <span className={`chip ${online ? 'ok' : 'quiet'}`}>{online ? 'Online' : 'Offline'}</span><br />
                      <span className="fine">{d.lastSeen ? `last heard ${ago(d.lastSeen)}` : ''}{d.fw ? ` · firmware ${d.fw}` : ''}{(r?.rate ?? d.rate) ? ` · every ${(r?.rate ?? d.rate) === 1 ? '1 s' : '5 s'}` : ''}</span>
                    </span>
                    {watching
                      ? <button className="btn sm" onClick={() => void cloud.stopWatching()}>Stop watching</button>
                      : <button className="btn sm primary" onClick={() => { void cloud.watch(thing).then(() => { if (useCloud.getState().watching) location.hash = '#/live'; }); }}>Watch live</button>}
                  </li>
                );
              })}
            </ul>
            <p className="fine" style={{ marginTop: 'var(--s-2)' }}>While you watch, the headset sends a summary every second instead of every five, and goes back by itself when you stop.</p>
          </section>

          <section className="card" aria-label="Daily severity score">
            <div className="card-title"><span>Last 30 days</span></div>
            {scored.length === 0
              ? <p className="fine">Not enough data yet. A day needs at least 10 minutes of wear to get a score.</p>
              : <DailyChart days={days} avg={avg} title="Daily severity score from the cloud, last 30 days" />}
            <p className="fine">
              {week.reduce((s, d) => s + d.episodes, 0)} episodes and {week.filter((d) => d.monitoredS > 0).length} days worn in the last 7 days.
              The score is an engineering summary for self-tracking, not a clinical measure.
            </p>
          </section>

          <section className="card" aria-label="Recent events">
            <div className="card-title"><span>Recent events</span></div>
            {c.events.length === 0 && <p className="fine">Nothing in the last 14 days.</p>}
            <ul className="plain">
              {[...c.liveEvents.map((x) => ({ ts: x.ev.ts, thing: x.thing, text: eventText(x.ev as unknown as CloudEventRow) })), ...c.events.map((e) => ({ ts: e.ts, thing: e.thing ?? '', text: eventText(e) }))]
                .sort((a, b) => b.ts - a.ts).slice(0, 15).map((e, i) => (
                  <li key={`${e.ts}-${i}`} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    <span className="fine">{new Date(e.ts).toLocaleString()} · {e.thing}</span><br />{e.text}
                  </li>
                ))}
            </ul>
          </section>

          <section className="card" aria-label="Sync">
            <div className="card-title"><span>Sync this device's records</span></div>
            <p className="fine">
              Uploads your episodes, sessions, tags and resting vitals to your account, and fetches what your other devices uploaded. Demo and sample data never leave this device.
            </p>
            <label className="check"><input type="checkbox" checked={c.sync.includeMeds} onChange={(e) => cloud.setIncludeMeds(e.target.checked)} /> Also sync medication names, doses and the dose log</label>
            <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
              <button className="btn sm" disabled={!!c.busy} onClick={() => void cloud.syncNow(c.sync.includeMeds)}>{c.busy === 'Syncing…' ? 'Syncing…' : 'Sync now'}</button>
            </div>
            {c.sync.last && (
              <p className="fine" role="status" style={{ marginTop: 'var(--s-2)' }}>
                Done {ago(c.sync.last.at)}: sent {Object.values(c.sync.last.uploaded).reduce((a, b) => a + b, 0)} records, received {Object.values(c.sync.last.downloaded).reduce((a, b) => a + b, 0)}
                {c.sync.last.tooLarge ? `, ${c.sync.last.tooLarge} skipped (too large)` : ''}.
              </p>
            )}
          </section>

          <ShareWithDoctor />

          <section className="card" aria-label="Delete cloud data">
            <div className="card-title"><span>Delete my cloud data</span></div>
            <p className="fine">Removes everything stored for you in the cloud: telemetry, events, daily summaries and synced records. Data on this device is not touched. Devices are removed with the provisioning scripts.</p>
            {confirm === null && <div className="btn-row"><button className="btn sm" onClick={() => setConfirm('data')}>Delete cloud data…</button><button className="btn sm" onClick={() => setConfirm('account')}>Delete data and account…</button></div>}
            {confirm !== null && (
              <div className="notice warn stack" role="alertdialog" aria-label="Confirm deletion">
                <span>{confirm === 'account' ? 'Delete all your cloud data and your account? This cannot be undone.' : 'Delete all your cloud data? This cannot be undone.'}</span>
                <span className="btn-row">
                  <button className="btn sm" onClick={() => { const acct = confirm === 'account'; setConfirm(null); void cloud.deleteCloudData(acct); }}>Yes, delete</button>
                  <button className="btn sm" onClick={() => setConfirm(null)}>Cancel</button>
                </span>
              </div>
            )}
          </section>

          <p className="fine"><button className="btn sm" onClick={() => void cloud.forgetSetup()}>Forget this cloud setup</button></p>
        </>
      )}
    </div>
  );
}
