// CSV export of stored episodes and daily summaries (RFC 4180 quoting).
import type { Episode } from '../logic/model';
import type { DaySummary } from '../logic/daily';

const AXIS = ['pitch (yes-yes)', 'roll (tilt)', 'yaw (no-no)'];
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = (head: string[], data: unknown[][]) => [head, ...data].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export function episodesCsv(eps: Episode[]): string {
  return rows(
    ['start_iso', 'end_iso', 'duration_s', 'axis', 'freq_hz', 'amp_dps', 'peak_amp_dps', 'displacement_deg', 'score_0_10', 'score_version', 'walking_frac', 'bpm', 'source', 'demo', 'session_id'],
    eps.map((e) => [new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.durationS, AXIS[e.axis], e.freqHz, e.ampDps, e.peakAmpDps, e.displacementDeg, e.score, e.scoreVersion, e.walkingFrac, e.bpm, e.source, e.demo, e.sessionId]),
  );
}

export function daysCsv(days: DaySummary[]): string {
  return rows(
    ['day', 'score_0_10', 'episodes', 'tremor_s', 'monitored_s', 'share_shaking', 'mean_freq_hz', 'pitch_episodes', 'roll_episodes', 'yaw_episodes'],
    days.map((d) => [d.day, d.score, d.episodes, d.tremorS, d.monitoredS, d.shareShaking, d.meanFreqHz, ...d.axisCounts]),
  );
}

export function download(name: string, data: Blob | string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
