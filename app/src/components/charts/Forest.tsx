// One axis, one row per comparison: the estimate (8 px dot with a surface ring) and its interval
// (2 px line), with a zero line. Rows without enough data say so instead of drawing anything.
import { useEffect, useRef, useState } from 'react';
import type { Interval, Verdict } from '../../logic/stats';

export interface ForestRow { key: string; label: string; sub: string; diff: Interval | null; verdict: Verdict }

export default function Forest({ rows, unit, title }: { rows: ForestRow[]; unit: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const ivs = rows.map((r) => r.diff).filter((d): d is Interval => !!d);
  const ext = Math.max(2, ...ivs.flatMap((d) => [Math.abs(d.lo), Math.abs(d.hi)])) * 1.15;
  const labelW = Math.min(150, W * 0.42), padR = 12, rowH = 44;
  const x = (v: number) => labelW + ((v + ext) / (2 * ext)) * (W - labelW - padR);
  const H = rows.length * rowH + 26;
  const tick = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}`;
  return (
    <div ref={ref} className="chart-wrap">
      <svg width={W} height={H} role="img" aria-label={title}>
        <line x1={x(0)} x2={x(0)} y1={4} y2={H - 22} stroke="var(--line-strong)" strokeWidth={1} />
        {[-ext / 1.15, ext / 1.15].map((v) => <text key={v} x={x(v)} y={H - 6} textAnchor="middle" className="tick">{tick(v)}</text>)}
        <text x={x(0)} y={H - 6} textAnchor="middle" className="tick">0 {unit}</text>
        {rows.map((r, i) => {
          const y = 10 + i * rowH + rowH / 2 - 8;
          const col = r.verdict === 'higher' ? 'var(--accent)' : r.verdict === 'lower' ? 'var(--ok)' : 'var(--chart-bar-hi)';
          return (
            <g key={r.key}>
              <text x={0} y={y - 2} className="forest-label">{r.label}</text>
              <text x={0} y={y + 13} className="tick">{r.sub}</text>
              {r.diff ? (
                <>
                  <line x1={x(r.diff.lo)} x2={x(r.diff.hi)} y1={y + 4} y2={y + 4} stroke={col} strokeWidth={2} strokeLinecap="round" />
                  <circle cx={x(r.diff.estimate)} cy={y + 4} r={5} fill={col} stroke="var(--surface)" strokeWidth={2} />
                </>
              ) : <text x={(labelW + W - padR) / 2} y={y + 8} textAnchor="middle" className="tick faint">not enough data</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
