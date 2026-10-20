import { useCallback, useEffect, useState } from 'react';
import { thresholds, useSettings, type ThresholdOverrides } from '../state/settings';
import { counts, deleteAllLocalData, deleteDemoData, exportAll, importRecords, listEpisodes, listSessions, onDataChanged } from '../data/db';
import { daysCsv, download, episodesCsv } from '../data/csvExport';
import { generateSampleHistory } from '../logic/sampleHistory';
import { summarizeDays } from '../logic/daily';
import { EPISODES, SESSIONS, SEVERITY, STORAGE } from '../config/thresholds';
import { live } from '../device/live';
import HeadsetCard from '../components/HeadsetCard';

type Counts = Awaited<ReturnType<typeof counts>>;

function Num({ label, unit, value, min, max, step, onChange }: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const id = 'th-' + label.replace(/W+/g, '-');
  return (
    <div className="field-row" style={{ minHeight: 44 }}>
      <label htmlFor={id} style={{ fontSize: 'var(--fs-sm)' }}>{label}</label>
      <span><input id={id} type="number" inputMode="decimal" value={value} min={min} max={max} step={step} style={{ width: '5.5rem' }}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); }} /> {unit}</span>
    </div>
  );
}

export default function Settings() {
  const st = useSettings();
  const th = thresholds();
  const setO = <K extends keyof ThresholdOverrides>(k: K, p: NonNullable<ThresholdOverrides[K]>) => st.set({ overrides: { ...st.overrides, [k]: { ...st.overrides[k], ...p } } });
  const [c, setC] = useState<Counts | null>(null);
  const [msg, setMsg] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const refresh = useCallback(() => { counts().then(setC).catch((e) => setMsg('Storage unavailable: ' + (e as Error).message)); }, []);
  useEffect(() => { refresh(); return onDataChanged(refresh); }, [refresh]);
  const stamp = () => new Date().toISOString().slice(0, 10);

  const exportJson = async () => {
    const x = await exportAll();
    download(`tremor-export-${stamp()}.json`, JSON.stringify(x, null, 1), 'application/json');
  };
  const exportCsv = async (kind: 'episodes' | 'days') => {
    const eps = await listEpisodes(0, Date.now(), { includeDemo: st.showDemoData });
    if (kind === 'episodes') { download(`tremor-episodes-${stamp()}.csv`, episodesCsv(eps), 'text/csv'); return; }
    const sessions = await listSessions(0, Date.now(), { includeDemo: st.showDemoData });
    const first = Math.min(...sessions.map((s) => s.start), Date.now());
    download(`tremor-days-${stamp()}.csv`, daysCsv(summarizeDays(sessions, eps, first, Date.now())), 'text/csv');
  };

  return (
    <div className="page">
      <div className="hero-text"><h1>Settings</h1><p>Stored in this browser only.</p></div>

      <HeadsetCard />

      <section className="card" aria-label="Your data">
        <div className="card-title"><span>Your data</span></div>
        <p className="fine">{c ? `${c.sessions} sessions (${c.demoSessions} demo or sample), ${c.episodes} episodes, ${c.samples.toLocaleString()} one-second samples on this device.` : 'Counting…'}</p>
        <label className="check" style={{ marginTop: 'var(--s-2)' }}><input type="checkbox" checked={st.showDemoData} onChange={(e) => st.set({ showDemoData: e.target.checked })} /> Include demo, replay and sample data in Trends</label>
        <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
          <button className="btn sm" onClick={exportJson}>Export all (JSON)</button>
          <button className="btn sm" onClick={() => exportCsv('episodes')}>Episodes (CSV)</button>
          <button className="btn sm" onClick={() => exportCsv('days')}>Daily summary (CSV)</button>
        </div>
        <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
          <button className="btn sm" onClick={async () => { const h = generateSampleHistory(28, Date.now(), Math.floor(Math.random() * 1000)); await importRecords(h.sessions, h.episodes, h.vitals, h.events, { tags: h.tags, meds: h.meds, doses: h.doses }); setMsg(`Loaded ${h.sessions.length} sample sessions and ${h.episodes.length} episodes, marked as sample data.`); }}>Load 4 weeks of sample history</button>
          <button className="btn sm" disabled={!c?.demoSessions} onClick={async () => { await deleteDemoData(); setMsg('Demo, replay and sample data deleted. Your real data is untouched.'); }}>Delete demo and sample data</button>
        </div>
        <div style={{ marginTop: 'var(--s-4)', paddingTop: 'var(--s-4)', borderTop: '1px solid var(--line)' }}>
          {!confirmAll
            ? <button className="btn sm" style={{ color: 'var(--accent-ink)', borderColor: 'var(--accent)' }} onClick={() => setConfirmAll(true)}>Delete all my data…</button>
            : (
              <div role="alertdialog" aria-labelledby="del-title" className="notice warn">
                <p id="del-title"><b>Delete everything stored on this device?</b> Sessions, episodes, samples and settings. This cannot be undone. Export first if you want a copy. (Cloud data does not exist yet; cloud deletion is added in milestone 6.)</p>
                <div className="btn-row" style={{ marginTop: 'var(--s-3)' }}>
                  <button className="btn sm accent" onClick={async () => { await live.disconnect(); await deleteAllLocalData(); setConfirmAll(false); setMsg('All local data deleted.'); }}>Delete everything</button>
                  <button className="btn sm" onClick={() => setConfirmAll(false)}>Cancel</button>
                </div>
              </div>
            )}
        </div>
        {msg && <p className="fine" role="status" style={{ marginTop: 'var(--s-3)' }}>{msg}</p>}
      </section>

      <section className="card">
        <div className="card-title"><span>Accessibility</span></div>
        <label className="check"><input type="checkbox" checked={st.largeText} onChange={(e) => st.set({ largeText: e.target.checked })} /> Larger text</label>
        <p className="fine">Animations follow your system's "reduce motion" setting.</p>
      </section>

      <section className="card" aria-label="Detection and scoring settings">
        <div className="card-title"><span>Detection and scoring</span><span className="fine">fixed in this prototype</span></div>
        <p className="fine">The tremor detector runs on the device. Its sensitivity is set on the Live screen (currently {st.sensitivity}). The app-side values below come from <code>app/src/config/thresholds.ts</code>.</p>
        <dl className="kv" style={{ marginTop: 'var(--s-2)' }}>
          <div><dt>Merge alerts closer than</dt><dd>{EPISODES.mergeGapS} s</dd></div>
          <div><dt>Ignore alerts shorter than</dt><dd>{EPISODES.minDurationS} s</dd></div>
          <div><dt>Session ends after no data for</dt><dd>{SESSIONS.staleS} s</dd></div>
          <div><dt>Minimum monitoring for a daily score</dt><dd>{SEVERITY.minMonitoredS / 60} min</dd></div>
          <div><dt>One-second samples kept for</dt><dd>{STORAGE.sampleRetentionDays} days</dd></div>
          <div><dt>Score formula version</dt><dd>{SEVERITY.version}</dd></div>
        </dl>
      </section>

      <section className="card" aria-label="Falls, posture and resting vitals">
        <div className="card-title"><span>Falls, posture and resting vitals</span></div>
        <label className="check"><input type="checkbox" checked={st.fallDetection} onChange={(e) => st.set({ fallDetection: e.target.checked })} /> Fall and impact detection (with a {th.fall.cancelCountdownS} s cancel countdown)</label>
        <label className="check"><input type="checkbox" checked={st.postureMonitoring} onChange={(e) => st.set({ postureMonitoring: e.target.checked })} /> Gentle posture reminders</label>
        <p className="fine" style={{ margin: 'var(--s-2) 0' }}>
          Neutral position: {st.neutralPose ? `calibrated ${new Date(st.neutralPose.t).toLocaleString()}` : 'not calibrated (Live screen)'}
          {st.neutralPose && <> · <button className="btn ghost sm" onClick={() => st.set({ neutralPose: null })}>Clear</button></>}
        </p>
        <details className="disclosure">
          <summary>Thresholds (changes apply from the next connection)</summary>
          <div className="body">
            <Num label="Impact without free fall" unit="g" value={th.fall.impactOnlyG} min={2} max={8} step={0.5} onChange={(v) => setO('fall', { impactOnlyG: v })} />
            <Num label="Impact after free fall" unit="g" value={th.fall.impactG} min={1.5} max={6} step={0.5} onChange={(v) => setO('fall', { impactG: v })} />
            <Num label="Cancel countdown" unit="s" value={th.fall.cancelCountdownS} min={10} max={120} step={5} onChange={(v) => setO('fall', { cancelCountdownS: v })} />
            <Num label="Head forward limit" unit="°" value={th.posture.droopMaxDeg} min={5} max={40} step={1} onChange={(v) => setO('posture', { droopMaxDeg: v })} />
            <Num label="Side tilt limit" unit="°" value={th.posture.tiltMaxDeg} min={5} max={40} step={1} onChange={(v) => setO('posture', { tiltMaxDeg: v })} />
            <Num label="Reminder after" unit="min" value={th.posture.promptAfterS / 60} min={1} max={30} step={1} onChange={(v) => setO('posture', { promptAfterS: v * 60 })} />
            <Num label="Resting after keeping still for" unit="min" value={th.resting.restMinS / 60} min={1} max={15} step={1} onChange={(v) => setO('resting', { restMinS: v * 60 })} />
            <Num label="Flag SpO₂ estimate below" unit="%" value={th.resting.lowSpo2Pct} min={85} max={95} step={1} onChange={(v) => setO('resting', { lowSpo2Pct: v })} />
            <button className="btn sm" onClick={() => st.set({ overrides: {} })}>Reset to defaults</button>
            <p>Defaults and the full list live in <code>app/src/config/thresholds.ts</code>, with the reasoning for each value.</p>
          </div>
        </details>
      </section>

      <section className="card">
        <div className="card-title"><span>Coming later</span></div>
        <ul className="fine" style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: 4 }}>
          <li>Account, cloud sync, caregiver email alerts and cloud deletion (milestones 6–7)</li>
        </ul>
      </section>
      <p className="fine"><a href="#/about">About, licences and limitations</a></p>
    </div>
  );
}
