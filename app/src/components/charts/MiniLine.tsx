// One measure per chart (never two y-axes): a 2 px line through days that have a value, gaps where
// they don't, 8 px end markers with a surface ring, hairline grid, hover/keyboard tooltip, table view.
import { useEffect, useRef, useState } from 'react';
import { fmtDate } from '../../logic/labels';

const H = 132, PAD = { l: 34, r: 10, t: 10, b: 24 };

export interface MiniPoint { t: number; v: number | null; note?: string }

export default function MiniLine({ points, unit, title, domain, ticks: tickValues, band, color = 'var(--chart-line)' }: {
  points: MiniPoint[]; unit: string; title: string; domain: [number, number]; ticks?: number[];
  band?: { from: number; to: number; label: string };   // a shaded reference range (e.g. below a flag threshold)
  color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const n = points.length;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const [lo, hi] = domain;
  const y = (v: number) => PAD.t + ih - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * ih;
  let d = '', pen = false;
  points.forEach((p, i) => { if (p.v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; pen = true; });
  const ticks = tickValues ?? [lo, (lo + hi) / 2, hi];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 50))));
  const last = [...points].reverse().find((p) => p.v !== null);
  const pick = (cx: number) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((cx - r.left - PAD.l) / Math.max(1, iw)) * (n - 1));
    setSel(i >= 0 && i < n ? i : null);
  };
  const sp = sel !== null ? points[sel] : null;

  return (
    <div>
      <div ref={ref} className="chart-wrap" tabIndex={0} role="group" aria-label={`${title}. Use left and right arrow keys to read each day.`}
        onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setSel(null)} onBlur={() => setSel(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { setSel((s) => Math.max(0, (s ?? n) - 1)); e.preventDefault(); }
          if (e.key === 'ArrowRight') { setSel((s) => Math.min(n - 1, (s ?? -1) + 1)); e.preventDefault(); }
        }}>
        <svg width={W} height={H} aria-hidden="true">
          {band && <rect x={PAD.l} width={iw} y={y(band.to)} height={Math.max(0, y(band.from) - y(band.to))} fill="var(--warn-soft)" opacity={0.7} />}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="tick">{Math.round(v)}</text>
            </g>
          ))}
          {sel !== null && <line x1={x(sel)} x2={x(sel)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--line-strong)" strokeWidth={1} />}
          {d && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((p, i) => (p.v !== null && (i === sel || p === last || n <= 10) ? <circle key={i} cx={x(i)} cy={y(p.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} /> : null))}
          {points.map((p, i) => (i % labelEvery === (n - 1) % labelEvery ? <text key={'l' + i} x={x(i)} y={H - 6} textAnchor="middle" className="tick">{fmtDate(p.t, { day: 'numeric', month: 'short' })}</text> : null))}
        </svg>
        {sp && sel !== null && (
          <div className="chart-tip" style={{ left: Math.min(W - 180, Math.max(0, x(sel) - 90)) }} role="status">
            <b>{fmtDate(sp.t)}</b>
            <span>{sp.v === null ? 'No usable resting reading' : `${Math.round(sp.v)} ${unit}`}</span>
            {sp.note && <span className="muted">{sp.note}</span>}
          </div>
        )}
      </div>
      {band && <p className="fine" style={{ marginTop: 4 }}><span className="key-band" /> {band.label}</p>}
      <details className="disclosure">
        <summary>Show as table</summary>
        <div className="body" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">{unit}</th><th scope="col">Readings</th></tr></thead>
            <tbody>{[...points].reverse().map((p) => <tr key={p.t}><th scope="row">{fmtDate(p.t)}</th><td>{p.v === null ? '–' : Math.round(p.v)}</td><td>{p.note ?? ''}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
