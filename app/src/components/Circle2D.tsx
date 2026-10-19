// Low-power 2D view (the legacy circle): a puck follows tilt, a needle shows turn.
import { useMemo, useRef } from 'react';
import { live } from '../device/live';
import { useSettings } from '../state/settings';
import { cssVar, fitCanvas, useAnimationFrame, useReducedMotion } from './hooks';

export default function Circle2D() {
  const ref = useRef<HTMLCanvasElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const trail = useRef<[number, number][]>([]);
  const reduced = useReducedMotion();
  const C = useMemo(() => ({
    ink: cssVar('--ink'), accent: cssVar('--accent'), line: cssVar('--line'), lineStrong: cssVar('--line-strong'),
    ink2: cssVar('--ink-2'), surface: cssVar('--surface'), surface2: cssVar('--surface-2'), soft: cssVar('--accent-soft'),
    font: cssVar('--font-sans'),
  }), []);

  useAnimationFrame((now) => {
    const c = fitCanvas(ref.current);
    if (!c) return;
    const { g, w, h } = c;
    const s = useSettings.getState();
    const fresh = live.lastRx > 0 && performance.now() - live.lastRx < 1500;
    const active = fresh && !!live.frame?.tremor;
    const d = live.disp, range = s.range2d;
    const tx = fresh ? d.roll / range : 0, ty = fresh ? -d.pitch / range : 0;
    pos.current.x += (tx - pos.current.x) * 0.55;
    pos.current.y += (ty - pos.current.y) * 0.55;

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 2, r = R * 0.13, travel = R - r - 8;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = active ? C.soft : C.surface2; g.fill();
    g.lineWidth = active ? 3 : 1.5; g.strokeStyle = active ? C.accent : C.line; g.stroke();
    g.lineWidth = 1; g.strokeStyle = C.line; g.fillStyle = C.ink2; g.font = `11px ${C.font}`;
    for (let i = 1; i <= 3; i++) {
      const rr = (travel * i) / 3;
      g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
      g.fillText(Math.round((range * i) / 3) + '°', cx + Math.cos(-Math.PI / 4) * rr + 4, cy + Math.sin(-Math.PI / 4) * rr - 3);
    }
    g.beginPath(); g.moveTo(cx - R + 14, cy); g.lineTo(cx + R - 14, cy); g.moveTo(cx, cy - R + 14); g.lineTo(cx, cy + R - 14); g.stroke();

    let px = pos.current.x, py = pos.current.y;
    const m = Math.hypot(px, py);
    if (m > 1) { px /= m; py /= m; }
    const bx = cx + px * travel, by = cy + py * travel;
    if (s.trail) { trail.current.push([bx, by]); if (trail.current.length > 40) trail.current.shift(); } else trail.current.length = 0;
    trail.current.forEach(([x, y], i) => {
      const t = i / trail.current.length;
      g.beginPath(); g.arc(x, y, r * (0.35 + 0.5 * t), 0, Math.PI * 2);
      g.globalAlpha = 0.03 + 0.12 * t; g.fillStyle = active ? C.accent : C.ink; g.fill();
    });
    g.globalAlpha = 1;
    if (active) {
      const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 90);
      g.beginPath(); g.arc(bx, by, r * 1.6 + pulse * 6, 0, Math.PI * 2);
      g.lineWidth = 3; g.strokeStyle = C.accent; g.globalAlpha = 0.35 + 0.4 * pulse; g.stroke(); g.globalAlpha = 1;
    }
    g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fillStyle = active ? C.accent : C.ink; g.fill();
    const ya = (-(fresh ? d.yaw : 0) * Math.PI) / 180 - Math.PI / 2;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(ya) * r * 0.78, by + Math.sin(ya) * r * 0.78);
    g.lineWidth = Math.max(3, r * 0.08); g.lineCap = 'round'; g.strokeStyle = C.surface; g.stroke();
  });

  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true" />;
}
