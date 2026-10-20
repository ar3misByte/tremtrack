// Generates a plausible, clearly-labelled SAMPLE history (sessions + episodes) so the Trends screen
// and the report can be demonstrated without weeks of real use. Deterministic for a given seed.
// Everything it makes has source 'sample' and demo = true; it can be removed in Settings.
import type { Axis } from './csv';
import type { Episode, FallEvent, Session } from './model';
import type { RestingReading } from './vitals';
import { displacementDeg, episodeScore } from './severity';
import { SEVERITY } from '../config/thresholds';
import { startOfDay, nextDay } from './daily';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

export interface SampleHistory { sessions: Session[]; episodes: Episode[]; vitals: RestingReading[]; events: FallEvent[] }

export function generateSampleHistory(days = 28, endMs = Date.now(), seed = 1): SampleHistory {
  const r = rng(seed);
  const gauss = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const sessions: Session[] = [];
  const episodes: Episode[] = [];
  const vitals: RestingReading[] = [];
  const events: FallEvent[] = [];
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
      // posture and stillness: calibrated from the second week on
      const mon = sess.monitoredS;
      sess.stillS = mon * (0.25 + 0.15 * r());
      sess.restlessS = mon * (0.05 + 0.08 * Math.max(0, activity) * r());
      sess.poseMonitoredS = dayIdx >= 7 ? mon * 0.9 : 0;
      sess.outsidePoseS = sess.poseMonitoredS * (0.05 + 0.12 * r());
      // resting readings: a few per session, heart rate drifting slightly, SpO2 estimate mostly 95-98 %
      for (let v = 0, nv = 2 + Math.floor(r() * 5); v < nv; v++) {
        const tv = start + ((v + 1) / (nv + 1)) * (end - start);
        const bpm = 63 + 3 * Math.sin(dayIdx / 5) + 2.5 * gauss();
        const q = r();
        vitals.push({
          id: `v_sample_${dayIdx}_${k}_${v}`, sessionId: sid, t: tv, demo: true, bpm, spo2: Math.round(96.5 + 0.9 * gauss()),
          validShare: q < 0.15 ? 0.6 : 0.9, bpmIqr: 2 + 3 * r(), motionDeg: 0.3 + 0.3 * r(), restedS: 180 + 30 * v, quality: q < 0.15 ? 'fair' : 'good',
        });
      }
      const ratePerHour = Math.max(0.3, 4 * activity);
      let t = start + (-Math.log(1 - r()) / ratePerHour) * 3600_000;
      let n = 0;
      while (t < end - 20_000) {
        const durationS = Math.min(240, Math.exp(Math.log(12) + 0.8 * gauss()));
        const ampDps = Math.max(2.6, Math.exp(Math.log(7 * Math.max(0.5, activity)) + 0.45 * gauss()));
        const freqHz = Math.min(8, Math.max(3.8, 5.1 + 0.35 * gauss()));
        const u = r();
        const axis: Axis = u < 0.66 ? 2 : u < 0.9 ? 0 : 1;
        // about one in six "no-no" episodes has "yes-yes" shaking along with it (mostly in step)
        const combined = axis === 2 && r() < 0.25;
        const second = combined ? ampDps * (0.5 + 0.3 * r()) : 0;
        const ampAll = combined ? Math.hypot(ampDps, second) : ampDps;
        const sc = episodeScore({ ampDps: ampAll, freqHz, durationS });
        const share: [number, number, number] = [0.05, 0.05, 0.05];
        share[axis] = 0.9;
        const activeFrac: [number, number, number] = [combined ? 0.7 + 0.25 * r() : 0, 0, 0];
        activeFrac[axis] = 1;
        const byAxis: [number, number, number] = [combined ? second : 0, 0, 0];
        byAxis[axis] = ampDps;
        episodes.push({
          id: `e_sample_${dayIdx}_${k}_${n}`, sessionId: sid, source: 'sample', demo: true, start: t, end: t + durationS * 1000, durationS, axis,
          axisShare: share, axes: combined ? [0, 2] : [axis], axesActiveFrac: activeFrac, ampByAxis: byAxis, pattern: combined ? (r() < 0.8 ? 'diagonal' : 'circular') : 'single',
          ampDps: ampAll, peakAmpDps: ampAll * (1.2 + 0.2 * r()), freqHz, q: 0.7 + 0.2 * r(), cycles: Math.round(6 + r() * 3),
          walkingFrac: r() < 0.1 ? 0.5 : 0, bpm: Math.round(70 + 8 * r()), displacementDeg: displacementDeg(ampAll, freqHz),
          score: sc.score, scoreVersion: SEVERITY.version, sensitivity: 2,
        });
        sess.tremorS += durationS;
        sess.episodes++;
        n++;
        t += durationS * 1000 + (-Math.log(1 - r()) / ratePerHour) * 3600_000;
      }
      sessions.push(sess);
      // one impact candidate about 9 days ago: the headset was put down, the user tapped "I'm OK"
      if (dayIdx === days - 10 && k === 0) {
        const tf = start + (end - start) / 2;
        events.push({ id: `f_sample_${dayIdx}`, sessionId: sid, demo: true, t: tf, path: 'freefall+impact', peakG: 6.8, freeFallMs: 280, orientationChangeDeg: 84, outcome: 'cancelled', resolvedAt: tf + 6000, caregiverAlert: 'not-needed' });
      }
    }
  }
  return { sessions, episodes, vitals, events };
}
