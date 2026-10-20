// Doctor report as a PDF, generated in the browser with jsPDF (loaded only when a report is made).
// Charts are drawn as vectors so they print sharply. The built-in Helvetica font covers Latin-1 only,
// so text is passed through `t()` which replaces characters it cannot show (subscripts, arrows, ...).
import { jsPDF } from 'jspdf';
import type { ReportData } from '../logic/reportData';
import { AXIS_SHORT, axesShort, episodeAxes, fmtDuration, fmtMinutes } from '../logic/labels';
import { PATTERN_LABEL } from '../logic/multiaxis';
import { MEDS, SEVERITY, TAGS } from '../config/thresholds';
import type { Interval, Verdict } from '../logic/stats';

const C = {
  ink: '#1D1F22', muted: '#5B6068', faint: '#8A8F96', line: '#E3E0DA', grid: '#ECE9E4', bar: '#B9AEA2', barHi: '#8C7F72',
  accent: '#D9602F', accentSoft: '#FBE7DD', ok: '#5F8B6B', warnSoft: '#F7ECD6', warnInk: '#7A5310', heart: '#C4475A', surface: '#F8F7F4',
};
const PAGE = { w: 210, h: 297, m: 16 };

/** Make text safe for the standard PDF fonts. */
export function t(s: string): string {
  return s
    .replace(/₂/g, '2').replace(/[–—]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/√/g, 'sqrt').replace(/Σ/g, 'sum')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/×/g, 'x').replace(/…/g, '...').replace(/→/g, '->').replace(/θ/g, 'theta')
    .replace(/ᵢ/g, 'i').replace(/·/g, '-').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');
}
const date = (ms: number, o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ms).toLocaleDateString('en-GB', o);
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const pct = (x: number | null, d = 1) => (x === null ? '-' : `${(100 * x).toFixed(d)} %`);
const sgn = (x: number, d = 1) => `${x > 0 ? '+' : ''}${x.toFixed(d)}`;
const verdictText = (v: Verdict) => ({ 'not-enough-data': 'not enough data', 'no-clear-difference': 'no clear difference', higher: 'higher', lower: 'lower' })[v];

class Writer {
  doc: jsPDF;
  y = PAGE.m;
  readonly x0 = PAGE.m;
  readonly w = PAGE.w - 2 * PAGE.m;
  constructor(compress: boolean) { this.doc = new jsPDF({ unit: 'mm', format: 'a4', compress }); }

  color(hex: string, what: 'text' | 'draw' | 'fill') {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (what === 'text') this.doc.setTextColor(r, g, b); else if (what === 'draw') this.doc.setDrawColor(r, g, b); else this.doc.setFillColor(r, g, b);
  }
  font(size: number, style: 'normal' | 'bold' = 'normal', col = C.ink) { this.doc.setFont('helvetica', style); this.doc.setFontSize(size); this.color(col, 'text'); }
  ensure(h: number) { if (this.y + h > PAGE.h - PAGE.m - 8) this.page(); }
  page() { this.doc.addPage(); this.y = PAGE.m; }

  text(s: string, size = 9.5, opts: { style?: 'normal' | 'bold'; col?: string; x?: number; w?: number; gap?: number } = {}) {
    this.font(size, opts.style ?? 'normal', opts.col ?? C.ink);
    const lines = this.doc.splitTextToSize(t(s), opts.w ?? this.w) as string[];
    const lh = size * 0.42;
    for (const l of lines) { this.ensure(lh); this.doc.text(l, opts.x ?? this.x0, this.y + lh * 0.8); this.y += lh; }
    this.y += opts.gap ?? 1.5;
  }
  h1(s: string) { this.ensure(16); this.text(s, 18, { style: 'bold', gap: 1 }); }
  h2(s: string) {
    this.ensure(22);
    this.y += 3;
    this.color(C.line, 'draw'); this.doc.setLineWidth(0.3); this.doc.line(this.x0, this.y, this.x0 + this.w, this.y);
    this.y += 4;
    this.text(s, 12.5, { style: 'bold', gap: 1.5 });
  }
  note(s: string) { this.text(s, 8.2, { col: C.muted }); }
  bullets(items: string[], size = 9) {
    for (const it of items) {
      this.font(size); const lines = this.doc.splitTextToSize(t(it), this.w - 5) as string[];
      const lh = size * 0.42;
      this.ensure(lh * lines.length);
      this.doc.text('-', this.x0 + 1, this.y + lh * 0.8);
      for (const l of lines) { this.doc.text(l, this.x0 + 5, this.y + lh * 0.8); this.y += lh; }
      this.y += 0.8;
    }
    this.y += 1;
  }
  box(s: string, fill: string, ink: string, size = 9) {
    this.font(size, 'normal', ink);
    const lines = this.doc.splitTextToSize(t(s), this.w - 8) as string[];
    const lh = size * 0.42, h = lines.length * lh + 6;
    this.ensure(h + 2);
    this.color(fill, 'fill'); this.doc.roundedRect(this.x0, this.y, this.w, h, 2, 2, 'F');
    this.font(size, 'normal', ink);
    lines.forEach((l, k) => this.doc.text(l, this.x0 + 4, this.y + 3 + lh * (k + 0.8)));
    this.y += h + 3;
  }

