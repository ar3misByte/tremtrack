// Local storage (IndexedDB). Everything here stays on this device until cloud sync (milestone 6-7).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DoseLog, Episode, FallEvent, Medication, Sample, Session, Tag } from '../logic/model';
import type { RestingReading } from '../logic/vitals';
import { STORAGE } from '../config/thresholds';
import { DAY_MS } from '../logic/daily';

interface TremorDB extends DBSchema {
  sessions: { key: string; value: Session; indexes: { start: number } };
  episodes: { key: string; value: Episode; indexes: { start: number; sessionId: string } };
  samples: { key: [string, number]; value: Sample; indexes: { t: number } };
  vitals: { key: string; value: RestingReading; indexes: { t: number } };
  events: { key: string; value: FallEvent; indexes: { t: number } };
  tags: { key: string; value: Tag; indexes: { t: number } };
  meds: { key: string; value: Medication };
  doses: { key: string; value: DoseLog; indexes: { loggedAt: number } };
}

const ALL = ['sessions', 'episodes', 'samples', 'vitals', 'events', 'tags', 'meds', 'doses'] as const;

export const DB_NAME = 'htm-local';
let dbp: Promise<IDBPDatabase<TremorDB>> | null = null;

export function db() {
  dbp ??= openDB<TremorDB>(DB_NAME, 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('start', 'start');
        const e = d.createObjectStore('episodes', { keyPath: 'id' });
        e.createIndex('start', 'start');
        e.createIndex('sessionId', 'sessionId');
        const m = d.createObjectStore('samples', { keyPath: ['sessionId', 't'] });
        m.createIndex('t', 't');
      }
      if (oldVersion < 2) {                         // milestone 3: resting vitals and fall events
        d.createObjectStore('vitals', { keyPath: 'id' }).createIndex('t', 't');
        d.createObjectStore('events', { keyPath: 'id' }).createIndex('t', 't');
      }
      if (oldVersion < 3) {                         // milestone 4: tags, medications, dose log
        d.createObjectStore('tags', { keyPath: 'id' }).createIndex('t', 't');
        d.createObjectStore('meds', { keyPath: 'id' });
        d.createObjectStore('doses', { keyPath: 'id' }).createIndex('loggedAt', 'loggedAt');
      }
    },
    blocking() { void dbp?.then((x) => x.close()); dbp = null; },
  });
  return dbp;
}

// ---------- change notifications (Trends and the Live "today" card listen) ----------
const listeners = new Set<() => void>();
export const onDataChanged = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const notifyDataChanged = () => listeners.forEach((l) => l());

// ---------- writes ----------
export async function saveBatch(b: { session?: Session; episodes?: Episode[]; samples?: Sample[]; vitals?: RestingReading[]; events?: FallEvent[] }) {
  const d = await db();
  const tx = d.transaction(['sessions', 'episodes', 'samples', 'vitals', 'events'], 'readwrite');
  if (b.session) void tx.objectStore('sessions').put(b.session);
  for (const e of b.episodes ?? []) void tx.objectStore('episodes').put(e);
  for (const s of b.samples ?? []) void tx.objectStore('samples').put(s);
  for (const v of b.vitals ?? []) void tx.objectStore('vitals').put(v);
  for (const e of b.events ?? []) void tx.objectStore('events').put(e);
  await tx.done;
  if (b.session || b.episodes?.length || b.vitals?.length || b.events?.length) notifyDataChanged();
}

export async function listVitals(from: number, to: number, f: Filter): Promise<RestingReading[]> {
  const all = await (await db()).getAllFromIndex('vitals', 't', IDBKeyRange.bound(from, to));
  return all.filter((v) => f.includeDemo || !v.demo);
}

export async function listEvents(from: number, to: number, f: Filter): Promise<FallEvent[]> {
  const all = await (await db()).getAllFromIndex('events', 't', IDBKeyRange.bound(from, to));
  return all.filter((e) => f.includeDemo || !e.demo);
}

export async function importRecords(sessions: Session[], episodes: Episode[], vitals: RestingReading[] = [], events: FallEvent[] = [], extra: { tags?: Tag[]; meds?: Medication[]; doses?: DoseLog[] } = {}) {
  await saveBatch({ episodes, vitals, events });
  for (const t of extra.tags ?? []) await putTag(t, false);
  for (const m of extra.meds ?? []) await putMed(m, false);
  for (const x of extra.doses ?? []) await putDose(x, false);
  const d = await db();
  const tx = d.transaction('sessions', 'readwrite');
  for (const s of sessions) void tx.store.put(s);
  await tx.done;
  notifyDataChanged();
}

// ---------- reads ----------
export interface Filter { includeDemo: boolean }

export async function listEpisodes(from: number, to: number, f: Filter): Promise<Episode[]> {
  const all = await (await db()).getAllFromIndex('episodes', 'start', IDBKeyRange.bound(from, to));
  return all.filter((e) => f.includeDemo || !e.demo);
}

