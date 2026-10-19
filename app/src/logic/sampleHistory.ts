// Generates a plausible, clearly-labelled SAMPLE history (sessions + episodes) so the Trends screen
// and the report can be demonstrated without weeks of real use. Deterministic for a given seed.
// Everything it makes has source 'sample' and demo = true; it can be removed in Settings.
import type { Axis } from './csv';
import type { Episode, Session } from './model';
import { displacementDeg, episodeScore } from './severity';
import { SEVERITY } from '../config/thresholds';
import { startOfDay, nextDay } from './daily';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

export function generateSampleHistory(days = 28, endMs = Date.now(), seed = 1): { sessions: Session[]; episodes: Episode[] } {
  const r = rng(seed);
  const gauss = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const sessions: Session[] = [];
  const episodes: Episode[] = [];
  const today = startOfDay(endMs);
  let first = today;
  for (let i = 0; i < days - 1; i++) first = startOfDay(first - 3600_000);   // walk back whole local days
  let dayIdx = 0;
  for (let d = first; d <= today; d = nextDay(d), dayIdx++) {
    if (r() < 0.12 && d !== today) continue;                                  // some days not worn
    // underlying tremor activity: slow drift + a weekly bump (busier weekdays)
    const weekday = new Date(d).getDay();
    const activity = 0.8 + 0.5 * Math.sin((dayIdx / days) * Math.PI) + (weekday >= 1 && weekday <= 5 ? 0.25 : -0.1) + 0.2 * gauss();
    const nSessions = 1 + Math.floor(r() * 3);
    const slots = [8.5, 13.5, 19];
    for (let k = 0; k < nSessions; k++) {
      const start = d + (slots[k] + r() * 1.5) * 3600_000;
      const lenS = (30 + r() * 120) * 60;
      const end = Math.min(start + lenS * 1000, endMs);
      if (end <= start + 60_000) continue;
      const sid = `s_sample_${dayIdx}_${k}`;
      const sess: Session = {
        id: sid, source: 'sample', demo: true, start, end, open: false, monitoredS: (end - start) / 1000 * 0.97,
        tremorS: 0, walkingS: ((end - start) / 1000) * (0.05 + r() * 0.15), episodes: 0, frames: Math.round(((end - start) / 1000) * 50), sensitivity: 2,
      };
      const ratePerHour = Math.max(0.3, 4 * activity);
      let t = start + (-Math.log(1 - r()) / ratePerHour) * 3600_000;
      let n = 0;
      while (t < end - 20_000) {
        const durationS = Math.min(240, Math.exp(Math.log(12) + 0.8 * gauss()));
        const ampDps = Math.max(2.6, Math.exp(Math.log(7 * Math.max(0.5, activity)) + 0.45 * gauss()));
        const freqHz = Math.min(8, Math.max(3.8, 5.1 + 0.35 * gauss()));
        const u = r();
        const axis: Axis = u < 0.66 ? 2 : u < 0.9 ? 0 : 1;
        const sc = episodeScore({ ampDps, freqHz, durationS });
        const share: [number, number, number] = [0.05, 0.05, 0.05];
        share[axis] = 0.9;
        episodes.push({
          id: `e_sample_${dayIdx}_${k}_${n}`, sessionId: sid, source: 'sample', demo: true, start: t, end: t + durationS * 1000, durationS, axis,
          axisShare: share, ampDps, peakAmpDps: ampDps * (1.2 + 0.2 * r()), freqHz, q: 0.7 + 0.2 * r(), cycles: Math.round(6 + r() * 3),
          walkingFrac: r() < 0.1 ? 0.5 : 0, bpm: Math.round(70 + 8 * r()), displacementDeg: displacementDeg(ampDps, freqHz),
          score: sc.score, scoreVersion: SEVERITY.version, sensitivity: 2,
        });
        sess.tremorS += durationS;
        sess.episodes++;
        n++;
        t += durationS * 1000 + (-Math.log(1 - r()) / ratePerHour) * 3600_000;
      }
      sessions.push(sess);
    }
  }
  return { sessions, episodes };
}
