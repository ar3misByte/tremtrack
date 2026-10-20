import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteDose, deleteMed, deleteTag, listDoses, listMeds, listTags, onDataChanged, putMed, putTag } from '../data/db';
import { reminders } from '../data/reminders';
import { adherence, occurrences, stateOf, type DoseState } from '../logic/meds';
import type { DoseLog, Medication, Tag, TagKind } from '../logic/model';
import { TAG_LABEL } from '../logic/correlate';
import { DAY_MS, nextDay, startOfDay } from '../logic/daily';
import { fmtDate, fmtPct, fmtTime } from '../logic/labels';
import { newId } from '../logic/tracker';
import { useSettings } from '../state/settings';

const QUICK: TagKind[] = ['coffee', 'poor-sleep', 'stress', 'exercise', 'alcohol', 'meal'];
const AGO = [[0, 'Now'], [30, '30 min'], [60, '1 h'], [120, '2 h']] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATE_CHIP: Record<DoseState, [string, string]> = {
  upcoming: ['quiet', 'Upcoming'], due: ['warn', 'Due'], taken: ['ok', 'Taken'], late: ['ok', 'Taken late'], skipped: ['quiet', 'Skipped'], missed: ['warn', 'Not logged'],
};

function useLogData() {
  const includeDemo = useSettings((s) => s.showDemoData);
  const [d, setD] = useState<{ tags: Tag[]; meds: Medication[]; doses: DoseLog[] } | null>(null);
  const load = useCallback(async () => {
    const now = Date.now();
    const [tags, meds, doses] = await Promise.all([listTags(now - 7 * DAY_MS, now + DAY_MS, { includeDemo }), listMeds({ includeDemo }), listDoses({ includeDemo })]);
    setD({ tags, meds, doses });
  }, [includeDemo]);
  useEffect(() => { void load(); return onDataChanged(() => void load()); }, [load]);
  return d;
}

