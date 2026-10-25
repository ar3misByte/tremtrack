// Doctor sharing: consent by one-time code, per-patient access, revoking, and what a doctor can and cannot read.
import { describe, expect, it } from 'vitest';
import { makeHandler as makeApi } from '../lambda/api.ts';
import { FakeDdb } from './fakeDdb.ts';

const P1 = 'ap-south-1:11111111-2222-3333-4444-555555555555';
const P2 = 'ap-south-1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = Date.UTC(2026, 9, 25, 6, 0);
const DAY = (n: number) => new Date(NOW + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);

function setup() {
  const db = new FakeDdb();
  let clock = NOW;
  let n = 0;
  const api = makeApi({ db: db as never, table: 't', identityFor: async (tok) => (tok === 'p2' ? P2 : P1), attachIot: async () => {}, detachIot: async () => {}, deleteAccount: async () => {}, now: () => clock, newCode: () => `ABCDEFGH${'KMNPQRST'[n]}${'KMNPQRST'[n++]}` });
  const as = (sub: string, extra: Record<string, unknown> = {}, token = 'p1') => async (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => {
    const r = (await api({
      rawPath: path, queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` },
      requestContext: { http: { method }, authorizer: { jwt: { claims: { sub, email: `${sub}@example.com`, ...extra } } } },
    } as never)) as { statusCode: number; body: string };
    return { status: r.statusCode, ...JSON.parse(r.body) } as Record<string, any>;
  };
  const put = (item: Record<string, unknown>) => db.send({ constructor: { name: 'PutCommand' }, input: { Item: item } });
  return { db, patient: as('pat-1'), patient2: as('pat-2', {}, 'p2'), doctor: as('doc-1', { 'cognito:groups': '[doctors]' }), doctor2: as('doc-2', { 'cognito:groups': '[doctors]' }), nobody: as('pat-3', {}), put, tick: (ms: number) => (clock += ms) };
}

async function seeded() {
  const s = setup();
  await s.patient('POST', '/v1/me/link', {}, { identityId: P1 });
  await s.patient2('POST', '/v1/me/link', {}, { identityId: P2 });
  for (let i = 0; i < 5; i++) await s.put({ pk: `U#${P1}`, sk: `DAY#${DAY(i)}`, score: 3 + i, episodes: i, falls: 0, monitoredS: 3600, restingBpm: 70 + i, restingSpo2: 97, h09_htm: 1 });
  await s.put({ pk: `U#${P1}`, sk: 'D#htm-01', thing: 'htm-01', online: true, lastSeen: NOW - 60_000, fw: 'htm-0.8.4' });
  await s.put({ pk: `U#${P1}`, sk: `E#${String(NOW - 3_600_000).padStart(13, '0')}#htm-01#1`, ts: NOW - 3_600_000, type: 'fall', fall: { outcome: 'no-response', peakG: 3.2 }, owner: P1, thing: 'htm-01' });
  await s.put({ pk: `U#${P1}`, sk: `EP#${String(NOW - 7_200_000).padStart(13, '0')}#e1`, id: 'e1', start: NOW - 7_200_000, durationS: 30, freqHz: 5, ampDps: 10, score: 4, demo: false });
  await s.put({ pk: `U#${P1}`, sk: `EP#${String(NOW - 7_300_000).padStart(13, '0')}#e2`, id: 'e2', start: NOW - 7_300_000, durationS: 30, demo: true });
  await s.put({ pk: `U#${P1}`, sk: `MD#m1`, id: 'm1', name: 'Secret medication' });
  await s.put({ pk: `U#${P2}`, sk: `DAY#${DAY(0)}`, score: 9, episodes: 9, monitoredS: 3600 });
  return s;
}

describe('sharing with a doctor', () => {
  it('a patient makes a code, the doctor redeems it once, and then sees only that patient', async () => {
    const s = await seeded();
    const made = await s.patient('POST', '/v1/share', {}, { name: 'A. Patient' });
    expect(made.status).toBe(200);
    expect(made.code).toMatch(/^[A-Z2-9]{10}$/);
    const added = await s.doctor('POST', '/v1/doctor/patients', {}, { code: `${made.code.slice(0, 5)}-${made.code.slice(5).toLowerCase()}` });     // typed with a dash, in lower case
    expect(added).toMatchObject({ status: 200, patientId: P1, label: 'A. Patient' });
    expect((await s.doctor('POST', '/v1/doctor/patients', {}, { code: made.code })).status).toBe(404);     // single use

    const list = await s.doctor('GET', '/v1/doctor/patients');
    expect(list.patients).toHaveLength(1);
    expect(list.patients[0]).toMatchObject({ id: P1, label: 'A. Patient', falls7: 1 });
    expect(list.patients[0].devices[0]).toMatchObject({ thing: 'htm-01', online: true });
    expect(list.patients[0].days).toHaveLength(5);
    expect(JSON.stringify(list)).not.toMatch(/h09_htm/);
  });

  it('detail: days, events, synced episodes and vitals; demo records and medications are not included', async () => {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    const r = await s.doctor('GET', '/v1/doctor/patient', { id: encodeURIComponent(P1), days: '30' });
    expect(r.status).toBe(200);
    expect(r.days).toHaveLength(5);
    expect(r.events.map((e: any) => e.type)).toEqual(['fall']);
    expect(r.episodes.map((e: any) => e.id)).toEqual(['e1']);          // the demo episode is left out
    expect(JSON.stringify(r)).not.toContain('Secret medication');
    expect(JSON.stringify(r)).not.toMatch(/h09_htm|"pk"|"sk"/);
  });

  it('refuses everything without consent', async () => {
    const s = await seeded();
    expect((await s.nobody('GET', '/v1/doctor/patients')).status).toBe(403);                    // not in the doctors group
    expect((await s.patient('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(403);        // a patient cannot use doctor routes on themselves
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(404);         // no link yet
    expect((await s.doctor('POST', '/v1/doctor/patients', {}, { code: 'ZZZZZZZZZZ' })).status).toBe(404);   // guessed code
    expect((await s.doctor('POST', '/v1/doctor/patients', {}, { code: 'short' })).status).toBe(400);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: 'not-an-id' })).status).toBe(400);
  });

  it('a doctor cannot read a patient who shared with a different doctor', async () => {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    expect((await s.doctor2('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(404);
    expect((await s.doctor2('GET', '/v1/doctor/patients')).patients).toEqual([]);
    const { code: c2 } = await s.patient2('POST', '/v1/share', {}, {});
    await s.doctor2('POST', '/v1/doctor/patients', {}, { code: c2 });
    expect((await s.doctor2('GET', '/v1/doctor/patient', { id: P2 })).status).toBe(200);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P2 })).status).toBe(404);          // and not the other way round
  });

  it('codes expire after 24 hours', async () => {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    s.tick(24 * 3_600_000 + 1000);
    expect((await s.doctor('POST', '/v1/doctor/patients', {}, { code })).status).toBe(404);
  });

  it('the patient sees who has access and can revoke it at once', async () => {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    const who = await s.patient('GET', '/v1/share');
    expect(who.doctors).toHaveLength(1);
    expect(who.doctors[0]).toMatchObject({ doctor: 'doc-1', email: 'doc-1@example.com' });
    expect((await s.patient('DELETE', '/v1/share', { doctor: 'doc-1' })).status).toBe(200);
    expect((await s.patient('GET', '/v1/share')).doctors).toEqual([]);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(404);
    expect((await s.doctor('GET', '/v1/doctor/patients')).patients).toEqual([]);
  });

  it('the doctor can stop seeing a patient, and deleting the patient removes every doctor link', async () => {
    const s = await seeded();
    const a = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: a.code });
    expect((await s.doctor('DELETE', '/v1/doctor/patients', { id: P1 })).status).toBe(200);
    expect((await s.patient('GET', '/v1/share')).doctors).toEqual([]);
    const b = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: b.code });
    expect((await s.patient('DELETE', '/v1/me')).status).toBe(200);
    expect([...s.db.items.values()].filter((i) => String(i.pk).startsWith('DOC#'))).toHaveLength(0);
  });

  it('works with the real claim shape from API Gateway ("[doctors]" among other groups)', async () => {
    const s = await seeded();
    const multi = (g: string) => (async () => {
      const api = makeApi({ db: s.db as never, table: 't', identityFor: async () => P1, attachIot: async () => {}, detachIot: async () => {}, deleteAccount: async () => {} });
      const r = (await api({ rawPath: '/v1/doctor/patients', queryStringParameters: {}, headers: {}, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'x', 'cognito:groups': g } } } } } as never)) as { statusCode: number };
      return r.statusCode;
    })();
    expect(await multi('[admins doctors]')).toBe(200);
    expect(await multi('[doctors]')).toBe(200);
    expect(await multi('[nodoctors]')).toBe(403);
    expect(await multi('[doctors-trainee]')).toBe(403);
    expect(await multi('')).toBe(403);
  });
});
