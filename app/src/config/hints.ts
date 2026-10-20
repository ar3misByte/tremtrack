// TREMOR PATTERN HINTS: the reviewable table.
//
// !!! CLINICAL WORDING NOT YET REVIEWED. Every row is marked 'needs-clinical-review' and the app shows a
// !!! banner saying so. Have a clinician review the text, conditions and sources before any real use.
//
// Wording rules (enforced by tests in logic/hints.test.ts):
//   - describe a PATTERN ("pattern consistent with ..."), never a diagnosis;
//   - no disease or condition names anywhere in the user-facing text;
//   - suggest "worth mentioning to a doctor" where relevant; never advice on treatment.
// Conditions use the features computed in logic/hints.ts; thresholds come from config/thresholds.ts (HINTS).
import { HINTS } from './thresholds';
import type { HintFeatures } from '../logic/hints';

export interface HintRule {
  id: string;
  /** User-facing text. {freq}, {perDay}, {pattern}, {from}, {to} are filled from the features. */
  text: string;
  when: (f: HintFeatures) => boolean;
  /** How many episodes support this hint (drives the confidence level). */
  support: (f: HintFeatures) => number;
  /** The numbers shown as evidence. */
  evidence: (f: HintFeatures) => string[];
  mention?: boolean;              // add "worth mentioning to a doctor"
  source: string;
  review: 'needs-clinical-review' | 'reviewed';
}

const pct = (x: number) => `${Math.round(100 * x)} %`;
const BHATIA = 'Bhatia KP et al., "Consensus Statement on the Classification of Tremors", Movement Disorders 2018;33(1):75-87: tremor is described by body part, direction and frequency; head tremor is commonly described as horizontal ("no-no") or vertical ("yes-yes").';
const ELBLE = 'Elble RJ, McNames J, "Using portable transducers to measure tremor severity", Tremor and Other Hyperkinetic Movements 2016;6:375: practical frequency and amplitude measures from motion sensors. The device itself analyses 3.5-8.5 Hz (firmware), so frequencies outside that band are not seen.';
const ENGINEERING = 'Engineering note, no clinical source: based on how this prototype measures regularity and on known detector limits (docs/DETECTOR_BASELINE.md).';
const SELF_TRACKING = 'Self-tracking guidance, no clinical source: changes in symptoms are worth discussing with a doctor. The thresholds are engineering choices in config/thresholds.ts.';

