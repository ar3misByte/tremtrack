// What the doctor dashboard shows for each patient, and which patients to look at first. Pure functions (tested).
// The thresholds are simple review prompts for a prototype, not diagnostic rules.
import type { PatientDay, PatientDetail, PatientRow, SyncedDose, SyncedMed } from './aws';
import { eventText } from './eventText';

export const DAY_MS = 86_400_000;
export const OFFLINE_AFTER_MS = 24 * 3_600_000;
export const TREND_STEP = 1;            // average severity up or down by this much (0-10 scale) vs the week before
export const SPO2_LOW = 92;             // resting SpO₂ estimate (%)
export const BPM_HIGH = 100, BPM_LOW = 50;

export interface PatientFlag { level: 'alert' | 'watch'; text: string }
export interface PatientOverview {
  id: string; label: string; since: number;
  online: boolean; lastSeen: number | null; hasDevice: boolean;
  latestScore: number | null; latestDay: string | null;
  avg7: number | null; prev7: number | null; trend: 'worse' | 'better' | 'steady' | null;
  episodes7: number; falls7: number; unreviewedFalls: number; lastFallTs: number | null; reviewedAt: number | null; expiresAt: number | null;
  restingBpm: number | null; restingSpo2: number | null;
  spark: (number | null)[];           // the last 14 days' scores, oldest first
  flags: PatientFlag[];
}

/** Calendar day (YYYY-MM-DD) of a time on the clock the cloud uses for days (India, UTC+5:30). */
export const cloudDay = (t: number, tzMin = 330) => new Date(t + tzMin * 60_000).toISOString().slice(0, 10);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const scores = (days: PatientDay[]) => days.map((d) => d.score).filter((x): x is number => typeof x === 'number');

export function overview(p: PatientRow, now = Date.now()): PatientOverview {
  const days = [...p.days].sort((a, b) => a.day.localeCompare(b.day));
  const d7 = days.filter((d) => d.day > cloudDay(now - 7 * DAY_MS) && d.day <= cloudDay(now));
  const dPrev = days.filter((d) => d.day > cloudDay(now - 14 * DAY_MS) && d.day <= cloudDay(now - 7 * DAY_MS));
  const avg7 = mean(scores(d7)), prev7 = mean(scores(dPrev));
  const trend = avg7 === null || prev7 === null ? null : avg7 - prev7 >= TREND_STEP ? 'worse' : prev7 - avg7 >= TREND_STEP ? 'better' : 'steady';
  const lastScored = [...days].reverse().find((d) => typeof d.score === 'number');
  const latest = (k: 'restingBpm' | 'restingSpo2') => [...days].reverse().find((d) => typeof d[k] === 'number')?.[k] ?? null;
  const seen = p.devices.map((d) => d.lastSeen).filter((x): x is number => typeof x === 'number');
  const lastSeen = seen.length ? Math.max(...seen) : null;
  const online = p.devices.some((d) => d.online);
  const o: PatientOverview = {
    id: p.id, label: p.label, since: p.since, online, lastSeen, hasDevice: p.devices.length > 0,
    latestScore: lastScored?.score ?? null, latestDay: lastScored?.day ?? null,
    avg7, prev7, trend, episodes7: d7.reduce((s, d) => s + (d.episodes || 0), 0), falls7: p.falls7, unreviewedFalls: p.unreviewedFalls ?? p.falls7, lastFallTs: p.lastFallTs, reviewedAt: p.reviewedAt ?? null, expiresAt: p.expiresAt ?? null,
    restingBpm: latest('restingBpm'), restingSpo2: latest('restingSpo2'),
    spark: Array.from({ length: 14 }, (_, i) => days.find((d) => d.day === cloudDay(now - (13 - i) * DAY_MS))?.score ?? null),
    flags: [],
  };
  const f = o.flags;
  // falls the doctor has marked as reviewed stop flagging the patient (they still count in the totals)
  if (p.lastFallTs !== null && now - p.lastFallTs < DAY_MS) f.push({ level: 'alert', text: 'A fall that was confirmed or went unanswered in the last 24 hours' });
  else if (o.unreviewedFalls > 0) f.push({ level: 'alert', text: `${o.unreviewedFalls} fall${o.unreviewedFalls === 1 ? '' : 's'} (confirmed or unanswered) in the last 7 days, not yet reviewed` });
  if (!o.hasDevice) f.push({ level: 'watch', text: 'No headset has reported yet' });
  else if (!online && lastSeen !== null && now - lastSeen > OFFLINE_AFTER_MS) f.push({ level: 'watch', text: `Headset has not reported for ${Math.floor((now - lastSeen) / DAY_MS) || 1} day${Math.floor((now - lastSeen) / DAY_MS) > 1 ? 's' : ''}` });
  if (trend === 'worse') f.push({ level: 'watch', text: `Average severity up ${(avg7! - prev7!).toFixed(1)} points on the week before` });
  if (o.restingSpo2 !== null && o.restingSpo2 < SPO2_LOW) f.push({ level: 'watch', text: `Resting SpO₂ estimate ${Math.round(o.restingSpo2)} %` });
  if (o.restingBpm !== null && (o.restingBpm > BPM_HIGH || o.restingBpm < BPM_LOW)) f.push({ level: 'watch', text: `Resting heart rate ${Math.round(o.restingBpm)} bpm` });
  return o;
}

