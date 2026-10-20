// Medication reminders while the app is open (in-app banner + browser notification if allowed).
// Limits: a web app cannot wake itself up when it is closed without a push server; email reminders
// through AWS SNS arrive with the cloud backend (milestone 6). The UI says so.
import { useSyncExternalStore } from 'react';
import { MEDS } from '../config/thresholds';
import { doseKey, dueReminders, type Occurrence } from '../logic/meds';
import type { DoseLog, Medication } from '../logic/model';
import { newId } from '../logic/tracker';
import { listDoses, listMeds, onDataChanged, putDose } from './db';

const QUIET_KEY = 'htm.reminders.quiet.v1';

class Reminders {
  private meds: Medication[] = [];
  private doses: DoseLog[] = [];
  private quiet = new Map<string, number>();          // key -> do not remind before this time
  private notified = new Set<string>();
  private due: Occurrence[] = [];
  private listeners = new Set<() => void>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    try { this.quiet = new Map(JSON.parse(sessionStorage.getItem(QUIET_KEY) ?? '[]')); } catch { /* storage unavailable */ }
    void this.load();
    onDataChanged(() => void this.load());
    setInterval(() => this.check(), 30_000);
  }

  private async load() {
    try { [this.meds, this.doses] = await Promise.all([listMeds({ includeDemo: true }), listDoses({ includeDemo: true })]); } catch { /* storage unavailable */ }
    this.check();
  }

  private check() {
    const now = Date.now();
    this.due = dueReminders(this.meds, this.doses, now, this.quiet);
    for (const o of this.due) {
      if (this.notified.has(o.key)) continue;
      this.notified.add(o.key);
      this.notify(o);
    }
    this.listeners.forEach((l) => l());
  }

  private notify(o: Occurrence) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const body = `${o.med.name}${o.med.dose ? ` (${o.med.dose})` : ''}, scheduled for ${new Date(o.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    const show = async () => {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg) await reg.showNotification('Medication reminder', { body, tag: o.key, icon: 'icon-192.png' });
      else new Notification('Medication reminder', { body, tag: o.key });
    };
    void show().catch(() => {});
  }

  private saveQuiet() { try { sessionStorage.setItem(QUIET_KEY, JSON.stringify([...this.quiet])); } catch { /* storage unavailable */ } }

  async log(o: Occurrence, status: 'taken' | 'skipped', takenAt = Date.now()) {
    const d: DoseLog = { id: doseKey(o.med.id, o.at), medId: o.med.id, scheduledFor: o.at, takenAt: status === 'taken' ? takenAt : null, status, loggedAt: Date.now(), demo: o.med.demo };
    this.doses = [...this.doses.filter((x) => x.id !== d.id), d];      // hide the reminder at once
    this.check();
    await putDose(d);
  }
  async logExtra(med: Medication, takenAt = Date.now()) {
    await putDose({ id: newId('d', takenAt), medId: med.id, scheduledFor: null, takenAt, status: 'taken', loggedAt: Date.now(), demo: med.demo });
  }
  snooze(o: Occurrence) {
    this.quiet.set(o.key, Date.now() + MEDS.snoozeMin * 60_000);
    this.notified.delete(o.key);
    this.saveQuiet();
    this.check();
  }

  // ----- React bridge -----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.due;
}

export const reminders = new Reminders();
export const useDueDoses = () => useSyncExternalStore(reminders.subscribe, reminders.getSnapshot);
