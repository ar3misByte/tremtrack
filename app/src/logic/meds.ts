// Medication schedules, dose status, adherence and due reminders. No dosing logic or advice: names and
// doses are free text and are only displayed back to the user.
import { MEDS } from '../config/thresholds';
import { nextDay, startOfDay } from './daily';
import type { DoseLog, Medication } from './model';

export type MedsConfig = typeof MEDS;
export type DoseState = 'upcoming' | 'due' | 'taken' | 'late' | 'skipped' | 'missed';

export interface Occurrence { med: Medication; at: number; key: string }

export const doseKey = (medId: string, at: number) => `${medId}@${at}`;

export function parseTime(hhmm: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  return h < 24 && min < 60 ? [h, min] : null;
}

/** Scheduled times of a medication between from and to (local time, DST-safe). */
export function occurrences(med: Medication, from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  if (!med.active) return out;                        // a paused medication is not scheduled (and not counted for adherence)
  for (let d = startOfDay(from); d <= to; d = nextDay(d)) {
    const day = new Date(d);
    if (med.days.length && !med.days.includes(day.getDay())) continue;
    if (d < startOfDay(med.createdAt)) continue;
    for (const tm of med.times) {
      const p = parseTime(tm);
      if (!p) continue;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), p[0], p[1]).getTime();
      if (at >= from && at <= to && at >= med.createdAt - 60_000) out.push({ med, at, key: doseKey(med.id, at) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function stateOf(o: Occurrence, log: DoseLog | undefined, now: number, c: MedsConfig = MEDS): DoseState {
  if (log) {
    if (log.status === 'skipped') return 'skipped';
    return log.takenAt !== null && log.takenAt - o.at > c.onTimeMin * 60_000 ? 'late' : 'taken';
  }
  if (now < o.at) return 'upcoming';
  if (now - o.at <= c.missedAfterMin * 60_000) return 'due';
  return 'missed';
}

export interface Adherence { scheduled: number; taken: number; onTime: number; late: number; skipped: number; missed: number; pct: number | null; onTimePct: number | null }

/** Adherence over [from, to]: doses that are no longer upcoming or due. */
export function adherence(meds: Medication[], logs: DoseLog[], from: number, to: number, now: number, c: MedsConfig = MEDS): Adherence {
  const byKey = new Map(logs.map((l) => [l.id, l]));
  const a = { scheduled: 0, taken: 0, onTime: 0, late: 0, skipped: 0, missed: 0 };
  for (const m of meds) {
    for (const o of occurrences(m, from, Math.min(to, now))) {
      const s = stateOf(o, byKey.get(o.key), now, c);
      if (s === 'upcoming' || s === 'due') continue;
      a.scheduled++;
      if (s === 'taken') { a.taken++; a.onTime++; }
      if (s === 'late') { a.taken++; a.late++; }
      if (s === 'skipped') a.skipped++;
      if (s === 'missed') a.missed++;
    }
  }
  return { ...a, pct: a.scheduled ? a.taken / a.scheduled : null, onTimePct: a.scheduled ? a.onTime / a.scheduled : null };
}

/** Doses that are due now and not logged, snoozed or already reminded. */
export function dueReminders(meds: Medication[], logs: DoseLog[], now: number, quiet: Map<string, number>, c: MedsConfig = MEDS): Occurrence[] {
  const byKey = new Set(logs.map((l) => l.id));
  return meds.filter((m) => m.active)
    .flatMap((m) => occurrences(m, now - c.missedAfterMin * 60_000, now))
    .filter((o) => !byKey.has(o.key) && (quiet.get(o.key) ?? 0) <= now);
}

/** Times when a dose was actually taken, for the effect analysis. */
export const takenTimes = (logs: DoseLog[], medId: string) => logs.filter((l) => l.medId === medId && l.status === 'taken' && l.takenAt !== null).map((l) => l.takenAt!);