/** Patients that need a look first: falls, then other flags, then the highest recent severity, then name. */
export function triage(rows: PatientOverview[]): PatientOverview[] {
  const rank = (o: PatientOverview) => (o.flags.some((f) => f.level === 'alert') ? 0 : o.flags.length ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.avg7 ?? -1) - (a.avg7 ?? -1) || a.label.localeCompare(b.label));
}

/** "K7M2Q-9XPD4": the share code as written on screen. */
export const formatCode = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

export interface MedAdherence { med: SyncedMed; taken: number; skipped: number; lastTakenAt: number | null; share: number | null }

/** Doses the patient logged per medication in the window: how many taken and skipped, and the share taken. Extra (unscheduled) doses count as taken. */
export function adherence(meds: SyncedMed[], doses: SyncedDose[], now = Date.now(), days = 30): MedAdherence[] {
  const from = now - days * DAY_MS;
  return meds.map((med) => {
    const mine = doses.filter((d) => d.medId === med.id && d.loggedAt >= from && d.loggedAt <= now);
    const taken = mine.filter((d) => d.status === 'taken').length, skipped = mine.filter((d) => d.status === 'skipped').length;
    const times = mine.filter((d) => d.status === 'taken' && typeof d.takenAt === 'number').map((d) => d.takenAt as number);
    return { med, taken, skipped, lastTakenAt: times.length ? Math.max(...times) : null, share: taken + skipped > 0 ? taken / (taken + skipped) : null };
  }).sort((a, b) => Number(b.med.active !== false) - Number(a.med.active !== false) || a.med.name.localeCompare(b.med.name));
}

const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (...v: unknown[]) => v.map(cell).join(',');

/** One patient as CSV for a doctor's own records: daily summary, episodes the patient synced, events, and doses when shared. */
export function patientCsv(d: PatientDetail, exportedAt = Date.now()): string {
  const out: string[] = [row('Patient', d.label), row('Exported', new Date(exportedAt).toISOString()), row('Note', 'Prototype sensor data: scores and vitals are estimates, not clinical measurements'), ''];
  out.push('Daily summary', row('day', 'score_0_10', 'episodes', 'falls', 'monitored_min', 'tremor_min', 'resting_bpm', 'resting_spo2_pct'));
  for (const x of [...d.days].sort((a, b) => a.day.localeCompare(b.day))) out.push(row(x.day, x.score != null ? x.score.toFixed(2) : '', x.episodes ?? 0, x.falls ?? 0, Math.round((x.monitoredS ?? 0) / 60), Math.round((x.tremorS ?? 0) / 60), x.restingBpm != null ? Math.round(x.restingBpm) : '', x.restingSpo2 != null ? Math.round(x.restingSpo2) : ''));
  out.push('', 'Episodes uploaded by the patient', row('start', 'duration_s', 'frequency_hz', 'amplitude_dps', 'score_0_10'));
  for (const e of d.episodes) out.push(row(new Date(e.start).toISOString(), Math.round(e.durationS), e.freqHz?.toFixed(2), e.ampDps?.toFixed(2), e.score?.toFixed(2)));
  out.push('', 'Events', row('time', 'type', 'description'));
  for (const e of d.events) out.push(row(new Date(e.ts).toISOString(), e.type, eventText(e)));
  if (d.medsShared) {
    out.push('', 'Medication doses (shared by the patient)', row('medication', 'dose', 'status', 'logged', 'taken_at'));
    const name = new Map(d.meds.map((m) => [m.id, m]));
    for (const x of d.doses) out.push(row(name.get(x.medId)?.name ?? x.medId, name.get(x.medId)?.dose, x.status, new Date(x.loggedAt).toISOString(), x.takenAt ? new Date(x.takenAt).toISOString() : ''));
  }
  return out.join('\r\n') + '\r\n';
}