  stats(cells: [string, string, string?][], cols = 3) {
    const cw = this.w / cols, ch = 17;
    const rows = Math.ceil(cells.length / cols);
    this.ensure(rows * (ch + 2));
    cells.forEach(([label, value, sub], k) => {
      const cx = this.x0 + (k % cols) * cw, cy = this.y + Math.floor(k / cols) * (ch + 2);
      this.color(C.surface, 'fill'); this.doc.roundedRect(cx, cy, cw - 2, ch, 2, 2, 'F');
      this.font(7.5, 'normal', C.muted); this.doc.text(t(label), cx + 3, cy + 4.5);
      this.font(13, 'bold'); this.doc.text(t(value), cx + 3, cy + 11);
      if (sub) { this.font(7, 'normal', C.muted); this.doc.text(t(sub), cx + 3, cy + 15); }
    });
    this.y += rows * (ch + 2) + 2;
  }

  table(cols: { h: string; w: number; align?: 'left' | 'right' }[], rows: string[][], size = 8) {
    const lh = size * 0.45 + 1.6;
    const header = () => {
      this.ensure(lh * 2);
      this.font(size, 'bold', C.muted);
      let x = this.x0;
      for (const c of cols) { this.doc.text(t(c.h), c.align === 'right' ? x + c.w - 3 : x, this.y + lh * 0.7, { align: c.align === 'right' ? 'right' : 'left' }); x += c.w; }
      this.y += lh;
      this.color(C.line, 'draw'); this.doc.setLineWidth(0.2); this.doc.line(this.x0, this.y, this.x0 + this.w, this.y);
      this.y += 0.6;
    };
    header();
    rows.forEach((r, i) => {
      if (this.y + lh > PAGE.h - PAGE.m - 8) { this.page(); header(); }
      if (i % 2 === 1) { this.color(C.surface, 'fill'); this.doc.rect(this.x0, this.y, this.w, lh, 'F'); }
      this.font(size);
      let x = this.x0;
      r.forEach((cell, k) => {
        const c = cols[k];
        const s = (this.doc.splitTextToSize(t(cell), c.w - 1.5) as string[])[0] ?? '';
        this.doc.text(s, c.align === 'right' ? x + c.w - 3 : x, this.y + lh * 0.7, { align: c.align === 'right' ? 'right' : 'left' });
        x += c.w;
      });
      this.y += lh;
    });
    this.y += 2;
  }

