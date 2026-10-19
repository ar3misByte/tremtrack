// Tremor severity score, 0-10. An ENGINEERING score for self-tracking, not a clinical scale.
// Formula and reasoning: docs/SEVERITY.md. Weights: config/thresholds.ts (SEVERITY).
//
// Properties (tested in severity.test.ts):
//   - every result is in [0, 10] (capped)
//   - episode score never decreases when amplitude or duration increases
//   - at a fixed angular rate, a lower frequency means a larger displacement, so a higher score
//   - daily score never decreases when an episode is added or made longer / stronger,
//     for a fixed amount of monitored time
import { SEVERITY } from '../config/thresholds';

export type SeverityConfig = typeof SEVERITY;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const logScale = (x: number, x0: number, xMax: number) => clamp01(Math.log1p(Math.max(0, x) / x0) / Math.log1p(xMax / x0));

/** Peak angular displacement of a sinusoid with peak rate `ampDps` at `freqHz` (degrees). */
export function displacementDeg(ampDps: number, freqHz: number): number {
  if (!(ampDps > 0) || !(freqHz > 0)) return 0;
  return ampDps / (2 * Math.PI * freqHz);
}

export interface EpisodeScoreInput { ampDps: number; freqHz: number; durationS: number }
export interface EpisodeScore { score: number; intensity: number; durationTerm: number; displacementDeg: number }

export function episodeScore(e: EpisodeScoreInput, c: SeverityConfig = SEVERITY): EpisodeScore {
  const theta = displacementDeg(e.ampDps, e.freqHz);
  const intensity = logScale(theta, c.theta0Deg, c.thetaMaxDeg);
  const durationTerm = logScale(e.durationS, c.d0S, c.dMaxS);
  const score = (10 * (c.wIntensity * intensity + c.wDuration * durationTerm)) / (c.wIntensity + c.wDuration);
  return { score: Math.min(10, Math.max(0, score)), intensity, durationTerm, displacementDeg: theta };
}

export interface DailyScoreInput { episodes: EpisodeScoreInput[]; monitoredS: number }
export interface DailyScore {
  score: number | null;          // null = not enough monitored time
  burden: number;                // intensity-weighted share of time
  shareShaking: number;          // plain share of monitored time with an episode
  tremorS: number;
  monitoredS: number;
  episodes: number;
  reason?: 'not-enough-data';
}

export function dailyScore(d: DailyScoreInput, c: SeverityConfig = SEVERITY): DailyScore {
  const tremorS = d.episodes.reduce((s, e) => s + Math.max(0, e.durationS), 0);
  const weighted = d.episodes.reduce((s, e) => s + Math.max(0, e.durationS) * episodeScore(e, c).intensity, 0);
  const T = Math.max(d.monitoredS, tremorS);            // monitored time can never be less than the time shaking
  const base = { tremorS, monitoredS: d.monitoredS, episodes: d.episodes.length };
  if (d.monitoredS < c.minMonitoredS) {
    return { ...base, score: null, burden: 0, shareShaking: 0, reason: 'not-enough-data' };
  }
  const burden = T > 0 ? weighted / T : 0;
  const score = 10 * logScale(burden, c.b0, c.bMax);
  return { ...base, score: Math.min(10, Math.max(0, score)), burden, shareShaking: T > 0 ? tremorS / T : 0 };
}

/** Plain-language band for a score, used next to the number (never a clinical label). */
export function scoreBand(score: number | null): string {
  if (score === null) return 'Not enough data';
  if (score < 0.05) return 'None recorded';
  if (score < 2.5) return 'Low';
  if (score < 5) return 'Moderate';
  if (score < 7.5) return 'High';
  return 'Very high';
}
