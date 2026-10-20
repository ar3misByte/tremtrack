import { useCallback, useEffect, useMemo, useState } from 'react';
import Forest, { type ForestRow } from '../components/charts/Forest';
import { listDoses, listEpisodes, listMeds, listSamples, listSessions, listTags, listVitals, onDataChanged } from '../data/db';
import { CORRELATION, HINTS, MEDS, TAGS } from '../config/thresholds';
import { compareTags, heartRateLink, medicationEffects, type Comparison, type MedEffect } from '../logic/correlate';
import { DAY_MS, nextDay, startOfDay, summarizeDays, summarizeWeeks } from '../logic/daily';
import { hints } from '../logic/hints';
import type { DoseLog, Episode, Medication, Sample, Session, Tag } from '../logic/model';
import type { RestingReading } from '../logic/vitals';
import type { Verdict } from '../logic/stats';
import { useSettings } from '../state/settings';

interface Data { sessions: Session[]; episodes: Episode[]; tags: Tag[]; meds: Medication[]; doses: DoseLog[]; vitals: RestingReading[]; samples: Sample[]; from: number; to: number }

function useData(days: number, includeDemo: boolean) {
  const [d, setD] = useState<Data | null>(null);
  const load = useCallback(async () => {
    const to = nextDay(Date.now()) - 1, from = startOfDay(to - (days - 1) * DAY_MS), f = { includeDemo };
    const [sessions, episodes, tags, meds, doses, vitals, samples] = await Promise.all([
      listSessions(from, to, f), listEpisodes(from, to, f), listTags(from, to, f), listMeds(f), listDoses(f), listVitals(from, to, f),
      listSamples(Math.max(from, to - 30 * DAY_MS), to),
    ]);
    setD({ sessions, episodes, tags, meds, doses, vitals, samples: includeDemo ? samples : samples.filter((s) => !s.demo), from, to });
  }, [days, includeDemo]);
  useEffect(() => { void load(); return onDataChanged(() => void load()); }, [load]);
  return d;
}

const sign = (x: number, d = 1) => `${x > 0 ? '+' : ''}${x.toFixed(d)}`;
const levelPct = (l: number) => `${(100 * l).toFixed(l > 0.99 ? 1 : 0)} %`;

/** Two sides of a comparison: a (the window of interest) and b (what it is compared with). */
interface Sides { aPrep: string; bPrep: string; aNoun: string; bNoun: string }

function sentence(what: string, x: Sides, v: Verdict, diff: number | undefined, unit: string) {
  if (v === 'not-enough-data') return `Not enough data yet to compare ${x.aNoun} with ${x.bNoun}.`;
  if (v === 'no-clear-difference') return `No clear difference between ${x.aNoun} and ${x.bNoun} (${sign(diff ?? 0)} ${unit}; the interval includes zero).`;
  return `${what} was ${v} ${x.aPrep} than ${x.bPrep} (${sign(diff ?? 0)} ${unit}). This is an association in your data, not proof of a cause.`;
}

function tagSides(key: string, label: string): Sides {
  const [s0, s1] = TAGS.windows[key as keyof typeof TAGS.windows];
  const w = `the ${s0}–${s1} min after "${label.toLowerCase()}"`;
  return { aPrep: `in ${w}`, bPrep: 'at the same time on days without it', aNoun: w, bNoun: 'the same time on days without it' };
}