export const HINT_RULES: HintRule[] = [
  {
    id: 'regular-horizontal',
    text: 'Pattern consistent with a regular side-to-side ("no-no") head tremor, around {freq} Hz.',
    when: (f) => f.axisShare[2] >= HINTS.dominantShare && f.regular && f.freqMedian >= 3.5 && f.freqMedian <= 8.5,
    support: (f) => Math.round(f.n * f.axisShare[2]),
    evidence: (f) => [`"No-no" is the main direction in ${pct(f.axisShare[2])} of ${f.n} episodes`, `Median frequency ${f.freqMedian.toFixed(1)} Hz (middle half ${f.freqIqr[0].toFixed(1)}–${f.freqIqr[1].toFixed(1)} Hz)`, `Regularity: ${pct(f.meanQ)} of motion energy in the tremor band, about ${f.meanCycles.toFixed(0)} even cycles per 1.5 s`],
    mention: true, source: BHATIA, review: 'needs-clinical-review',
  },
  {
    id: 'regular-vertical',
    text: 'Pattern consistent with a regular up-and-down ("yes-yes") head tremor, around {freq} Hz.',
    when: (f) => f.axisShare[0] >= HINTS.dominantShare && f.regular && f.freqMedian >= 3.5 && f.freqMedian <= 8.5,
    support: (f) => Math.round(f.n * f.axisShare[0]),
    evidence: (f) => [`"Yes-yes" is the main direction in ${pct(f.axisShare[0])} of ${f.n} episodes`, `Median frequency ${f.freqMedian.toFixed(1)} Hz`, `Regularity: ${pct(f.meanQ)} band energy, about ${f.meanCycles.toFixed(0)} even cycles per 1.5 s`],
    mention: true, source: BHATIA, review: 'needs-clinical-review',
  },
  {
    id: 'tilting',
    text: 'Pattern consistent with a regular side-tilting head tremor, around {freq} Hz.',
    when: (f) => f.axisShare[1] >= HINTS.dominantShare && f.regular,
    support: (f) => Math.round(f.n * f.axisShare[1]),
    evidence: (f) => [`Tilting is the main direction in ${pct(f.axisShare[1])} of ${f.n} episodes`, `Median frequency ${f.freqMedian.toFixed(1)} Hz`],
    mention: true, source: BHATIA, review: 'needs-clinical-review',
  },
  {
    id: 'combined',
    text: 'The shaking often involves two directions at once, mostly {pattern}.',
    when: (f) => f.combinedShare >= HINTS.oftenShare,
    support: (f) => Math.round(f.n * f.combinedShare),
    evidence: (f) => [`${pct(f.combinedShare)} of ${f.n} episodes had more than one axis shaking`, ...Object.entries(f.patternCounts).map(([k, v]) => `${k}: ${v} episodes`)],
    source: BHATIA + ' Combined-direction analysis: ' + ENGINEERING, review: 'needs-clinical-review',
  },
  {
    id: 'varying-direction',
    text: 'The direction of the shaking varies between episodes.',
    when: (f) => Math.max(...f.axisShare) < HINTS.dominantShare && f.combinedShare < HINTS.oftenShare,
    support: (f) => f.n,
    evidence: (f) => [`Main direction: "yes-yes" ${pct(f.axisShare[0])}, tilt ${pct(f.axisShare[1])}, "no-no" ${pct(f.axisShare[2])}`],
    source: BHATIA, review: 'needs-clinical-review',
  },
  {
    id: 'lower-frequency',
    text: 'The frequency is at the lower end of the band the device looks at (around {freq} Hz).',
    when: (f) => f.freqMedian < 4.5,
    support: (f) => f.n,
    evidence: (f) => [`Median ${f.freqMedian.toFixed(1)} Hz; the device analyses 3.5–8.5 Hz`],
    source: ELBLE, review: 'needs-clinical-review',
  },
  {
    id: 'higher-frequency',
    text: 'The frequency is at the upper end of the band the device looks at (around {freq} Hz).',
    when: (f) => f.freqMedian > 7,
    support: (f) => f.n,
    evidence: (f) => [`Median ${f.freqMedian.toFixed(1)} Hz; the device analyses 3.5–8.5 Hz`],
    source: ELBLE, review: 'needs-clinical-review',
  },
  {
    id: 'irregular',
    text: 'Episodes are less regular than a steady rhythmic tremor; some may be other movements such as talking or fidgeting.',
    when: (f) => !f.regular,
    support: (f) => f.n,
    evidence: (f) => [`${pct(f.meanQ)} of motion energy in the tremor band on average`, `About ${f.meanCycles.toFixed(1)} even cycles per 1.5 s window`],
    source: ENGINEERING, review: 'needs-clinical-review',
  },
  {
    id: 'while-walking',
    text: 'Many episodes were detected while walking, where the detector is less reliable.',
    when: (f) => f.walkingShare >= HINTS.oftenShare,
    support: (f) => Math.round(f.n * f.walkingShare),
    evidence: (f) => [`${pct(f.walkingShare)} of episodes were mostly while walking`],
    source: ENGINEERING, review: 'needs-clinical-review',
  },
  {
    id: 'frequent',
    text: 'Episodes are frequent: about {perDay} a day on days with monitoring.',
    when: (f) => f.perDay >= 10 && f.daysWithData >= 5,
    support: (f) => f.n,
    evidence: (f) => [`${f.n} episodes over ${f.daysWithData} monitored days`],
    mention: true, source: SELF_TRACKING, review: 'needs-clinical-review',
  },
  {
    id: 'rising',
    text: 'The weekly severity score has risen over recent weeks (from {from} to {to}).',
    when: (f) => f.weeklyScores.length >= 3 && f.weeklyScores[f.weeklyScores.length - 1] - f.weeklyScores[0] >= 1.5,
    support: (f) => f.n,
    evidence: (f) => [`Weekly mean scores: ${f.weeklyScores.map((s) => s.toFixed(1)).join(' → ')}`],
    mention: true, source: SELF_TRACKING, review: 'needs-clinical-review',
  },
];
