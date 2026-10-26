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

describe('how long, what, and who looked', () => {
  it('a code can limit the period; access ends by itself, for both sides', async () => {
    const s = await seeded();
    expect((await s.patient('POST', '/v1/share', {}, { days: 7 })).status).toBe(400);              // only 30 / 90 / 365 / 0
    const { code } = await s.patient('POST', '/v1/share', {}, { days: 30 });
    const added = await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    expect(added.expiresAt).toBe(NOW + 30 * 86_400_000);
    expect((await s.patient('GET', '/v1/share')).doctors[0].expiresAt).toBe(NOW + 30 * 86_400_000);
    s.tick(31 * 86_400_000);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(404);
    expect((await s.patient('GET', '/v1/share')).doctors).toEqual([]);
    expect([...s.db.items.values()].filter((i) => String(i.pk).startsWith('DOC#') || String(i.sk).startsWith('ACC#'))).toHaveLength(0);
  });

  it('the default is 90 days, and "until I stop" never runs out', async () => {
    const s = await seeded();
    const a = await s.patient('POST', '/v1/share', {}, {});
    expect(a.days).toBe(90);
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: a.code });
    s.tick(89 * 86_400_000);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(200);
    s.tick(2 * 86_400_000);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(404);
    const b = await s.patient('POST', '/v1/share', {}, { days: 0 });
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: b.code });
    s.tick(3000 * 86_400_000);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).status).toBe(200);
  });

  it('the patient sees when the doctor last looked', async () => {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    expect((await s.patient('GET', '/v1/share')).doctors[0].lastViewed).toBeNull();
    s.tick(5 * 60_000);
    await s.doctor('GET', '/v1/doctor/patient', { id: P1 });
    expect((await s.patient('GET', '/v1/share')).doctors[0].lastViewed).toBe(NOW + 5 * 60_000);
  });

  it('medications and doses reach the doctor only when the patient ticked the box', async () => {
    const s = await seeded();
    await s.put({ pk: `U#${P1}`, sk: 'MD#m2', id: 'm2', name: 'Demo med', demo: true });
    await s.put({ pk: `U#${P1}`, sk: 'MD#m1', id: 'm1', name: 'Secret medication', dose: '10 mg', times: ['08:00'], days: [], active: true, demo: false });
    await s.put({ pk: `U#${P1}`, sk: 'DS#m1@1', id: 'm1@1', medId: 'm1', status: 'taken', loggedAt: NOW - 3_600_000, demo: false });
    await s.put({ pk: `U#${P1}`, sk: 'DS#m1@2', id: 'm1@2', medId: 'm1', status: 'skipped', loggedAt: NOW - 100 * 86_400_000, demo: false });    // older than the window
    const off = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: off.code });
    const without = await s.doctor('GET', '/v1/doctor/patient', { id: P1 });
    expect(without.medsShared).toBe(false);
    expect(without.meds).toEqual([]);
    expect(JSON.stringify(without)).not.toContain('Secret medication');
    await s.patient('DELETE', '/v1/share', { doctor: 'doc-1' });
    const on = await s.patient('POST', '/v1/share', {}, { meds: true });
    await s.doctor('POST', '/v1/doctor/patients', {}, { code: on.code });
    const withMeds = await s.doctor('GET', '/v1/doctor/patient', { id: P1, days: '30' });
    expect(withMeds.medsShared).toBe(true);
    expect(withMeds.meds.map((m: any) => m.name)).toEqual(['Secret medication']);      // the demo medication is left out
    expect(withMeds.doses.map((x: any) => x.id)).toEqual(['m1@1']);
    expect((await s.patient('GET', '/v1/share')).doctors[0].meds).toBe(true);
  });
});

describe('the doctor tools', () => {
  async function linkedDoctor() {
    const s = await seeded();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor('POST', '/v1/doctor/patients', {}, { code });
    return s;
  }

  it('notes are private to the doctor who wrote them, newest first, and can be deleted', async () => {
    const s = await linkedDoctor();
    const { code } = await s.patient('POST', '/v1/share', {}, {});
    await s.doctor2('POST', '/v1/doctor/patients', {}, { code });                       // a second doctor also sees patient 1
    const a = await s.doctor('POST', '/v1/doctor/notes', {}, { id: P1, text: '  Increase review frequency  ' });
    s.tick(1000);
    await s.doctor('POST', '/v1/doctor/notes', {}, { id: P1, text: 'Second note' });
    const mine = await s.doctor('GET', '/v1/doctor/patient', { id: P1 });
    expect(mine.notes.map((n: any) => n.text)).toEqual(['Second note', 'Increase review frequency']);
    expect((await s.doctor2('GET', '/v1/doctor/patient', { id: P1 })).notes).toEqual([]);            // the other doctor sees nothing
    expect((await s.patient('GET', '/v1/share')).doctors).toHaveLength(2);
    expect(JSON.stringify(await s.patient('GET', '/v1/share'))).not.toContain('review frequency');   // and neither does the patient
    expect((await s.doctor('DELETE', '/v1/doctor/notes', { id: P1, ts: String(a.ts) })).status).toBe(200);
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).notes.map((n: any) => n.text)).toEqual(['Second note']);
  });

  it('notes need a linked patient and sensible text', async () => {
    const s = await linkedDoctor();
    expect((await s.doctor('POST', '/v1/doctor/notes', {}, { id: P1, text: '   ' })).status).toBe(400);
    expect((await s.doctor('POST', '/v1/doctor/notes', {}, { id: P1, text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await s.doctor('POST', '/v1/doctor/notes', {}, { id: P2, text: 'not my patient' })).status).toBe(404);
    expect((await s.patient('POST', '/v1/doctor/notes', {}, { id: P1, text: 'x' })).status).toBe(403);
  });

  it('marking reviewed clears the fall flag until a new fall happens', async () => {
    const s = await linkedDoctor();
    const before = (await s.doctor('GET', '/v1/doctor/patients')).patients[0];
    expect(before).toMatchObject({ falls7: 1, unreviewedFalls: 1, reviewedAt: null });
    expect(before.lastFallTs).toBe(NOW - 3_600_000);
    const t = s.tick(60_000);
    expect((await s.doctor('POST', '/v1/doctor/review', {}, { id: P1 })).reviewedAt).toBe(t);
    const after = (await s.doctor('GET', '/v1/doctor/patients')).patients[0];
    expect(after).toMatchObject({ falls7: 1, unreviewedFalls: 0, lastFallTs: null, reviewedAt: t });   // still counted, no longer urgent
    expect((await s.doctor('GET', '/v1/doctor/patient', { id: P1 })).reviewedAt).toBe(t);
    const t2 = s.tick(60_000);
    await s.put({ pk: `U#${P1}`, sk: `E#${String(t2 - 1000).padStart(13, '0')}#htm-01#9`, ts: t2 - 1000, type: 'fall', fall: { outcome: 'confirmed', peakG: 4 } });
    const again = (await s.doctor('GET', '/v1/doctor/patients')).patients[0];
    expect(again).toMatchObject({ falls7: 2, unreviewedFalls: 1, lastFallTs: t2 - 1000 });
    expect((await s.doctor2('POST', '/v1/doctor/review', {}, { id: P1 })).status).toBe(404);          // only the linked doctor can review
  });
});
