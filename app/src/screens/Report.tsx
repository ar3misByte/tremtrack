import { useEffect, useMemo, useState } from 'react';
import { listDoses, listEpisodes, listEvents, listMeds, listSamples, listSessions, listTags, listVitals } from '../data/db';
import { download } from '../data/csvExport';
import { assembleReport, type ReportData } from '../logic/reportData';
import { DAY_MS, nextDay, startOfDay } from '../logic/daily';
import { fmtDate, fmtMinutes, fmtPct } from '../logic/labels';
import { useSettings } from '../state/settings';

const toInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fromInput = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

export default function Report() {
  const includeDemo = useSettings((s) => s.showDemoData);
  const [preset, setPreset] = useState<number | 'custom'>(30);
  const [from, setFrom] = useState(() => toInput(Date.now() - 29 * DAY_MS));
  const [to, setTo] = useState(() => toInput(Date.now()));
  const [name, setName] = useState('');
  const [rows, setRows] = useState(150);
  const [data, setData] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [url, setUrl] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset !== 'custom') { const end = nextDay(Date.now()) - 1; return { from: startOfDay(end - (preset - 1) * DAY_MS), to: end }; }
    const a = fromInput(from), b = nextDay(fromInput(to)) - 1;
    return a <= b ? { from: a, to: b } : null;
  }, [preset, from, to]);

  useEffect(() => {
    if (!range) { setData(null); return; }
    let live = true;
    (async () => {
      const f = { includeDemo };
      const [sessions, episodes, tags, meds, doses, vitals, events, samples] = await Promise.all([
        listSessions(range.from, range.to, f), listEpisodes(range.from, range.to, f), listTags(range.from, range.to, f), listMeds(f), listDoses(f),
        listVitals(range.from, range.to, f), listEvents(range.from, range.to, f), listSamples(range.from, range.to),
      ]);
      if (!live) return;
      setData(assembleReport({ ...range, now: Date.now(), sessions, episodes, tags, meds, doses, vitals, events, samples: includeDemo ? samples : samples.filter((s) => !s.demo), maxEpisodeRows: rows }));
    })().catch((e) => setMsg('Could not read local data: ' + (e as Error).message));
    return () => { live = false; };
  }, [range, includeDemo, rows]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const make = async (open: boolean) => {
    if (!data) return;
    setBusy(true); setMsg('');
    try {
      const t0 = performance.now();
      const { buildReportPdf } = await import('../report/pdf');
      const blob = buildReportPdf(data, { name: name.trim() || undefined }).output('blob');
      const fileName = `tremor-report-${toInput(data.period.from)}-to-${toInput(data.period.to)}.pdf`;
      if (url) URL.revokeObjectURL(url);
      const u = URL.createObjectURL(blob);
      setUrl(u);
      if (open) window.open(u, '_blank', 'noopener');
      else download(fileName, blob);
      setMsg(`PDF ready (${Math.round(blob.size / 1024)} KB, ${Math.round(performance.now() - t0)} ms).`);
    } catch (e) {
      setMsg('Could not create the PDF: ' + (e as Error).message);
    } finally { setBusy(false); }
  };

  const o = data?.overview;
  return (
    <div className="page wide">
      <div className="hero-text full"><h1>Doctor report</h1><p>A PDF summary of a period, made on this device, to share with your doctor if you choose.</p></div>

      <div className="col">
        <section className="card" aria-label="Report options">
          <div className="card-title"><span>Period</span></div>
          <div className="segmented" role="group" aria-label="Period">
            {([7, 30, 90] as const).map((d) => <button key={d} aria-pressed={preset === d} onClick={() => setPreset(d)}>{d} days</button>)}
            <button aria-pressed={preset === 'custom'} onClick={() => setPreset('custom')}>Custom</button>
          </div>
          {preset === 'custom' && (
            <div className="grid-2" style={{ marginTop: 'var(--s-3)' }}>
              <div className="field"><label htmlFor="r-from">From</label><input id="r-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="field"><label htmlFor="r-to">To</label><input id="r-to" type="date" value={to} min={from} max={toInput(Date.now())} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
          )}
          {!range && <p className="notice warn" role="alert">The start date is after the end date.</p>}
          <div className="field">
            <label htmlFor="r-name">Name on the report (optional)</label>
            <input id="r-name" type="text" value={name} maxLength={60} placeholder="Not saved; only printed on this PDF" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="r-rows">Episode table</label>
            <select id="r-rows" value={rows} onChange={(e) => setRows(+e.target.value)}>
              <option value={50}>Up to 50 episodes (highest scores)</option>
              <option value={150}>Up to 150 episodes</option>
              <option value={500}>Up to 500 episodes</option>
            </select>
          </div>
          <label className="check"><input type="checkbox" checked={includeDemo} onChange={(e) => useSettings.getState().set({ showDemoData: e.target.checked })} /> Include demo and sample data (the PDF is then clearly marked)</label>
          <div className="btn-row" style={{ marginTop: 'var(--s-4)' }}>
            <button className="btn primary" onClick={() => void make(false)} disabled={!data || busy}>{busy ? 'Creating…' : 'Download PDF'}</button>
            <button className="btn" onClick={() => void make(true)} disabled={!data || busy}>Open PDF</button>
          </div>
          <p className="fine" role="status" style={{ marginTop: 'var(--s-2)' }}>{msg}</p>
        </section>
        <p className="notice">The report states that this is a prototype, not a medical device, and not a diagnosis. It contains health-related personal data: share it only with people you choose.</p>
      </div>

      <div className="col">
        <section className="card" aria-label="What the report will contain">
          <div className="card-title"><span>What the report will contain</span>{data?.containsDemo && <span className="chip warn">Includes demo data</span>}</div>
          {!data ? <p className="fine">Loading…</p> : data.empty ? <p className="muted">No monitoring data in this period.</p> : (
            <>
              <p className="fine">{fmtDate(data.period.from)} – {fmtDate(data.period.to)} · {data.period.days} days</p>
              <div className="grid-2 stats" style={{ marginTop: 'var(--s-3)' }}>
                <div><div className="fine">Monitored</div><div className="stat">{o!.monitoredH.toFixed(1)} h · {o!.daysWithData} days</div></div>
                <div><div className="fine">Episodes</div><div className="stat">{o!.episodes}</div></div>
                <div><div className="fine">Time with tremor</div><div className="stat">{fmtMinutes(o!.tremorMin * 60)} ({fmtPct(o!.shareOfTime ?? 0)})</div></div>
                <div><div className="fine">Mean daily score</div><div className="stat">{o!.meanDailyScore === null ? '–' : o!.meanDailyScore.toFixed(1)}</div></div>
              </div>
              <ul className="fine" style={{ margin: 'var(--s-3) 0 0', paddingLeft: '1.1rem', display: 'grid', gap: 4 }}>
                <li>Daily severity chart and weekly table</li>
                <li>{data.hintsEnough ? `${data.hints.length} pattern description${data.hints.length === 1 ? '' : 's'} with evidence` : 'Too few episodes for pattern descriptions'}</li>
                <li>{data.tags.length} tag comparison{data.tags.length === 1 ? '' : 's'}, {data.meds.length} medication{data.meds.length === 1 ? '' : 's'} (adherence and before/after), heart rate around episodes</li>
                <li>Posture and stillness; {data.vitals.nReadings} resting heart-rate / SpO₂ readings; {data.falls.length} fall or impact candidate{data.falls.length === 1 ? '' : 's'}</li>
                <li>Episode table: {data.episodeRows.length}{data.episodeRowsNote ? ` of ${o!.episodes} (highest scores)` : ''} rows</li>
                <li>Plain-language notes on what the device can and cannot tell</li>
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
