import { useEffect, useRef } from 'react';
import type { Episode } from '../logic/model';
import { episodeScore } from '../logic/severity';
import { SEVERITY, EPISODES } from '../config/thresholds';
import { AXIS_LONG, AXIS_VAR, SOURCE_LABEL, fmtDate, fmtDuration, fmtPct, fmtScore, fmtTime } from '../logic/labels';
import { IconClose } from './icons';

export default function EpisodeSheet({ ep, onClose }: { ep: Episode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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
    ['Axis', AXIS_LONG[ep.axis]],
    ['Frequency', ep.freqHz > 0 ? `${ep.freqHz.toFixed(1)} Hz` : '–'],
    ['Amplitude (mean / peak)', `${ep.ampDps.toFixed(1)} / ${ep.peakAmpDps.toFixed(1)} °/s`],
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
        <div className="share-bar" aria-label={`Axis share: nod ${fmtPct(ep.axisShare[0])}, tilt ${fmtPct(ep.axisShare[1])}, turn ${fmtPct(ep.axisShare[2])}`}>
          {ep.axisShare.map((s, i) => (s > 0 ? <i key={i} style={{ flex: s, background: `var(${AXIS_VAR[i]})` }} /> : null))}
        </div>
        <dl className="kv">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <details className="disclosure">
          <summary>How this score was computed</summary>
          <div className="body">
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
