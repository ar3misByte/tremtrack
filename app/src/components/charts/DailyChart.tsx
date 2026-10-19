// Daily severity: one bar per day (0-10, fixed scale) + trailing 7-day average line.
// Bars <= 24 px with 4 px rounded tops, 2 px line, hairline grid, hover/keyboard tooltip, table view.
// Days without monitoring draw nothing (and say "not worn"); a monitored day scoring 0 gets a baseline dot.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DaySummary } from '../../logic/daily';
import { fmtDate, fmtMinutes, fmtScore } from '../../logic/labels';

const H = 184, PAD = { l: 26, r: 8, t: 10, b: 26 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function DailyChart({ days, avg, title }: { days: DaySummary[]; avg: (number | null)[]; title: string }) {
  const [wrap, W] = useWidth<HTMLDivElement>();
  const [sel, setSel] = useState<number | null>(null);
  const n = days.length;
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, n);
  const bw = Math.max(2, Math.min(24, slot - 2));            // 2 px surface gap between touching bars
  const x = (i: number) => PAD.l + slot * i + slot / 2;
  const y = (v: number) => PAD.t + ih - (Math.min(10, Math.max(0, v)) / 10) * ih;
  const todayIdx = n - 1;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 46))));

  const avgPath = useMemo(() => {
    let d = '', pen = false;
    avg.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avg, W, n]);

  const bar = (i: number, v: number) => {
    const x0 = x(i) - bw / 2, y0 = y(v), yb = PAD.t + ih, r = Math.min(4, bw / 2, yb - y0);
    if (yb - y0 < 0.5) return null;
    return `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${yb}Z`;
  };

  const pick = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const i = Math.floor((clientX - r.left - PAD.l) / slot);
    setSel(i >= 0 && i < n ? i : null);
  };
  const d = sel !== null ? days[sel] : null;
  const lastAvg = [...avg].reverse().find((v) => v !== null) ?? null;

  return (
    <div>
      <div className="chart-legend" aria-hidden="true">
        <span><i className="key-bar" />Daily score</span>
        <span><i className="key-line" />7-day average{lastAvg !== null ? ` · ${fmtScore(lastAvg)}` : ''}</span>
      </div>
      <div
        ref={wrap}
        className="chart-wrap"
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use left and right arrow keys to read each day.`}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setSel(null)}
        onPointerDown={(e) => pick(e.clientX)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { setSel((s) => Math.max(0, (s ?? n) - 1)); e.preventDefault(); }
          if (e.key === 'ArrowRight') { setSel((s) => Math.min(n - 1, (s ?? -1) + 1)); e.preventDefault(); }
          if (e.key === 'Escape') setSel(null);
        }}
        onBlur={() => setSel(null)}
      >
        <svg width={W} height={H} aria-hidden="true">
          {[0, 5, 10].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" className="tick">{v}</text>
            </g>
          ))}
          {sel !== null && <rect x={PAD.l + slot * sel} y={PAD.t} width={slot} height={ih} fill="var(--surface-sunk)" opacity={0.6} rx={4} />}
          {days.map((dd, i) => {
            if (dd.score === null) return null;
            const p = bar(i, dd.score);
            const fill = i === todayIdx || i === sel ? 'var(--chart-bar-hi)' : 'var(--chart-bar)';
            return p ? <path key={dd.day} d={p} fill={fill} /> : <circle key={dd.day} cx={x(i)} cy={PAD.t + ih} r={3} fill="var(--chart-bar-hi)" />;
          })}
          {avgPath && <path d={avgPath} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {days.map((dd, i) => (i % labelEvery === (n - 1) % labelEvery ? (
            <text key={dd.day} x={x(i)} y={H - 8} textAnchor="middle" className={`tick${dd.score === null ? ' faint' : ''}`}>
              {n <= 8 ? fmtDate(dd.dayStart, { weekday: 'short' }) : fmtDate(dd.dayStart, { day: 'numeric', month: 'short' })}
            </text>
          ) : null))}
        </svg>
        {d && sel !== null && (
          <div className="chart-tip" style={{ left: Math.min(W - 180, Math.max(0, x(sel) - 90)) }} role="status">
            <b>{fmtDate(d.dayStart)}</b>
            {d.score === null
              ? <span>{d.monitoredS > 0 ? `Only ${fmtMinutes(d.monitoredS)} monitored` : 'Not worn'}</span>
              : <>
                  <span>Score <b>{fmtScore(d.score)}</b> / 10</span>
                  <span>{d.episodes} episode{d.episodes === 1 ? '' : 's'}, {fmtMinutes(d.tremorS)} shaking</span>
                  <span>{fmtMinutes(d.monitoredS)} monitored</span>
                </>}
            {avg[sel] !== null && <span className="muted">7-day average {fmtScore(avg[sel])}</span>}
          </div>
        )}
      </div>
      <details className="disclosure">
        <summary>Show as table</summary>
        <div className="body" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Score</th><th scope="col">7-day avg</th><th scope="col">Episodes</th><th scope="col">Shaking</th><th scope="col">Monitored</th></tr></thead>
            <tbody>
              {[...days].reverse().map((dd, j) => {
                const i = n - 1 - j;
                return (
                  <tr key={dd.day}>
                    <th scope="row">{fmtDate(dd.dayStart)}</th>
                    <td>{dd.score === null ? (dd.monitoredS > 0 ? 'too little data' : 'not worn') : fmtScore(dd.score)}</td>
                    <td>{fmtScore(avg[i])}</td>
                    <td>{dd.episodes}</td>
                    <td>{fmtMinutes(dd.tremorS)}</td>
                    <td>{fmtMinutes(dd.monitoredS)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
