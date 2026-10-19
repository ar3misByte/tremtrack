// Canvas traces fed straight from the live ring buffers (no React renders per frame).
import { useMemo, useRef } from 'react';
import { live, RING } from '../device/live';
import { cssVar, fitCanvas, useAnimationFrame } from './hooks';

export function Waveform({ height = 112 }: { height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scale = useRef(8);
  const label = useRef<HTMLSpanElement>(null);
  const cols = useMemo(() => [cssVar('--axis-pitch'), cssVar('--axis-roll'), cssVar('--axis-yaw')], []);
  const grid = useMemo(() => cssVar('--line'), []);

  useAnimationFrame(() => {
    const c = fitCanvas(ref.current);
    if (!c) return;
    const { g, w, h } = c;
    let mx = 0;
    for (const ch of live.wave) for (let i = 0; i < RING; i++) mx = Math.max(mx, Math.abs(ch[i]));
    scale.current += (Math.max(8, mx * 1.15) - scale.current) * 0.1;
    g.strokeStyle = grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    g.lineWidth = 1.6; g.lineJoin = 'round';
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let i = 0; i < RING; i++) {
        const v = live.wave[k][(live.head + i) % RING];
        const x = (i / (RING - 1)) * w, y = h / 2 - (v / scale.current) * (h / 2 - 4);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = cols[k]; g.stroke();
    }
    if (label.current) label.current.textContent = `±${Math.round(scale.current)} °/s`;
  });

  return (
    <div>
      <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} role="img" aria-label="Band-passed gyro waveforms for pitch, roll and yaw, last 5 seconds" />
      <div className="legend">
        <span style={{ ['--c' as string]: 'var(--axis-pitch)' }}>Nod</span>
        <span style={{ ['--c' as string]: 'var(--axis-roll)' }}>Tilt</span>
        <span style={{ ['--c' as string]: 'var(--axis-yaw)' }}>Turn</span>
        <span ref={label} className="fine" style={{ marginLeft: 'auto' }} />
      </div>
    </div>
  );
}

export function PulseTrace({ height = 56, active }: { height?: number; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scale = useRef(20);
  const col = useMemo(() => cssVar('--heart'), []);
  const muted = useMemo(() => cssVar('--line-strong'), []);
  useAnimationFrame(() => {
    const c = fitCanvas(ref.current);
    if (!c) return;
    const { g, w, h } = c;
    let mx = 0;
    for (let i = 0; i < RING; i++) mx = Math.max(mx, Math.abs(live.pulse[i]));
    scale.current += (Math.max(10, mx * 1.2) - scale.current) * 0.1;
    g.strokeStyle = active ? col : muted; g.lineWidth = 1.8; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < RING; i++) {
      const v = live.pulse[(live.pulseHead + i) % RING];
      const x = (i / (RING - 1)) * w, y = h / 2 - (v / scale.current) * (h / 2 - 3);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  });
  return <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} role="img" aria-label="Pulse waveform from the finger sensor" />;
}
