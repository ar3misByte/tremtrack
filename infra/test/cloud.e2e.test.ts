// Cloud path end to end against local mocks (automated). The real-deployment version is
// tools/aws/cloud-e2e.mjs (run by the owner, see docs/AWS_SETUP.md step 7).
//   real firmware showcase -> CloudSummarizer (5 s telemetry + events) -> protocol validation ->
//   IoT rule SQL (TypeScript mirror) -> DynamoDB (fake) / events Lambda -> hourly aggregator -> HTTP API
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseLine } from '../../app/src/logic/csv.ts';
import { parseRecording } from '../../app/src/logic/recording.ts';
import { CloudSummarizer, type CloudMessage } from '../../app/src/logic/cloudSummary.ts';
import { topic, validateEvent, validateTelemetry } from '../../app/src/logic/protocol.ts';
import { makeHandler as makeEvents } from '../lambda/events.ts';
import { makeHandler as makeAggregate } from '../lambda/aggregate.ts';
import { makeHandler as makeApi } from '../lambda/api.ts';
import { FakeDdb, rules } from './fakeDdb.ts';

const OWNER = 'ap-south-1:11111111-2222-3333-4444-555555555555';
const THING = 'htm-01';
const SUB = 'user-sub-1';
const rec = parseRecording(gunzipSync(readFileSync(new URL('../../app/public/demo/showcase.rec.gz', import.meta.url))).toString('utf8'));
// place the recording at 10:00 IST today-ish so it falls inside one local day
const T0 = Date.UTC(2026, 9, 20, 4, 30);                 // 10:00 IST
const shift = T0 - rec.start;

async function pipeline() {
  const db = new FakeDdb();
  const alerts: string[] = [];
  const events = makeEvents({ db: db as never, table: 't', now: () => T0, publish: async (s) => { alerts.push(s); } });
  // device comes online (retained status) -> status + registry rules
  for (const item of rules.status(topic(OWNER, THING, 'status'), { v: 1, online: true, ts: T0, fw: 'devsim', tzMin: 330, rate: 0.2 }, T0)!) await db.send({ constructor: { name: 'PutCommand' }, input: { Item: item } });
  const s = new CloudSummarizer(T0, 5);
  const out: CloudMessage[] = [];
  for (const [ms, line] of rec.entries) { const p = parseLine(line); if (p?.kind === 'frame') out.push(...s.push(p.frame, rec.start + ms + shift)); }
  const tEnd = rec.start + rec.entries.at(-1)![0] + shift;
  out.push(...s.close(tEnd));
  // the wearer did not answer the fall countdown
  const fallEv = out.find((m) => m.kind === 'event' && (m.msg as any).type === 'fall')!;
  out.push(s.fallOutcome(tEnd + 1000, { ...(fallEv.msg as any).fall, outcome: 'no-response' }));
  let invalid = 0;
  for (const m of out) {
    if (m.kind === 'telemetry') {
      if (!validateTelemetry(m.msg).ok) invalid++;
      const item = rules.telemetry(topic(OWNER, THING, 'telemetry'), m.msg as never, m.msg.ts);
      if (item) await db.send({ constructor: { name: 'PutCommand' }, input: { Item: item } });
    } else {
      if (!validateEvent(m.msg).ok) invalid++;
      await events(rules.event(topic(OWNER, THING, 'event'), m.msg as never)!);
    }
  }
  // the hourly aggregator runs after the hour has completed
  const agg = makeAggregate({ db: db as never, table: 't', now: () => T0 + 2 * 3_600_000 });
  const aggResult = await agg();
  // a signed-in user, linked to the owner identity
  const api = makeApi({ db: db as never, table: 't', identityFor: async () => OWNER, attachIot: async () => {}, detachIot: async () => {}, deleteAccount: async () => {} });
  const call = (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => api({
    rawPath: path, queryStringParameters: query, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: 'Bearer idtoken' },
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub: SUB, email: 'me@example.com' } } } },
  } as never) as Promise<{ statusCode: number; body: string }>;
  await call('POST', '/v1/me/link', {}, { identityId: OWNER });   // the app links the identity after sign-in
  return { db, out, invalid, alerts, aggResult, call, tEnd };
}

