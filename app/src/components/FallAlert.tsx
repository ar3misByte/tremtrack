// Full-screen fall / impact candidate alert with a cancel countdown. Shown on any screen.
import { useEffect, useRef, useState } from 'react';
import { recorder, useRecorder } from '../data/recorder';
import { thresholds } from '../state/settings';
import { useReducedMotion } from './hooks';

function beep(ctx: AudioContext) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 880;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  o.connect(g).connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.4);
}

export default function FallAlert() {
  const r = useRecorder();
  const reduced = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  const [muted, setMuted] = useState(false);
  const [result, setResult] = useState<'confirmed' | 'no-response' | null>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const active = r.fall;

  useEffect(() => {
    if (!active) return;
    okBtn.current?.focus();
    try { navigator.vibrate?.([400, 200, 400, 200, 400]); } catch { /* not supported */ }
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (!active || muted) return;
    try { audio.current ??= new AudioContext(); } catch { return; }
    const ctx = audio.current;
    beep(ctx);
    const id = setInterval(() => beep(ctx), 2000);
    return () => clearInterval(id);
  }, [active, muted]);

  // show what happened after the countdown, unless the user said they're OK
  const last = r.lastFall;
  useEffect(() => {
    if (last && last.outcome !== 'cancelled' && last.outcome !== 'pending' && Date.now() - (last.resolvedAt ?? 0) < 5000) setResult(last.outcome);
  }, [last]);

  if (active) {
    const total = thresholds().fall.cancelCountdownS;
    const left = Math.max(0, Math.ceil((active.deadline - now) / 1000));
    const frac = Math.max(0, Math.min(1, (active.deadline - now) / (total * 1000)));
    const R = 54, C = 2 * Math.PI * R;
    return (
      <div className="fall-backdrop">
        <div className="fall-card" role="alertdialog" aria-modal="true" aria-labelledby="fall-title" aria-describedby="fall-desc">
          <h2 id="fall-title">Possible fall detected</h2>
          <p id="fall-desc" className="muted">A sudden impact was followed by stillness. If you are OK, tap "I'm OK". Otherwise help will be requested in {left} seconds.</p>
          <div className="fall-ring" aria-hidden="true">
            <svg viewBox="0 0 128 128" width="148" height="148">
              <circle cx="64" cy="64" r={R} fill="none" stroke="var(--surface-sunk)" strokeWidth="8" />
              <circle cx="64" cy="64" r={R} fill="none" stroke="var(--accent)" strokeWidth="8" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 64 64)" style={{ transition: reduced ? 'none' : 'stroke-dashoffset 250ms linear' }} />
            </svg>
            <span className="fall-count">{left}</span>
          </div>
          <p className="sr-only" aria-live="assertive">{left % 10 === 0 ? `${left} seconds` : ''}</p>
          <button ref={okBtn} className="btn primary fall-ok" onClick={() => recorder.resolveFall('cancelled')}>I'm OK</button>
          <button className="btn accent fall-help" onClick={() => recorder.resolveFall('confirmed')}>Get help now</button>
          <button className="btn ghost sm" onClick={() => setMuted((m) => !m)}>{muted ? 'Sound on' : 'Mute sound'}</button>
          <p className="fine">Heuristic detection: it can miss falls and can be triggered by dropping the headset. Peak {active.event.peakG.toFixed(1)} g{active.event.freeFallMs ? `, free fall ${active.event.freeFallMs} ms` : ''}.</p>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="fall-backdrop">
        <div className="fall-card" role="alertdialog" aria-modal="true" aria-labelledby="fall-res-title">
          <h2 id="fall-res-title">{result === 'confirmed' ? 'Help requested' : 'No response'}</h2>
          <p className="muted">Caregiver alerts are <b>not set up yet</b>: they arrive with the cloud backend (milestone 6), which will send an email. Nothing has been sent.</p>
          <p className="muted">If you or someone near you needs help, call them or local emergency services directly.</p>
          <p className="fine">The event is saved and appears in Trends.</p>
          <button className="btn primary" autoFocus onClick={() => setResult(null)}>Close</button>
        </div>
      </div>
    );
  }
  return null;
}
