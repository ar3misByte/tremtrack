import { useEffect, useRef } from 'react';
import { useFocusTrap } from './useFocusTrap';
import type { Episode } from '../logic/model';
import { episodeScore } from '../logic/severity';
import { SEVERITY, EPISODES } from '../config/thresholds';
import { AXIS_SHORT, AXIS_VAR, SOURCE_LABEL, axesLong, episodeAxes, fmtDate, fmtDuration, fmtPct, fmtScore, fmtTime } from '../logic/labels';
import { PATTERN_LABEL } from '../logic/multiaxis';
import { IconClose } from './icons';

export default function EpisodeSheet({ ep, onClose }: { ep: Episode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k);
    return () => { removeEventListener('keydown', k); prev?.focus(); };
  }, [onClose]);
  const sc = episodeScore({ ampDps: ep.ampDps, freqHz: ep.freqHz, durationS: ep.durationS });
  const rows: [string, string][] = [
    ['When', `${fmtDate(ep.start)}, ${fmtTime(ep.start)}`],
    ['Duration', fmtDuration(ep.durationS)],
    ['Axes', axesLong(episodeAxes(ep))],
    ...(ep.pattern && ep.pattern !== 'single' ? [['How they moved together', PATTERN_LABEL[ep.pattern]] as [string, string]] : []),
    ...(ep.ampByAxis && episodeAxes(ep).length > 1 ? [['Amplitude per axis', episodeAxes(ep).map((a) => `${AXIS_SHORT[a]} ${ep.ampByAxis![a].toFixed(1)}`).join(', ') + ' °/s'] as [string, string]] : []),
    ['Frequency', ep.freqHz > 0 ? `${ep.freqHz.toFixed(1)} Hz` : '–'],
    [episodeAxes(ep).length > 1 ? 'Combined amplitude / peak' : 'Amplitude (mean / peak)', `${ep.ampDps.toFixed(1)} / ${ep.peakAmpDps.toFixed(1)} °/s`],
    ['Estimated head movement', `±${ep.displacementDeg.toFixed(2)}°`],
    ['Repeating cycles per window', ep.cycles.toFixed(0)],
    ['Energy in tremor band', fmtPct(ep.q)],
    ['While walking', fmtPct(ep.walkingFrac)],
    ['Heart rate during', ep.bpm ? `${Math.round(ep.bpm)} bpm` : 'no valid reading'],
    ['Device sensitivity', String(ep.sensitivity)],
    ['Source', SOURCE_LABEL[ep.source] ?? ep.source],
  ];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ep-title" ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="ep-title">Episode</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)' }}>
          <div className="big-number">{fmtScore(ep.score)}<small>/ 10</small></div>
          <span className="fine">engineering score{ep.demo ? ' · demo data' : ''}</span>
        </div>
        {(() => { const sh = ep.axesActiveFrac ?? ep.axisShare; return (
          <div className="share-bar" aria-label={`Share of the episode each axis was shaking: nod ${fmtPct(sh[0])}, tilt ${fmtPct(sh[1])}, turn ${fmtPct(sh[2])}`}>
            {sh.map((s, i) => (s > 0.02 ? <i key={i} style={{ flex: s, background: `var(${AXIS_VAR[i]})` }} /> : null))}
          </div>
        ); })()}
        <dl className="kv">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <details className="disclosure">
          <summary>How this score was computed</summary>
          <div className="body">
            {episodeAxes(ep).length > 1 && <p>Several axes shook together, so the amplitude is the combined magnitude √(Σ aᵢ²) of the axes involved.</p>}
            <p>Head movement θ = amplitude ÷ (2π × frequency) = {ep.ampDps.toFixed(1)} ÷ (2π × {ep.freqHz.toFixed(2)}) = {sc.displacementDeg.toFixed(3)}°.</p>
            <p>Intensity I = ln(1 + θ/{SEVERITY.theta0Deg}) ÷ ln(1 + {SEVERITY.thetaMaxDeg}/{SEVERITY.theta0Deg}) = {sc.intensity.toFixed(3)} (capped at 1).</p>
            <p>Duration term = ln(1 + D/{SEVERITY.d0S}) ÷ ln(1 + {SEVERITY.dMaxS}/{SEVERITY.d0S}) = {sc.durationTerm.toFixed(3)} (capped at 1).</p>
            <p>Score = 10 × ({SEVERITY.wIntensity} × I + {SEVERITY.wDuration} × duration) ÷ {SEVERITY.wIntensity + SEVERITY.wDuration} = {sc.score.toFixed(2)}.</p>
            <p>Times are when the device's alert was on. The shaking began about {EPISODES.detectionLatencyS} s before the alert.</p>
            <p>This is an engineering score for self-tracking. It is not a clinical rating.</p>
          </div>
        </details>
      </div>
    </div>
  );
}