export default function Insights() {
  const [range, setRange] = useState(90);
  const includeDemo = useSettings((s) => s.showDemoData);
  const d = useData(range, includeDemo);

  const res = useMemo(() => {
    if (!d) return null;
    const days = summarizeDays(d.sessions, d.episodes, d.from, Math.min(d.to, Date.now()));
    const weeks = summarizeWeeks(days);
    return {
      hint: hints(d.episodes, days.filter((x) => x.monitoredS > 0).length, weeks),
      tags: compareTags(d.tags, d.sessions, d.episodes),
      meds: medicationEffects(d.meds, d.doses, d.sessions, d.episodes),
      hr: heartRateLink(d.episodes, d.vitals, d.samples),
    };
  }, [d]);

  if (!d || !res) return <div className="page"><p className="fine">Loading…</p></div>;
  const tagRows: ForestRow[] = res.tags.map((c: Comparison) => ({ key: c.key, label: c.label, sub: `${c.nAfter} after · ${c.nBase} baseline`, diff: c.diff, verdict: c.verdict }));
  const medRows: ForestRow[] = res.meds.map((m: MedEffect) => ({ key: m.medId, label: m.name, sub: `${m.nPaired} of ${m.nDoses} doses usable`, diff: m.diff, verdict: m.verdict }));
  const confLabel = { low: 'Low confidence', moderate: 'Moderate confidence', high: 'Higher confidence' };

  return (
    <div className="page wide">
      <div className="topline full">
        <div className="hero-text"><h1>Insights</h1><p>Patterns in your own data. Nothing here is a diagnosis.</p></div>
        <div className="segmented" role="group" aria-label="Range">
          {[30, 90].map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r} days</button>)}
        </div>
      </div>
      <p className="notice warn full" role="note"><b>Prototype wording, not clinically reviewed.</b> The pattern descriptions below have not yet been reviewed by a clinician and must be before any real use. They describe how the shaking looks to a motion sensor; they cannot say what causes it.</p>

      <div className="col">
        <section className="card" aria-label="Tremor patterns">
          <div className="card-title"><span>Tremor patterns</span><span className="fine">{res.hint.features.n} episodes</span></div>
          {!res.hint.enough && <p className="muted">Not enough episodes yet: patterns are described from {HINTS.minEpisodes} episodes on.</p>}
          {res.hint.hints.map((h) => (
            <article key={h.id} className="hint">
              <div className="hint-head"><span className={`chip ${h.confidence === 'high' ? 'ok' : h.confidence === 'moderate' ? 'quiet' : 'warn'}`}>{confLabel[h.confidence]}</span><span className="fine">{h.support} supporting episodes</span></div>
              <p className="hint-text">{h.text}{h.mention ? ' Worth mentioning to a doctor.' : ''}</p>
              <details className="disclosure">
                <summary>Evidence and source</summary>
                <div className="body">
                  <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>{h.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                  <p><b>Source:</b> {h.source}</p>
                  <p><b>Status:</b> {h.review === 'needs-clinical-review' ? 'wording not yet clinically reviewed' : 'reviewed'}.</p>
                </div>
              </details>
            </article>
          ))}
          <p className="fine" style={{ marginTop: 'var(--s-3)' }}>Confidence reflects how many episodes support the description ({HINTS.moderateEpisodes}+ moderate, {HINTS.highEpisodes}+ higher), not how sure anyone can be about a cause. If head shaking is new, changing or bothering you, it is worth mentioning to a doctor.</p>
        </section>

        <section className="card" aria-label="Heart rate around episodes">
          <div className="card-title"><span>Heart rate and tremor</span></div>
          <p>{res.hr.during.verdict === 'not-enough-data'
            ? `Not enough episodes with a heart-rate reading and a resting value on the same day (${res.hr.during.n} of ${CORRELATION.minEpisodesForHr} needed).`
            : sentence('Heart rate', { aPrep: 'during episodes', bPrep: 'at rest the same day', aNoun: 'heart rate during episodes', bNoun: 'resting heart rate the same day' }, res.hr.during.verdict, res.hr.during.diff?.estimate, 'bpm')}</p>
          {res.hr.during.diff && <p className="fine">{sign(res.hr.during.diff.estimate)} bpm, {levelPct(res.hr.during.diff.level)} interval {sign(res.hr.during.diff.lo)} to {sign(res.hr.during.diff.hi)}, {res.hr.during.n} episodes.</p>}
          <p style={{ marginTop: 'var(--s-3)' }}>{res.hr.before.verdict === 'not-enough-data'
            ? `Heart rate in the ${CORRELATION.hrBeforeS / 60} minutes before episodes: not enough data yet (${res.hr.before.n} of ${CORRELATION.minEpisodesForHr} episodes with a continuous pulse reading; second-by-second data is kept ${30} days).`
            : sentence('Heart rate', { aPrep: `in the ${CORRELATION.hrBeforeS / 60} minutes before episodes`, bPrep: 'at calmer times in the same sessions', aNoun: `heart rate in the ${CORRELATION.hrBeforeS / 60} minutes before episodes`, bNoun: 'calmer times in the same sessions' }, res.hr.before.verdict, res.hr.before.diff?.estimate, 'bpm')}</p>
          {res.hr.before.diff && <p className="fine">{sign(res.hr.before.diff.estimate)} bpm, {levelPct(res.hr.before.diff.level)} interval {sign(res.hr.before.diff.lo)} to {sign(res.hr.before.diff.hi)}, {res.hr.before.n} episodes.</p>}
          <p className="fine" style={{ marginTop: 'var(--s-2)' }}>Movement during shaking can disturb the pulse sensor, so heart rate during episodes is less reliable.</p>
        </section>
      </div>

      <div className="col">
        <section className="card" aria-label="Tags and tremor">
          <div className="card-title"><span>Tags and tremor</span><span className="fine">share of time with tremor</span></div>
          {tagRows.length === 0 ? <p className="muted">No tags in this period. Add them on the Log screen.</p> : (
            <>
              <Forest rows={tagRows} unit="pts" title="Difference in share of time with tremor after each tag, percentage points" />
              <ul className="result-list">
                {res.tags.map((c) => (
                  <li key={c.key}>
                    <b>{c.label}:</b> {sentence('Tremor', tagSides(c.key, c.label), c.verdict, c.diff?.estimate, 'percentage points')}
                    {c.diff && <span className="fine"> {c.afterShare!.toFixed(1)} % vs {c.baseShare!.toFixed(1)} % of the time; {levelPct(c.diff.level)} interval {sign(c.diff.lo)} to {sign(c.diff.hi)}; {c.nAfter} tagged and {c.nBase} baseline windows.</span>}
                    {!c.diff && <span className="fine"> {c.nAfter} tagged window{c.nAfter === 1 ? "" : "s"} with enough monitoring (need {CORRELATION.minAfterWindows}), {c.nBase} baseline (need {CORRELATION.minBaselineWindows}).</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card" aria-label="Medication and tremor">
          <div className="card-title"><span>Medication and tremor</span><span className="fine">after vs before each dose</span></div>
          {medRows.length === 0 ? <p className="muted">No medications. Add them on the Log screen to compare tremor before and after doses.</p> : (
            <>
              <Forest rows={medRows} unit="pts" title="Change in share of time with tremor after doses, percentage points" />
              <ul className="result-list">
                {res.meds.map((m) => (
                  <li key={m.medId}>
                    <b>{m.name}:</b> {sentence('Tremor', { aPrep: `${MEDS.afterStartMin}–${MEDS.afterEndMin} min after a dose`, bPrep: `in the ${MEDS.beforeMin / 60} h before it`, aNoun: `the ${MEDS.afterStartMin}–${MEDS.afterEndMin} min after a dose`, bNoun: `the ${MEDS.beforeMin / 60} h before it` }, m.verdict, m.diff?.estimate, 'percentage points')}
                    {m.diff && <span className="fine"> {m.beforeShare!.toFixed(1)} % before, {m.afterShare!.toFixed(1)} % after; {levelPct(m.diff.level)} interval {sign(m.diff.lo)} to {sign(m.diff.hi)}; {m.nPaired} doses with monitoring before and after.</span>}
                    {!m.diff && <span className="fine"> {m.nPaired} dose{m.nPaired === 1 ? "" : "s"} with monitoring before and after (need {CORRELATION.minPairedDoses}).</span>}
                  </li>
                ))}
              </ul>
              <p className="fine">Many things change across a day besides a dose (time of day, activity, meals). Discuss any medication question with your doctor; this screen gives no advice.</p>
            </>
          )}
        </section>

        <section className="card flat">
          <details className="disclosure" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
            <summary>How these comparisons work</summary>
            <div className="body">
              <p><b>Measure.</b> The share of monitored time with a tremor episode in a window. Time without the headset is not counted; a window needs at least {Math.round(CORRELATION.minCoverage * 100)} % monitoring.</p>
              <p><b>Tags.</b> Windows after each tag are compared with the same clock-time windows on other days (up to {TAGS.baselineDays} days away) without that tag, so mornings are compared with mornings.</p>
              <p><b>Medication.</b> For each dose logged as taken, the window after it is compared with the window just before it (a paired comparison), so slow day-to-day changes matter less.</p>
              <p><b>Uncertainty.</b> Intervals are bootstrap intervals ({CORRELATION.bootstrap} resamples). When several comparisons are shown together, each interval is widened (Bonferroni) so that the chance of any false "difference" stays about {Math.round(CORRELATION.alpha * 100)} %. Below {CORRELATION.minAfterWindows} tagged windows or {CORRELATION.minPairedDoses} doses the screen says "not enough data".</p>
              <p><b>Limits.</b> These are associations in observational self-tracking data. Things that happen together (for example coffee and stress in the morning) cannot be separated here, and nothing on this screen shows a cause.</p>
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}
