// Optional two-way sync of the app's own records with the user's cloud table (PUT / GET /v1/sync).
// Only when the user presses "Sync now". Demo, replay and sample data never leave the device. Medication names and
// doses are the most personal thing in the app, so they sync only when that box is ticked.
// Records are keyed by id, so uploading twice is harmless, and a record a device already has is never overwritten.
import { importRecords, listDoses, listEpisodes, listEvents, listMeds, listSessions, listTags, listVitals } from '../data/db';
import type { DoseLog, Episode, FallEvent, Medication, Session, Tag } from '../logic/model';
import type { RestingReading } from '../logic/vitals';


export const KINDS = ['episodes', 'sessions', 'tags', 'meds', 'doses', 'vitals', 'falls'] as const;
export type Kind = (typeof KINDS)[number];
export interface Records {
  episodes: Episode[]; sessions: Session[]; tags: Tag[]; meds: Medication[]; doses: DoseLog[]; vitals: RestingReading[]; falls: FallEvent[];
}
export type Counts = Record<Kind, number>;
export const emptyCounts = (): Counts => ({ episodes: 0, sessions: 0, tags: 0, meds: 0, doses: 0, vitals: 0, falls: 0 });

export interface SyncIO {
  readLocal(): Promise<Records>;
  importRemote(r: Partial<Records>): Promise<void>;
}
export interface SyncApi {
  syncPut(records: Record<string, unknown[]>): Promise<{ stored: number }>;
  syncGet(kind: Kind, since: number): Promise<Record<string, Record<string, unknown>[]>>;
}
export interface SyncResult { uploaded: Counts; downloaded: Counts; tooLarge: number; at: number }

export const MAX_PER_REQUEST = 400;           // the API accepts 500
export const MAX_RECORD_BYTES = 7_500;        // the API accepts 8,000

const timeField: Record<Kind, 'start' | 't' | null> = { episodes: 'start', sessions: 'start', tags: 't', meds: null, doses: null, vitals: 't', falls: 't' };

export async function syncNow(api: SyncApi, io: SyncIO, opt: { includeMeds: boolean; since: number; now?: () => number }): Promise<SyncResult> {
  const now = opt.now ?? Date.now;
  const kinds = KINDS.filter((k) => opt.includeMeds || (k !== 'meds' && k !== 'doses'));
  const local = await io.readLocal();
  const uploaded = emptyCounts(), downloaded = emptyCounts();
  let tooLarge = 0;

  // ---- upload ----
  const queue: [Kind, unknown][] = [];
  for (const k of kinds) {
    for (const rec of local[k] as unknown as Record<string, unknown>[]) {
      if (rec.demo) continue;
      if (k === 'sessions' && rec.open) continue;                                // still recording
      const tf = timeField[k];
      if (tf && typeof rec[tf] !== 'number') continue;
      if (JSON.stringify(rec).length > MAX_RECORD_BYTES) { tooLarge++; continue; }
      queue.push([k, rec]);
    }
  }
  for (let i = 0; i < queue.length; i += MAX_PER_REQUEST) {
    const batch: Record<string, unknown[]> = {};
    for (const [k, rec] of queue.slice(i, i + MAX_PER_REQUEST)) (batch[k] ??= []).push(rec);
    await api.syncPut(batch);
    for (const [k, list] of Object.entries(batch)) uploaded[k as Kind] += list.length;
  }

  // ---- download what this device does not have yet ----
  const have = (k: Kind) => new Set((local[k] as unknown as { id: string }[]).map((r) => r.id));
  const incoming: Partial<Records> = {};
  for (const k of kinds) {
    const remote = (await api.syncGet(k, opt.since))[k] ?? [];
    const ids = have(k);
    const fresh = remote.filter((r) => typeof r.id === 'string' && !ids.has(r.id as string)).map((r) => { const rest = { ...r }; delete rest.kind; delete rest.syncedAt; return { ...rest, demo: false }; });
    if (fresh.length) { (incoming as Record<string, unknown[]>)[k] = fresh; downloaded[k] = fresh.length; }
  }
  if (Object.keys(incoming).length) await io.importRemote(incoming);
  return { uploaded, downloaded, tooLarge, at: now() };
}

/** The real thing: this device's IndexedDB. */
export const localIO: SyncIO = {
  async readLocal() {
    const f = { includeDemo: false }, end = Date.now() + 86_400_000;
    const [episodes, sessions, tags, meds, doses, vitals, falls] = await Promise.all([
      listEpisodes(0, end, f), listSessions(0, end, f), listTags(0, end, f), listMeds(f), listDoses(f), listVitals(0, end, f), listEvents(0, end, f),
    ]);
    return { episodes, sessions, tags, meds, doses, vitals, falls };
  },
  async importRemote(r) {
    await importRecords(r.sessions ?? [], r.episodes ?? [], r.vitals ?? [], r.falls ?? [], { tags: r.tags, meds: r.meds, doses: r.doses });
  },
};
