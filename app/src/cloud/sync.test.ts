import { describe, expect, it } from 'vitest';
import { emptyCounts, MAX_PER_REQUEST, syncNow, type Kind, type Records, type SyncApi, type SyncIO } from './sync';

const empty = (): Records => ({ episodes: [], sessions: [], tags: [], meds: [], doses: [], vitals: [], falls: [] });
type Rec = { id: string; start?: number; t?: number };
const SK: Record<Kind, (r: Rec) => string> = { episodes: (r) => `EP#${r.start}#${r.id}`, sessions: (r) => `SE#${r.start}#${r.id}`, tags: (r) => `TG#${r.t}#${r.id}`, meds: (r) => `MD#${r.id}`, doses: (r) => `DS#${r.id}`, vitals: (r) => `RV#${r.t}#${r.id}`, falls: (r) => `FE#${r.t}#${r.id}` };

/** An in-memory cloud with the same put-by-key / read-by-kind behaviour as the API. */
function fakeCloud() {
  const store = new Map<string, Record<string, unknown>>();
  const requests: Record<string, unknown[]>[] = [];
  const api: SyncApi = {
    async syncPut(records) {
      requests.push(records);
      let n = 0;
      for (const [k, list] of Object.entries(records)) for (const r of list) { store.set(SK[k as Kind](r as Rec), { ...(r as object), kind: k, syncedAt: 1 }); n++; }
      return { stored: n };
    },
    async syncGet(kind, since) { return { [kind]: [...store.entries()].filter(([key]) => key.startsWith(SK[kind]({ id: '', start: 0, t: 0 }).split('#')[0] + '#')).map(([, v]) => v).filter((v) => (v.syncedAt as number) >= since) }; },
  };
  return { api, store, requests };
}
function device(initial: Partial<Records> = {}) {
  const data: Records = { ...empty(), ...initial };
  const io: SyncIO = {
    async readLocal() { return structuredClone(data); },
    async importRemote(r) { for (const [k, list] of Object.entries(r)) (data as unknown as Record<string, unknown[]>)[k].push(...(list as unknown[])); },
  };
  return { data, io };
}
const ep = (id: string, start: number, demo = false) => ({ id, start, demo, durationS: 12, score: 3.1 });

describe('sync', () => {
  it('uploads real records only: never demo or sample data, never a session still recording', async () => {
    const c = fakeCloud();
    const d = device({
      episodes: [ep('e1', 1000), ep('e2', 2000, true)] as never,
      sessions: [{ id: 's1', start: 500, demo: false, open: false }, { id: 's2', start: 900, demo: false, open: true }, { id: 's3', start: 100, demo: true, open: false }] as never,
      tags: [{ id: 't1', t: 3000, kind: 'coffee', label: null, demo: false }] as never,
    });
    const r = await syncNow(c.api, d.io, { includeMeds: false, since: 0 });
    expect(r.uploaded).toMatchObject({ episodes: 1, sessions: 1, tags: 1 });
    expect([...c.store.keys()].sort()).toEqual(['EP#1000#e1', 'SE#500#s1', 'TG#3000#t1']);
  });

  it('leaves medication names and doses at home unless asked', async () => {
    const meds = [{ id: 'm1', name: 'Example', dose: '1', times: ['08:00'], days: [], active: true, createdAt: 1, demo: false }];
    const doses = [{ id: 'm1@5', medId: 'm1', scheduledFor: 5, takenAt: 6, status: 'taken', loggedAt: 6, demo: false }];
    const off = fakeCloud();
    await syncNow(off.api, device({ meds, doses } as never).io, { includeMeds: false, since: 0 });
    expect(off.store.size).toBe(0);
    const on = fakeCloud();
    const r = await syncNow(on.api, device({ meds, doses } as never).io, { includeMeds: true, since: 0 });
    expect(r.uploaded).toMatchObject({ meds: 1, doses: 1 });
  });

  it('a second device receives what the first uploaded, and does not duplicate what it already has', async () => {
    const c = fakeCloud();
    const a = device({ episodes: [ep('e1', 1000), ep('e2', 2000)] as never, tags: [{ id: 't1', t: 3000, kind: 'stress', label: null, demo: false }] as never });
    await syncNow(c.api, a.io, { includeMeds: false, since: 0 });
    const b = device({ episodes: [ep('e2', 2000), ep('e3', 4000)] as never });
    const r = await syncNow(c.api, b.io, { includeMeds: false, since: 0 });
    expect(r.downloaded).toMatchObject({ episodes: 1, tags: 1 });
    expect(b.data.episodes.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3']);
    expect(b.data.tags[0]).toMatchObject({ id: 't1', demo: false });
    expect(Object.keys(b.data.episodes[1] as object)).not.toContain('kind');      // cloud bookkeeping is stripped
    expect(Object.keys(b.data.episodes[1] as object)).not.toContain('syncedAt');
    const again = await syncNow(c.api, b.io, { includeMeds: false, since: 0 });   // idempotent
    expect(again.downloaded).toEqual(emptyCounts());
    expect(c.store.size).toBe(4);
  });

  it('splits a large upload into requests the API accepts', async () => {
    const c = fakeCloud();
    const episodes = Array.from({ length: MAX_PER_REQUEST * 2 + 5 }, (_, i) => ep(`e${i}`, 1000 + i));
    const r = await syncNow(c.api, device({ episodes: episodes as never }).io, { includeMeds: false, since: 0 });
    expect(r.uploaded.episodes).toBe(episodes.length);
    expect(c.requests.map((q) => Object.values(q).flat().length)).toEqual([MAX_PER_REQUEST, MAX_PER_REQUEST, 5]);
    expect(c.requests.every((q) => Object.values(q).flat().length <= 500)).toBe(true);
  });

  it('skips a record that is too large for the API and says so; skips records without a time', async () => {
    const c = fakeCloud();
    const big = { ...ep('big', 1), note: 'x'.repeat(9000) };
    const r = await syncNow(c.api, device({ episodes: [big, ep('ok', 2), { id: 'no-time', demo: false }] as never }).io, { includeMeds: false, since: 0 });
    expect(r.tooLarge).toBe(1);
    expect(r.uploaded.episodes).toBe(1);
  });

  it('asks only for what changed since the last sync', async () => {
    const c = fakeCloud();
    c.store.set('EP#1#old', { id: 'old', start: 1, kind: 'episodes', syncedAt: 100 });
    c.store.set('EP#2#new', { id: 'new', start: 2, kind: 'episodes', syncedAt: 900 });
    const d = device();
    const r = await syncNow(c.api, d.io, { includeMeds: false, since: 500 });
    expect(d.data.episodes.map((e) => e.id)).toEqual(['new']);
    expect(r.downloaded.episodes).toBe(1);
  });
});