  /** Daily score bars (0-10) with the 7-day average line. Days without monitoring stay empty. */
  dailyChart(d: ReportData) {
    const h = 48, left = this.x0 + 8, w = this.w - 10, top = this.y + 2, base = top + h - 8, ih = h - 12;
    this.ensure(h + 8);
    const n = d.days.length, slot = w / Math.max(1, n), bw = Math.min(5, slot * 0.7);
    const yv = (v: number) => base - (Math.min(10, v) / 10) * ih;
    this.doc.setLineWidth(0.15);
    for (const v of [0, 5, 10]) {
      this.color(C.grid, 'draw'); this.doc.line(left, yv(v), left + w, yv(v));
      this.font(7, 'normal', C.muted); this.doc.text(String(v), left - 2, yv(v) + 1, { align: 'right' });
    }
    d.days.forEach((day, i) => {
      if (day.score === null) return;
      const x = left + slot * i + (slot - bw) / 2;
      this.color(C.bar, 'fill');
      if (day.score < 0.05) { this.doc.circle(x + bw / 2, base, 0.6, 'F'); return; }
      this.doc.roundedRect(x, yv(day.score), bw, base - yv(day.score), Math.min(0.8, bw / 2), Math.min(0.8, bw / 2), 'F');
    });
    this.color(C.ink, 'draw'); this.doc.setLineWidth(0.5);
    let prev: [number, number] | null = null;
    d.avg.forEach((v, i) => {
      if (v === null) { prev = null; return; }
      const p: [number, number] = [left + slot * i + slot / 2, yv(v)];
      if (prev) this.doc.line(prev[0], prev[1], p[0], p[1]);
      prev = p;
    });
    const every = Math.max(1, Math.ceil(n / 10));
    this.font(6.5, 'normal', C.muted);
    d.days.forEach((day, i) => { if (i % every === (n - 1) % every) this.doc.text(t(date(day.dayStart, { day: 'numeric', month: 'short' })), left + slot * i + slot / 2, base + 4, { align: 'center' }); });
    // legend
    this.color(C.bar, 'fill'); this.doc.rect(left, top + h - 1, 3, 2, 'F');
    this.font(7, 'normal', C.muted); this.doc.text('Daily score (0-10)', left + 4.5, top + h + 0.8);
    this.color(C.ink, 'draw'); this.doc.setLineWidth(0.5); this.doc.line(left + 34, top + h, left + 39, top + h);
    this.doc.text('7-day average (needs 3 scored days)', left + 40.5, top + h + 0.8);
    this.y = top + h + 5;
  }

  /** Single-series line over days; gaps where there is no value. */
  lineChart(points: { t: number; v: number | null }[], domain: [number, number], ticks: number[], label: string, color: string, band?: [number, number]) {
    const h = 34, left = this.x0 + 8, w = this.w - 10, top = this.y + 4, base = top + h - 6, ih = h - 8;
    this.ensure(h + 8);
    this.font(8.5, 'bold'); this.doc.text(t(label), this.x0, this.y + 2);
    const n = points.length;
    const xv = (i: number) => left + (n <= 1 ? w / 2 : (w * i) / (n - 1));
    const yv = (v: number) => base - ((Math.min(domain[1], Math.max(domain[0], v)) - domain[0]) / (domain[1] - domain[0])) * ih;
    if (band) { this.color(C.warnSoft, 'fill'); this.doc.rect(left, yv(band[1]), w, yv(band[0]) - yv(band[1]), 'F'); }
    this.doc.setLineWidth(0.15);
    for (const v of ticks) {
      this.color(C.grid, 'draw'); this.doc.line(left, yv(v), left + w, yv(v));
      this.font(7, 'normal', C.muted); this.doc.text(String(v), left - 2, yv(v) + 1, { align: 'right' });
    }
    this.color(color, 'draw'); this.color(color, 'fill'); this.doc.setLineWidth(0.5);
    let prev: [number, number] | null = null;
    points.forEach((p, i) => {
      if (p.v === null) { prev = null; return; }
      const q: [number, number] = [xv(i), yv(p.v)];
      if (prev) this.doc.line(prev[0], prev[1], q[0], q[1]); else this.doc.circle(q[0], q[1], 0.5, 'F');
      prev = q;
    });
    const every = Math.max(1, Math.ceil(n / 10));
    this.font(6.5, 'normal', C.muted);
    points.forEach((p, i) => { if (i % every === (n - 1) % every) this.doc.text(t(date(p.t, { day: 'numeric', month: 'short' })), xv(i), base + 4, { align: 'center' }); });
    this.y = top + h + 2;
  }