describe('cloud path (local mocks)', async () => {
  const p = await pipeline();
  const body = async (r: Promise<{ statusCode: number; body: string }>) => { const x = await r; return { status: x.statusCode, ...JSON.parse(x.body) }; };

  it('every message the device side produces is valid and accepted by the rules', () => {
    expect(p.invalid).toBe(0);
    const tel = [...p.db.items.values()].filter((i) => String(i.sk).startsWith('T#'));
    expect(tel.length).toBe(p.out.filter((m) => m.kind === 'telemetry').length);
    expect(tel.every((i) => (i.ttl as number) > 0)).toBe(true);
  });

  it('the rule rejects malformed telemetry', () => {
    expect(rules.telemetry(topic(OWNER, THING, 'telemetry'), { v: 1, seq: 1, ts: 5, per: 5, tr: 0 }, T0)).toBeNull();
    expect(rules.telemetry(topic(OWNER, THING, 'telemetry'), { v: 2, seq: 1, ts: T0, per: 5, tr: 0 }, T0)).toBeNull();
  });

  it('stores events and sends one caregiver alert for the unanswered fall', () => {
    const evs = [...p.db.items.values()].filter((i) => String(i.sk).startsWith('E#'));
    expect(evs.filter((e) => e.type === 'episode')).toHaveLength(2);
    expect(evs.filter((e) => e.type === 'fall')).toHaveLength(2);           // pending, then no-response
    expect(p.alerts).toEqual(['Head Tremor Monitor: possible fall']);
  });

  it('the aggregator builds the day record with the same score formula as the app', async () => {
    expect(p.aggResult.hours).toBeGreaterThanOrEqual(1);
    const r = await body(p.call('GET', '/v1/days', { from: '2026-10-20', to: '2026-10-20' }));
    expect(r.status).toBe(200);
    const d = r.days[0];
    expect(d.day).toBe('2026-10-20');
    expect(d.monitoredS).toBeGreaterThan(100);
    expect(d.episodes).toBe(2);
    expect(d.combinedEpisodes).toBe(1);
    expect(d.falls).toBe(1);
    expect(d.score).toBeNull();                       // 130 s of monitoring is below the 10-minute minimum for a daily score
    expect(Object.keys(d).some((k) => /^h\d\d_/.test(k))).toBe(false);    // hour buckets are internal
  });

  it('re-running the aggregator does not change the totals (idempotent)', async () => {
    const before = await body(p.call('GET', '/v1/days', { from: '2026-10-20', to: '2026-10-20' }));
    const agg = makeAggregate({ db: p.db as never, table: 't', now: () => T0 + 3 * 3_600_000 });
    p.db.items.forEach((v) => { if (v.pk === 'DEVICES') delete v.aggHour; });   // force a full re-run
    await agg();
    const after = await body(p.call('GET', '/v1/days', { from: '2026-10-20', to: '2026-10-20' }));
    expect(after.days[0].monitoredS).toBe(before.days[0].monitoredS);
    expect(after.days[0].score).toBe(before.days[0].score);
  });

  it('API: link, me, events, telemetry, sync round trip, input checks, delete everything', async () => {
    expect((await body(p.call('GET', '/v1/days', { from: '2026-10-20', to: '2026-10-20' }))).status).toBe(200);
    const link = await body(p.call('POST', '/v1/me/link', {}, { identityId: OWNER }));
    expect(link.identityId).toBe(OWNER);
    expect((await body(p.call('POST', '/v1/me/link', {}, { identityId: 'nope' }))).status).toBe(400);
    const me = await body(p.call('GET', '/v1/me'));
    expect(me.devices[0].thing).toBe(THING);
    const ev = await body(p.call('GET', '/v1/events', { from: String(T0 - 1000), to: String(p.tEnd + 10_000) }));
    expect(ev.events.length).toBeGreaterThanOrEqual(6);
    const tel = await body(p.call('GET', '/v1/telemetry', { thing: THING, from: String(T0), to: String(T0 + 3_600_000) }));
    expect(tel.telemetry.length).toBeGreaterThan(20);
    expect((await body(p.call('GET', '/v1/telemetry', { thing: THING, from: String(T0), to: String(T0 + 7 * 3_600_000) }))).status).toBe(400);
    const sync = await body(p.call('PUT', '/v1/sync', {}, { tags: [{ id: 't1', t: T0, kind: 'coffee', label: null, demo: false }], meds: [{ id: 'm1', name: 'Med A' }] }));
    expect(sync.stored).toBe(2);
    expect((await body(p.call('PUT', '/v1/sync', {}, { secrets: [] }))).status).toBe(400);
    expect((await body(p.call('PUT', '/v1/sync', {}, { tags: [{ t: 1 }] }))).status).toBe(400);
    const back = await body(p.call('GET', '/v1/sync', { kind: 'tags' }));
    expect(back.tags[0]).toMatchObject({ id: 't1', kind: 'tags' });
    const owned = [...p.db.items.values()].filter((i) => i.pk === `U#${OWNER}`).length;
    const del = await body(p.call('DELETE', '/v1/me'));
    expect(del.deleted).toBe(owned);
    expect([...p.db.items.values()].filter((i) => i.pk === `U#${OWNER}`)).toHaveLength(0);
    expect((await body(p.call('GET', '/v1/me'))).identityId).toBeNull();
  });
});