export default function Log() {
  const d = useLogData();
  const [ago, setAgo] = useState(0);
  const [custom, setCustom] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<Medication | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);

  const addTag = async (kind: TagKind, label: string | null = null) => {
    const t = Date.now() - ago * 60_000;
    await putTag({ id: newId('t', t), t, kind, label, demo: false });
    setMsg(`${label ?? TAG_LABEL[kind]} logged at ${fmtTime(t)}.`);
  };

  const today = useMemo(() => {
    if (!d) return [];
    const byKey = new Map(d.doses.map((x) => [x.id, x]));
    return d.meds.flatMap((m) => occurrences(m, startOfDay(now), nextDay(now) - 1)).map((o) => ({ o, log: byKey.get(o.key), state: stateOf(o, byKey.get(o.key), now) })).sort((a, b) => a.o.at - b.o.at);
  }, [d, now]);

  const recent = useMemo(() => {
    if (!d) return [];
    const items: { t: number; text: string; del: () => Promise<void> }[] = [
      ...d.tags.map((t) => ({ t: t.t, text: t.label ?? TAG_LABEL[t.kind], del: () => deleteTag(t.id) })),
      ...d.doses.filter((x) => x.takenAt !== null && x.takenAt > now - 7 * DAY_MS).map((x) => ({ t: x.takenAt!, text: `${d.meds.find((m) => m.id === x.medId)?.name ?? 'Medication'}${x.scheduledFor === null ? ' (extra dose)' : ''}`, del: () => deleteDose(x.id) })),
    ];
    return items.sort((a, b) => b.t - a.t).slice(0, 25);
  }, [d, now]);

  return (
    <div className="page wide">
      <div className="hero-text full"><h1>Log</h1><p>Tags and medication, saved on this device. Insights compares them with your tremor.</p></div>

      <div className="col">
        <section className="card" aria-label="Quick tags">
          <div className="card-title"><span>Quick tags</span></div>
          <div className="field-row" style={{ justifyContent: 'flex-start' }}>
            <span className="fine" id="when-label">When</span>
            <div className="segmented" role="group" aria-labelledby="when-label">
              {AGO.map(([m, l]) => <button key={m} aria-pressed={ago === m} aria-label={m ? `${l} ago` : 'Now'} onClick={() => setAgo(m)}>{l}</button>)}
            </div>
          </div>
          <div className="tag-grid" style={{ marginTop: 'var(--s-3)' }}>
            {QUICK.map((k) => <button key={k} className="btn tag-btn" onClick={() => void addTag(k)}>{TAG_LABEL[k]}</button>)}
          </div>
          <form className="field-row" style={{ marginTop: 'var(--s-3)', gap: 'var(--s-2)' }} onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { void addTag('custom', custom.trim().slice(0, 40)); setCustom(''); } }}>
            <label className="sr-only" htmlFor="custom-tag">Custom tag</label>
            <input id="custom-tag" type="text" placeholder="Custom tag, e.g. long drive" value={custom} maxLength={40} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn sm" type="submit" disabled={!custom.trim()}>Add tag</button>
          </form>
          {msg && <p className="fine" role="status" style={{ marginTop: 'var(--s-2)' }}>{msg}</p>}
        </section>

        <section className="card" aria-label="Today's medication">
          <div className="card-title"><span>Today's medication</span><span className="fine">{fmtDate(now)}</span></div>
          {!d ? <p className="fine">Loading…</p> : today.length === 0 ? <p className="muted">Nothing scheduled today.</p> : (
            <ul className="ep-list">
              {today.map(({ o, log, state }) => (
                <li key={o.key} className="dose-row">
                  <span className="ep-when"><b>{fmtTime(o.at)}</b></span>
                  <span className="ep-mid"><span>{o.med.name}</span><span className="fine">{o.med.dose}{log?.takenAt ? ` · taken ${fmtTime(log.takenAt)}` : ''}</span></span>
                  <span className="dose-actions">
                    <span className={`chip ${STATE_CHIP[state][0]}`}>{STATE_CHIP[state][1]}</span>
                    {log
                      ? <button className="btn sm ghost" onClick={() => void deleteDose(log.id)} aria-label={`Undo ${o.med.name} at ${fmtTime(o.at)}`}>Undo</button>
                      : <>
                          <button className="btn sm" onClick={() => void reminders.log(o, 'taken')} aria-label={`${o.med.name} at ${fmtTime(o.at)} taken`}>Taken</button>
                          <button className="btn sm ghost" onClick={() => void reminders.log(o, 'skipped')} aria-label={`Skip ${o.med.name} at ${fmtTime(o.at)}`}>Skip</button>
                        </>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Notifications />
      </div>

      <div className="col">
        <section className="card" aria-label="Medications">
          <div className="card-title"><span>Medications</span><button className="btn sm" onClick={() => setEditing({ id: newId('m', Date.now()), name: '', dose: '', times: ['08:00'], days: [], active: true, createdAt: Date.now(), demo: false })}>Add medication</button></div>
          {d && d.meds.length === 0 && !editing && <p className="muted">No medications yet. Add one to get reminders and to compare tremor before and after doses.</p>}
          {d?.meds.map((m) => {
            const a7 = adherence([m], d.doses, now - 7 * DAY_MS, now, now), a30 = adherence([m], d.doses, now - 30 * DAY_MS, now, now);
            return (
              <div key={m.id} className="med-row">
                <div>
                  <b>{m.name}</b>{!m.active && <span className="chip quiet" style={{ marginLeft: 8 }}>Paused</span>}{m.demo && <span className="chip quiet" style={{ marginLeft: 8 }}>Sample</span>}
                  <div className="fine">{m.dose ? `${m.dose} · ` : ''}{m.times.join(', ')} · {m.days.length ? m.days.map((x) => DAYS[x]).join(' ') : 'every day'}</div>
                  <div className="fine">Logged as taken: {a7.pct === null ? '–' : fmtPct(a7.pct)} (7 days, {a7.scheduled} doses), {a30.pct === null ? '–' : fmtPct(a30.pct)} (30 days)</div>
                </div>
                <div className="btn-row">
                  <button className="btn sm" onClick={() => void reminders.logExtra(m)}>Log extra dose</button>
                  <button className="btn sm ghost" onClick={() => setEditing(m)}>Edit</button>
                </div>
              </div>
            );
          })}
          {editing && <MedForm med={editing} onDone={() => setEditing(null)} />}
          <p className="fine" style={{ marginTop: 'var(--s-3)' }}>The name and dose you type are only shown back to you. This app gives no medical advice, dose suggestions or interaction warnings.</p>
        </section>

        <section className="card" aria-label="Recent entries">
          <div className="card-title"><span>Last 7 days</span></div>
          {recent.length === 0 ? <p className="muted">Nothing logged yet.</p> : (
            <ul className="ep-list">
              {recent.map((r, i) => (
                <li key={i} className="sess-row">
                  <span className="ep-when"><b>{fmtTime(r.t)}</b><span>{fmtDate(r.t, { day: 'numeric', month: 'short' })}</span></span>
                  <span className="ep-mid"><span>{r.text}</span></span>
                  <button className="btn sm ghost" onClick={() => void r.del()} aria-label={`Delete ${r.text} at ${fmtTime(r.t)}`}>Delete</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function MedForm({ med, onDone }: { med: Medication; onDone: () => void }) {
  const [m, setM] = useState(med);
  const [confirmDel, setConfirmDel] = useState(false);
  const valid = m.name.trim().length > 0 && m.times.length > 0 && m.times.every((t) => /^\d{2}:\d{2}$/.test(t));
  return (
    <form className="med-form" onSubmit={async (e) => { e.preventDefault(); if (!valid) return; await putMed({ ...m, name: m.name.trim().slice(0, 60), dose: m.dose.trim().slice(0, 60) }); onDone(); }}>
      <div className="field"><label htmlFor="med-name">Name</label><input id="med-name" type="text" value={m.name} maxLength={60} required onChange={(e) => setM({ ...m, name: e.target.value })} /></div>
      <div className="field"><label htmlFor="med-dose">Dose (as written on your prescription)</label><input id="med-dose" type="text" value={m.dose} maxLength={60} onChange={(e) => setM({ ...m, dose: e.target.value })} /></div>
      <div className="field">
        <span className="label">Times</span>
        <div className="btn-row">
          {m.times.map((t, i) => (
            <span key={i} className="time-chip">
              <input type="time" aria-label={`Time ${i + 1}`} value={t} required onChange={(e) => setM({ ...m, times: m.times.map((x, j) => (j === i ? e.target.value : x)) })} />
              {m.times.length > 1 && <button type="button" className="btn sm ghost" aria-label={`Remove time ${i + 1}`} onClick={() => setM({ ...m, times: m.times.filter((_, j) => j !== i) })}>×</button>}
            </span>
          ))}
          {m.times.length < 6 && <button type="button" className="btn sm" onClick={() => setM({ ...m, times: [...m.times, '20:00'] })}>Add time</button>}
        </div>
      </div>
      <div className="field">
        <span className="label">Days</span>
        <div className="btn-row" role="group" aria-label="Days">
          {DAYS.map((dn, i) => <button type="button" key={dn} className="btn sm" aria-pressed={m.days.length === 0 || m.days.includes(i)} onClick={() => {
            const all = m.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : m.days;
            const next = all.includes(i) ? all.filter((x) => x !== i) : [...all, i].sort();
            setM({ ...m, days: next.length === 7 ? [] : next });
          }}>{dn}</button>)}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={m.active} onChange={(e) => setM({ ...m, active: e.target.checked })} /> Active (reminders on)</label>
      <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
        <button className="btn primary sm" type="submit" disabled={!valid}>Save</button>
        <button className="btn sm" type="button" onClick={onDone}>Cancel</button>
        {!confirmDel
          ? <button className="btn sm ghost" type="button" onClick={() => setConfirmDel(true)}>Delete…</button>
          : <button className="btn sm accent" type="button" onClick={async () => { await deleteMed(m.id); onDone(); }}>Delete it and its dose log</button>}
      </div>
    </form>
  );
}

function Notifications() {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');
  return (
    <section className="card flat" aria-label="Reminders">
      <div className="card-title"><span>Reminders</span><span className="fine">{perm === 'granted' ? 'notifications on' : ''}</span></div>
      <p className="fine">Reminders appear in the app while it is open{supported ? ', and as notifications if you allow them' : ''}. A web app can't remind you while it's closed; email reminders arrive with the cloud backend (milestone 6).</p>
      {supported && perm === 'default' && <button className="btn sm" style={{ marginTop: 'var(--s-3)' }} onClick={async () => setPerm(await Notification.requestPermission())}>Allow notifications</button>}
      {supported && perm === 'denied' && <p className="fine" style={{ marginTop: 'var(--s-2)' }}>Notifications are blocked for this site in your browser settings.</p>}
    </section>
  );
}