/** Sessions overlapping [from, to]. Sessions are assumed shorter than a day. */
export async function listSessions(from: number, to: number, f: Filter): Promise<Session[]> {
  const all = await (await db()).getAllFromIndex('sessions', 'start', IDBKeyRange.bound(from - DAY_MS, to));
  return all.filter((s) => s.end >= from && (f.includeDemo || !s.demo));
}

export async function listSamples(from: number, to: number): Promise<Sample[]> {
  return (await db()).getAllFromIndex('samples', 't', IDBKeyRange.bound(from, to));
}

export async function counts() {
  const d = await db();
  const [sessions, episodes, samples, vitals, events, tags, meds, doses] = await Promise.all(ALL.map((s) => d.count(s)));
  const demoSessions = (await d.getAll('sessions')).filter((s) => s.demo).length;
  return { sessions, episodes, samples, vitals, events, tags, meds, doses, demoSessions };
}

// ---------- maintenance ----------
export async function pruneSamples(now = Date.now()) {
  const d = await db();
  const tx = d.transaction('samples', 'readwrite');
  let cur = await tx.store.index('t').openCursor(IDBKeyRange.upperBound(now - STORAGE.sampleRetentionDays * DAY_MS));
  let n = 0;
  while (cur) { await cur.delete(); n++; cur = await cur.continue(); }
  await tx.done;
  return n;
}

/** Deletes demo / replay / sample records only. */
export async function deleteDemoData() {
  const d = await db();
  const tx = d.transaction([...ALL], 'readwrite');
  for (const store of ALL) {
    let cur = await tx.objectStore(store).openCursor();
    while (cur) { if (cur.value.demo) await cur.delete(); cur = await cur.continue(); }
  }
  await tx.done;
  notifyDataChanged();
}

/** Deletes everything stored locally by this app (IndexedDB data and settings). */
export async function deleteAllLocalData() {
  const d = await db();
  const tx = d.transaction([...ALL], 'readwrite');
  await Promise.all([...ALL.map((s) => tx.objectStore(s).clear()), tx.done]);
  try { localStorage.removeItem('htm.settings.v1'); } catch { /* storage unavailable */ }
  notifyDataChanged();
}

export async function exportAll() {
  const d = await db();
  const [sessions, episodes, samples, vitals, events, tags, meds, doses] = await Promise.all(ALL.map((s) => d.getAll(s))) as [Session[], Episode[], Sample[], RestingReading[], FallEvent[], Tag[], Medication[], DoseLog[]];
  return {
    format: 'head-tremor-monitor-export', version: 3, tags, medications: meds, doseLog: doses, exportedAt: new Date().toISOString(),
    note: 'Prototype data. Not a medical record. Scores are engineering scores, not clinical ratings. SpO2 is an uncalibrated estimate. Fall events are heuristic candidates.',
    sessions, episodes, samples, restingVitals: vitals, fallEvents: events,
  };
}

/** Sessions left "open" by a closed tab or crash are marked closed (their data up to the last flush is kept). */
export async function closeStaleSessions() {
  const d = await db();
  const tx = d.transaction('sessions', 'readwrite');
  let cur = await tx.store.openCursor();
  let n = 0;
  while (cur) { if (cur.value.open) { await cur.update({ ...cur.value, open: false }); n++; } cur = await cur.continue(); }
  await tx.done;
  return n;
}

// ---------- milestone 4: tags, medications, dose log ----------
export async function putTag(t: Tag, notify = true) { await (await db()).put('tags', t); if (notify) notifyDataChanged(); }
export async function deleteTag(id: string) { await (await db()).delete('tags', id); notifyDataChanged(); }
export async function listTags(from: number, to: number, f: Filter): Promise<Tag[]> {
  const all = await (await db()).getAllFromIndex('tags', 't', IDBKeyRange.bound(from, to));
  return all.filter((t) => f.includeDemo || !t.demo);
}
export async function putMed(m: Medication, notify = true) { await (await db()).put('meds', m); if (notify) notifyDataChanged(); }
/** Deleting a medication also deletes its dose log. */
export async function deleteMed(id: string) {
  const d = await db();
  const tx = d.transaction(['meds', 'doses'], 'readwrite');
  void tx.objectStore('meds').delete(id);
  let cur = await tx.objectStore('doses').openCursor();
  while (cur) { if (cur.value.medId === id) await cur.delete(); cur = await cur.continue(); }
  await tx.done;
  notifyDataChanged();
}
export async function listMeds(f: Filter): Promise<Medication[]> {
  return (await (await db()).getAll('meds')).filter((m) => f.includeDemo || !m.demo).sort((a, b) => a.createdAt - b.createdAt);
}
export async function putDose(x: DoseLog, notify = true) { await (await db()).put('doses', x); if (notify) notifyDataChanged(); }
export async function deleteDose(id: string) { await (await db()).delete('doses', id); notifyDataChanged(); }
export async function listDoses(f: Filter): Promise<DoseLog[]> {
  return (await (await db()).getAll('doses')).filter((x) => f.includeDemo || !x.demo);
}