  /** One axis: estimate and interval per row, zero line. */
  forest(rows: { label: string; sub: string; diff: Interval | null; verdict: Verdict }[], unit: string) {
    const rowH = 9, labelW = 62, left = this.x0 + labelW, w = this.w - labelW - 4;
    const h = rows.length * rowH + 8;
    this.ensure(h);
    const ext = Math.max(2, ...rows.flatMap((r) => (r.diff ? [Math.abs(r.diff.lo), Math.abs(r.diff.hi)] : []))) * 1.15;
    const xv = (v: number) => left + ((v + ext) / (2 * ext)) * w;
    const top = this.y;
    this.color(C.line, 'draw'); this.doc.setLineWidth(0.25); this.doc.line(xv(0), top, xv(0), top + rows.length * rowH);
    rows.forEach((r, i) => {
      const y = top + i * rowH + 4;
      this.font(8.5, 'bold'); this.doc.text(t(r.label), this.x0, y);
      this.font(7, 'normal', C.muted); this.doc.text(t(r.sub), this.x0, y + 3.4);
      if (!r.diff) { this.doc.text('not enough data', xv(0) + 2, y + 1.5); return; }
      const col = r.verdict === 'higher' ? C.accent : r.verdict === 'lower' ? C.ok : C.barHi;
      this.color(col, 'draw'); this.color(col, 'fill'); this.doc.setLineWidth(0.6);
      this.doc.line(xv(r.diff.lo), y + 1, xv(r.diff.hi), y + 1);
      this.doc.circle(xv(r.diff.estimate), y + 1, 1.1, 'F');
    });
    this.font(7, 'normal', C.muted);
    const yb = top + rows.length * rowH + 3;
    this.doc.text(`${sgn(-ext / 1.15)}`, xv(-ext / 1.15), yb, { align: 'center' });
    this.doc.text(`0 ${unit}`, xv(0), yb, { align: 'center' });
    this.doc.text(`${sgn(ext / 1.15)}`, xv(ext / 1.15), yb, { align: 'center' });
    this.y = yb + 3;
  }

  footer(r: ReportData) {
    const n = this.doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      this.doc.setPage(p);
      this.font(7, 'normal', C.faint);
      this.doc.text(t(`Head Tremor Monitor prototype - not a medical device - generated ${date(r.generatedAt)} ${time(r.generatedAt)}`), PAGE.m, PAGE.h - 8);
      this.doc.text(`Page ${p} of ${n}`, PAGE.w - PAGE.m, PAGE.h - 8, { align: 'right' });
      if (r.containsDemo) {
        this.font(7, 'bold', C.accent);
        this.doc.text('CONTAINS DEMO / SAMPLE DATA - NOT FROM A REAL PERSON', PAGE.w / 2, 9, { align: 'center' });
      }
    }
  }
}

export interface PdfOptions { name?: string; compress?: boolean }

