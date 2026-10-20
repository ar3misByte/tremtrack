import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { assembleReport } from '../logic/reportData';
import { generateSampleHistory } from '../logic/sampleHistory';
import { buildReportPdf, t } from './pdf';

const NOW = new Date(2026, 9, 20, 18).getTime();
const DAY = 86_400_000;
const h = generateSampleHistory(28, NOW, 5);
const data = assembleReport({ now: NOW, from: NOW - 27 * DAY, to: NOW, sessions: h.sessions, episodes: h.episodes, tags: h.tags, meds: h.meds, doses: h.doses, vitals: h.vitals, events: h.events, samples: [] });

describe('report PDF', () => {
  it('builds a multi-page PDF with every section, the disclaimer and the demo watermark', () => {
    const doc = buildReportPdf(data, { compress: false });
    const pdf = doc.output();
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(5);
    for (const s of ['Head tremor self-tracking report', 'At a glance', 'Daily severity score', 'Tremor pattern', 'Tags and tremor', 'Medication', 'Heart rate and tremor',
      'Posture and stillness', 'Resting heart rate and SpO2', 'Falls and sudden impacts', 'Tremor episodes', 'About this report', 'not a medical device', 'CONTAINS DEMO']) {
      expect(pdf).toContain(s);
    }
    expect(pdf).not.toMatch(/essential tremor|parkinson|dystoni/i);
    // keep a copy to look at (tools/ output is git-ignored)
    mkdirSync(new URL('../../../tools/hostsim/out/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../../../tools/hostsim/out/sample-report.pdf', import.meta.url), Buffer.from(doc.output('arraybuffer')));
  });

  it('handles an empty period', () => {
    const empty = assembleReport({ now: NOW, from: NOW - 400 * DAY, to: NOW - 300 * DAY, sessions: [], episodes: [], tags: [], meds: [], doses: [], vitals: [], events: [], samples: [] });
    const pdf = buildReportPdf(empty, { compress: false }).output();
    expect(pdf).toContain('No monitoring data in this period');
  });

  it('replaces characters the PDF font cannot show', () => {
    expect(t('SpO₂ ≥ 92 % – “ok” → √Σ')).toBe('SpO2 >= 92 % - "ok" -> sqrtsum');
  });
});