describe('aggregator score = app formula (20 min of telemetry, two episodes)', async () => {
  const { dailyScore } = await import('../../app/src/logic/severity.ts');
  const db = new FakeDdb();
  const t0 = Date.UTC(2026, 9, 21, 3, 30);   // 09:00 IST
  for (const item of rules.status(topic(OWNER, THING, 'status'), { v: 1, online: true, tzMin: 330 }, t0)!) await db.send({ constructor: { name: 'PutCommand' }, input: { Item: item } });
  for (let i = 0; i < 240; i++) {
    const ts = t0 + i * 5000;
    const tr = i >= 40 && i < 52 ? 1 : 0;
    await db.send({ constructor: { name: 'PutCommand' }, input: { Item: rules.telemetry(topic(OWNER, THING, 'telemetry'), { v: 1, seq: i, ts, per: 5, p: 0, r: 0, y: 0, tr, ax: tr ? 4 : 0, dir: 2, f: tr ? 5 : 0, a: tr ? 12 : 0.3, sev: 0, wk: 0, hr: 70, sp: 97, ppg: 3, pf: null, pt: null, st: 'still', rssi: null, bat: null }, ts) } });
  }
  const events = makeEvents({ db: db as never, table: 't', now: () => t0, publish: async () => {} });
  const eps = [{ start: t0 + 200_000, end: t0 + 260_000, durationS: 60, axes: [2], pattern: 'single', ampDps: 12, freqHz: 5, score: 5, bpm: 72 }, { start: t0 + 600_000, end: t0 + 630_000, durationS: 30, axes: [0, 2], pattern: 'diagonal', ampDps: 15, freqHz: 4.8, score: 5.5, bpm: null }];
  for (const [k, ep] of eps.entries()) await events(rules.event(topic(OWNER, THING, 'event'), { v: 1, seq: k, ts: ep.end, type: 'episode', ep })!);
  await makeAggregate({ db: db as never, table: 't', now: () => t0 + 2 * 3_600_000 })();
  const day = [...db.items.values()].find((i) => i.sk === 'DAY#2026-10-21')!;
  it('matches dailyScore() exactly and keeps resting vitals', () => {
    expect(day.monitoredS).toBe(1200);
    const expected = dailyScore({ episodes: eps.map((e) => ({ ampDps: e.ampDps, freqHz: e.freqHz, durationS: e.durationS })), monitoredS: 1200 }).score;
    expect(expected).not.toBeNull();
    expect(day.score).toBeCloseTo(expected!, 10);
    expect(day.tremorS).toBe(60);
    expect(day.restingBpm).toBe(70);
    expect(day.combinedEpisodes).toBe(1);
  });
});

describe('aggregator includeCurrentHour', () => {
  it('summarises the hour in progress but leaves the cursor at the last complete hour', async () => {
    const db = new FakeDdb();
    const t0 = Date.UTC(2026, 9, 22, 4, 0);
    for (const item of rules.status(topic(OWNER, THING, 'status'), { v: 1, online: true, tzMin: 330 }, t0)!) await db.send({ constructor: { name: 'PutCommand' }, input: { Item: item } });
    for (let i = 0; i < 24; i++) await db.send({ constructor: { name: 'PutCommand' }, input: { Item: rules.telemetry(topic(OWNER, THING, 'telemetry'), { v: 1, seq: i, ts: t0 + 10 * 60_000 + i * 5000, per: 5, tr: 0, st: 'normal', hr: null, sp: null, wk: 0 }, t0) } });
    const now = t0 + 20 * 60_000;
    await makeAggregate({ db: db as never, table: 't', now: () => now })({ includeCurrentHour: true });
    const day = [...db.items.values()].find((i) => i.sk === 'DAY#2026-10-22')!;
    expect(day.monitoredS).toBe(120);
    expect([...db.items.values()].find((i) => i.pk === 'DEVICES')!.aggHour).toBe(Math.floor((now - 60_000) / 3_600_000) * 3_600_000);
  });
});
