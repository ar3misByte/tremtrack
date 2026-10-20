import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { counts, deleteAllLocalData, deleteDemoData, exportAll, listEpisodes, listSessions, pruneSamples, saveBatch, importRecords } from './db';
import { generateSampleHistory } from '../logic/sampleHistory';
import { SessionTracker } from '../logic/tracker';
import type { Frame } from '../logic/csv';
import type { Episode, Sample } from '../logic/model';
import { episodesCsv } from './csvExport';

const base: Frame = {
  pitch: 0, roll: 0, yaw: 0, fPitch: 0, fRoll: 0, fYaw: 0, tremor: false, dir: 0, ampP: 0.3, ampR: 0.3, ampY: 0.3, freq: 0, q: 0.2,
  walking: false, stepHz: 0, cycles: 0, bpm: 72, spo2: 97, ppgState: 3, pulse: 0, axes: 0, aMax: 1, aMin: 1, nValues: 23, extra: [],
};
const NOW = Date.UTC(2026, 9, 20, 12);

function realSession(t0: number) {
  const tr = new SessionTracker('serial', t0, 2);
  const eps: Episode[] = [], smp: Sample[] = [];
  for (let i = 0; i < 1500; i++) {
    const s = i / 50;
    for (const ev of tr.push({ ...base, ...(s > 5 && s < 15 ? { tremor: true, dir: 2, ampY: 10, freq: 5 } : {}) }, t0 + i * 20)) {
      if (ev.type === 'episode') eps.push(ev.episode); else if (ev.type === 'sample') smp.push(ev.sample);
    }
  }
  for (const ev of tr.close()) { if (ev.type === 'episode') eps.push(ev.episode); else if (ev.type === 'sample') smp.push(ev.sample); }
  return { session: tr.session, episodes: eps, samples: smp };
}

beforeEach(async () => { await deleteAllLocalData(); });

describe('local database', () => {
  it('stores a recorded session and reads it back by time range', async () => {
    const r = realSession(NOW - 3600_000);
    await saveBatch(r);
    const eps = await listEpisodes(NOW - 2 * 3600_000, NOW, { includeDemo: false });
    expect(eps).toHaveLength(1);
    expect(eps[0].axis).toBe(2);
    expect(await listSessions(NOW - 2 * 3600_000, NOW, { includeDemo: false })).toHaveLength(1);
    expect((await counts()).samples).toBe(30);
  });

  it('filters and deletes demo data without touching real data', async () => {
    await saveBatch(realSession(NOW - 3600_000));
    const h = generateSampleHistory(14, NOW, 2);
    await importRecords(h.sessions, h.episodes);
    const all = await listEpisodes(0, NOW, { includeDemo: true });
    const real = await listEpisodes(0, NOW, { includeDemo: false });
    expect(all.length).toBeGreaterThan(real.length);
    expect((await counts()).demoSessions).toBe(h.sessions.length);
    await deleteDemoData();
    expect(await listEpisodes(0, NOW, { includeDemo: true })).toHaveLength(1);
  });

  it('prunes samples older than the retention period', async () => {
    await saveBatch(realSession(NOW - 40 * 86_400_000));
    await saveBatch(realSession(NOW - 3600_000));
    expect(await pruneSamples(NOW)).toBe(30);
    expect((await counts()).samples).toBe(30);
  });

  it('exports everything, and deleteAll empties the stores', async () => {
    await saveBatch(realSession(NOW - 3600_000));
    const x = await exportAll();
    expect(x.sessions).toHaveLength(1);
    expect(x.episodes).toHaveLength(1);
    expect(episodesCsv(x.episodes).split('\r\n')[0]).toContain('start_iso');
    await deleteAllLocalData();
    expect(await counts()).toEqual({ sessions: 0, episodes: 0, samples: 0, vitals: 0, events: 0, tags: 0, meds: 0, doses: 0, demoSessions: 0 });
  });
});

describe('crash recovery', () => {
  it('closes sessions left open', async () => {
    const r = realSession(NOW - 3600_000);
    await saveBatch({ session: { ...r.session, open: true } });
    const { closeStaleSessions } = await import('./db');
    expect(await closeStaleSessions()).toBe(1);
    expect((await listSessions(0, NOW, { includeDemo: true }))[0].open).toBe(false);
  });
});