/** Builds the report. Returns the jsPDF document (call .output('blob') in the browser). */
export function buildReportPdf(r: ReportData, opt: PdfOptions = {}): jsPDF {
  const W = new Writer(opt.compress ?? true);
  const o = r.overview;

  // ---------- page 1: summary ----------
  W.h1('Head tremor self-tracking report');
  W.text(`${opt.name ? `${opt.name} - ` : ''}${date(r.period.from)} to ${date(r.period.to)} (${r.period.days} days)`, 10.5, { col: C.muted, gap: 3 });
  W.box('This report comes from a prototype head-worn motion sensor and a hobby pulse sensor, used for personal self-tracking. It is not a medical device and has not been clinically validated. It does not diagnose any condition. The severity score is an engineering score for following one person over time; it is not a clinical rating scale. Please interpret it together with your own clinical assessment.', C.warnSoft, C.warnInk, 8.6);
  if (r.containsDemo) W.box('This report includes demo, replay or generated sample data. It does not describe a real person.', C.accentSoft, C.accent, 8.6);
  if (r.empty) { W.text('No monitoring data in this period.', 11, { style: 'bold' }); W.footer(r); return W.doc; }

  W.h2('At a glance');
  W.stats([
    ['Days with monitoring', `${o.daysWithData} of ${r.period.days}`],
    ['Time monitored', `${o.monitoredH.toFixed(1)} h`, `about ${(o.monitoredH / Math.max(1, o.daysWithData)).toFixed(1)} h per monitored day`],
    ['Tremor episodes', String(o.episodes), o.combinedEpisodes ? `${o.combinedEpisodes} on several axes at once` : undefined],
    ['Time with tremor', fmtMinutes(o.tremorMin * 60), `${pct(o.shareOfTime)} of monitored time`],
    ['Mean daily score', o.meanDailyScore === null ? '-' : `${o.meanDailyScore.toFixed(1)} / 10`, o.maxDailyScore === null ? undefined : `highest day ${o.maxDailyScore.toFixed(1)}`],
    ['Falls / impacts flagged', String(r.falls.length), r.falls.length ? `${r.falls.filter((f) => f.outcome === 'cancelled').length} answered "I'm OK"` : undefined],
  ]);
  W.h2('Daily severity score');
  W.dailyChart(r);
  W.note(`Engineering score v${o.scoreVersion}: combines how far the head moves during tremor (amplitude / frequency, log scale) with how long, as an intensity-weighted share of monitored time. Days with less than ${SEVERITY.minMonitoredS / 60} minutes of monitoring have no score. Not comparable with clinical scales.`);
  const weeks = r.weeks.filter((w) => w.monitoredS > 0);
  if (weeks.length) {
    W.table([{ h: 'Week of', w: 34 }, { h: 'Mean score', w: 30, align: 'right' }, { h: 'Scored days', w: 28, align: 'right' }, { h: 'Episodes', w: 26, align: 'right' }, { h: 'Tremor', w: 30, align: 'right' }, { h: 'Monitored', w: 30, align: 'right' }],
      weeks.map((w) => [date(w.weekStart, { day: 'numeric', month: 'short' }), w.meanScore === null ? '-' : w.meanScore.toFixed(1), String(w.scoredDays), String(w.episodes), fmtMinutes(w.tremorS), fmtMinutes(w.monitoredS)]));
  }

  // ---------- patterns ----------
  W.page();
  W.h1('Patterns and findings');
  W.h2('Tremor pattern (descriptive)');
  W.box('These descriptions say how the shaking looked to the motion sensor (direction, frequency, regularity). They are not a diagnosis. Their wording has not yet been reviewed by a clinician.', C.warnSoft, C.warnInk, 8.2);
  const f = r.hintFeatures;
  if (f.n) {
    W.bullets([
      `Main direction of shaking: "yes-yes" (nod) ${pct(f.axisShare[0], 0)}, tilt ${pct(f.axisShare[1], 0)}, "no-no" (turn) ${pct(f.axisShare[2], 0)} of ${f.n} episodes.`,
      `Frequency: median ${f.freqMedian.toFixed(1)} Hz (middle half ${f.freqIqr[0].toFixed(1)}-${f.freqIqr[1].toFixed(1)} Hz). The device analyses 3.5-8.5 Hz.`,
      `Several axes at once: ${pct(f.combinedShare, 0)} of episodes${Object.keys(f.patternCounts).length ? ` (${Object.entries(f.patternCounts).map(([k, v]) => `${k}: ${v}`).join('; ')})` : ''}.`,
      `Regularity: on average ${pct(f.meanQ, 0)} of motion energy in the tremor band, ${f.meanCycles.toFixed(1)} even cycles per 1.5 s window. ${pct(f.walkingShare, 0)} of episodes mostly while walking.`,
    ]);
  }
  if (!r.hintsEnough) W.text('Too few episodes to describe a pattern.', 9.5);
  for (const h of r.hints) {
    W.text(`${h.text}${h.mention ? ' Worth discussing.' : ''}`, 9.5, { style: 'bold', gap: 0.5 });
    W.note(`Confidence: ${h.confidence} (${h.support} supporting episodes). Evidence: ${h.evidence.join('; ')}.`);
  }

  W.h2('Tags and tremor');
  if (!r.tags.length) W.text('No tags were logged in this period.');
  else {
    W.note('Share of monitored time with tremor in the window after each tag, compared with the same clock time on days without that tag. Point = difference, line = interval (Bonferroni-corrected for the number of comparisons). Associations only, not causes.');
    W.forest(r.tags.map((c) => ({ label: c.label, sub: `${c.nAfter} after / ${c.nBase} baseline windows`, diff: c.diff, verdict: c.verdict })), 'pts');
    W.table([{ h: 'Tag', w: 22 }, { h: 'Window', w: 22 }, { h: 'After', w: 17, align: 'right' }, { h: 'Baseline', w: 19, align: 'right' }, { h: 'Difference (interval)', w: 42, align: 'right' }, { h: 'n', w: 20, align: 'right' }, { h: 'Result', w: 36 }],
      r.tags.map((c) => {
        const wnd = TAGS.windows[c.key as keyof typeof TAGS.windows];
        return [c.label, `${wnd[0]}-${wnd[1]} min`, c.afterShare === null ? '-' : `${c.afterShare.toFixed(1)} %`, c.baseShare === null ? '-' : `${c.baseShare.toFixed(1)} %`,
          c.diff ? `${sgn(c.diff.estimate)} (${sgn(c.diff.lo)} to ${sgn(c.diff.hi)})` : '-', `${c.nAfter}/${c.nBase}`, verdictText(c.verdict)];
      }));
  }

  W.h2('Medication');
  if (!r.meds.length) W.text('No medications were recorded.');
  else {
    W.note('Names and doses as typed by the user. Adherence = doses logged as taken / scheduled doses. Effect = tremor share in the window after each dose taken minus the window before it (paired). This report gives no advice about medication.');
    W.table([{ h: 'Medication', w: 44 }, { h: 'Dose / times', w: 44 }, { h: 'Taken', w: 20, align: 'right' }, { h: 'On time', w: 20, align: 'right' }, { h: 'Late', w: 15, align: 'right' }, { h: 'Skipped', w: 18, align: 'right' }, { h: 'Missed', w: 17, align: 'right' }],
      r.meds.map(({ med, adherence: a }) => [med.name, `${med.dose} ${med.times.join(', ')}`, `${a.taken}/${a.scheduled}`, pct(a.onTimePct, 0), String(a.late), String(a.skipped), String(a.missed)]));
    W.forest(r.meds.map(({ med, effect: e }) => ({ label: med.name, sub: `${e.nPaired} of ${e.nDoses} doses with data before and after`, diff: e.diff, verdict: e.verdict })), 'pts');
    W.bullets(r.meds.map(({ med, effect: e }) => e.diff
      ? `${med.name}: tremor ${e.beforeShare!.toFixed(1)} % of the time in the ${MEDS.beforeMin / 60} h before doses, ${e.afterShare!.toFixed(1)} % ${MEDS.afterStartMin}-${MEDS.afterEndMin} min after (${sgn(e.diff.estimate)} points, ${(100 * e.diff.level).toFixed(1)} % interval ${sgn(e.diff.lo)} to ${sgn(e.diff.hi)}, ${e.nPaired} doses): ${verdictText(e.verdict)}.`
      : `${med.name}: not enough doses with monitoring before and after (${e.nPaired}).`), 8.5);
  }

  W.h2('Heart rate and tremor');
  const hr = r.hr;
  W.bullets([
    hr.during.diff ? `During episodes vs resting the same day: ${sgn(hr.during.diff.estimate)} bpm (interval ${sgn(hr.during.diff.lo)} to ${sgn(hr.during.diff.hi)}, ${hr.during.n} episodes): ${verdictText(hr.during.verdict)}.` : `During episodes vs resting: not enough data (${hr.during.n} episodes).`,
    hr.before.diff ? `5 minutes before episodes vs calm periods: ${sgn(hr.before.diff.estimate)} bpm (interval ${sgn(hr.before.diff.lo)} to ${sgn(hr.before.diff.hi)}, ${hr.before.n} episodes): ${verdictText(hr.before.verdict)}.` : `5 minutes before episodes: not enough data (${hr.before.n} episodes; needs second-by-second data, kept 30 days).`,
  ], 8.5);
  W.note('Movement during shaking can disturb the optical pulse sensor.');

  // ---------- posture, vitals, falls (flow on; no forced page break) ----------
  W.h2('Posture and stillness');
  const p = r.posture;
  W.stats([
    ['Still', fmtMinutes(p.stillS), 'seconds with < 0.4 deg of movement'],
    ['Restless', fmtMinutes(p.restlessS), 'seconds with > 2 deg, not walking'],
    ['Outside usual head position', p.poseMonitoredS ? pct(p.outsidePoseS / p.poseMonitoredS, 0) : 'not calibrated', p.calibratedDays ? `relative to a calibrated neutral pose, ${p.calibratedDays} days` : undefined],
  ]);

  W.h2('Resting heart rate and SpO2 (estimate)');
  const v = r.vitals;
  if (!v.nReadings) W.text('No resting readings in this period (they need several minutes of keeping still with a fingertip on the sensor).');
  else {
    W.text(`Median of ${v.nReadings} resting readings: heart rate ${v.medianBpm!.toFixed(0)} bpm${v.medianSpo2 !== null ? `, SpO2 estimate ${v.medianSpo2.toFixed(0)} %` : ''}.`);
    W.lineChart(v.days.map((d) => ({ t: d.dayStart, v: d.bpm })), [40, 120], [40, 80, 120], 'Daily median resting heart rate (bpm)', C.heart);
    W.lineChart(v.days.map((d) => ({ t: d.dayStart, v: d.spo2 })), [85, 100], [85, 90, 95, 100], 'Daily median resting SpO2 estimate (%), shaded: below 92 %', C.ink, [85, 92]);
    W.note('Readings taken after at least 3 minutes of low motion, with a valid pulse signal, rated good or fair. The SpO2 value comes from a hobby sensor with a generic calibration curve: an uncalibrated estimate, not a clinical measurement.');
    for (const fl of v.flags) W.box(fl.text, C.warnSoft, C.warnInk, 8.4);
  }

  W.h2('Falls and sudden impacts (candidates)');
  if (!r.falls.length) W.text('No fall or impact candidates in this period.');
  else {
    W.table([{ h: 'Date', w: 30 }, { h: 'Time', w: 18 }, { h: 'Peak', w: 18, align: 'right' }, { h: 'Free fall', w: 22, align: 'right' }, { h: 'Head turned', w: 24, align: 'right' }, { h: 'Response', w: 66 }],
      r.falls.map((e) => [date(e.t), time(e.t), `${e.peakG.toFixed(1)} g`, e.freeFallMs ? `${e.freeFallMs} ms` : 'none', `${e.orientationChangeDeg.toFixed(0)} deg`,
        e.outcome === 'cancelled' ? "User answered \"I'm OK\"" : e.outcome === 'confirmed' ? 'User requested help' : e.outcome === 'no-response' ? 'No response within the countdown' : 'Pending']));
  }
  W.note('Rule-based heuristic (free fall and/or hard impact followed by stillness). It misses some falls and can be triggered by dropping the headset.');

  // ---------- episodes ----------
  W.page();
  W.h1('Tremor episodes');
  if (r.episodeRowsNote) W.note(r.episodeRowsNote);
  W.table([{ h: 'Date', w: 24 }, { h: 'Time', w: 14 }, { h: 'Duration', w: 20, align: 'right' }, { h: 'Axes', w: 28 }, { h: 'Pattern', w: 26 }, { h: 'Freq', w: 16, align: 'right' }, { h: 'Amplitude', w: 22, align: 'right' }, { h: 'Score', w: 14, align: 'right' }, { h: 'Walking', w: 14, align: 'right' }],
    r.episodeRows.map((e) => {
      const axes = episodeAxes(e);
      return [date(e.start, { day: 'numeric', month: 'short' }), time(e.start), fmtDuration(e.durationS), axes.length > 1 ? axesShort(axes) : AXIS_SHORT[e.axis],
        e.pattern && e.pattern !== 'single' ? PATTERN_LABEL[e.pattern].split(' (')[0] : '-', `${e.freqHz.toFixed(1)} Hz`, `${e.ampDps.toFixed(1)} deg/s`, e.score.toFixed(1), e.walkingFrac >= 0.5 ? 'yes' : ''];
    }), 7.4);
  W.note('Times are when the device alert was on; shaking starts about 1.7 s earlier. Axes: Nod = "yes-yes", Turn = "no-no", Tilt = ear towards shoulder.');

  // ---------- about ----------
  W.h2('About this report');
  W.bullets([
    'Device: ESP32 with an MPU6050 motion sensor worn on the head, and a MAX30102 optical pulse sensor. Prototype hardware and software.',
    'Tremor detection runs on the device: rhythmic motion between 3.5 and 8.5 Hz that fills a 1.5 s window, with at least 4 evenly spaced cycles. Walking-related bounce is filtered, but a tremor at exactly a multiple of the step rate is missed while walking.',
    'The detector has been tested on simulated motion only. Real-world accuracy (missed or false episodes) is unknown.',
    'Comparisons with tags and medication are associations in self-tracking data, with uncertainty intervals; they do not show causes. Tags and doses are only as complete as the logging.',
    'This report contains health-related personal data. It was generated on the user\'s own device.',
  ], 8.4);

  W.footer(r);
  return W.doc;
}
