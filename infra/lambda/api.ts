// HTTP API (API Gateway v2, Cognito JWT authorizer). Every route is scoped to the signed-in user.
//   GET    /v1/me                  profile: linked identity id, devices
//   POST   /v1/me/link             link the caller's Cognito identity (verified) and allow it to read its MQTT topics
//   GET    /v1/days?from=&to=      daily aggregates (YYYY-MM-DD, max 400 days)
//   GET    /v1/events?from=&to=    device events (ms, max 120 days)
//   GET    /v1/telemetry?thing=&from=&to=   raw 0.2-1 Hz telemetry (ms, max 6 h; kept 14 days)
//   PUT    /v1/sync                upsert app records {episodes, sessions, tags, meds, doses, vitals, falls}
//   GET    /v1/sync?kind=&since=   read synced records back (other devices / reinstall)
//   DELETE /v1/me[?account=true]   delete all of the user's cloud data (and optionally the account)
// Sharing with a doctor (consent comes from the patient: a one-time code they hand over, revocable any time):
//   POST   /v1/share               patient: make a code {name?, days?: 0|30|90|365, meds?} (valid 24 h, one use; days = how long the doctor keeps access, 0 = until stopped)
//   GET    /v1/share               patient: the doctors who can see their data, until when, whether medications are shared, and when they last looked
//   DELETE /v1/share?doctor=<sub>  patient: take a doctor's access away
// Doctor routes (the caller must be in the Cognito group "doctors" AND the patient must have shared with them):
//   POST   /v1/doctor/patients {code}        add a patient with the code they gave
//   GET    /v1/doctor/patients               patients with their devices and the last 14 days
//   GET    /v1/doctor/patient?id=&days=      one patient: devices, days, events, synced episodes, resting vitals, the doctor's notes, and medications if shared
//   POST   /v1/doctor/notes {id,text}        a private note about a patient (only this doctor can read it)
//   DELETE /v1/doctor/notes?id=&ts=          delete one of those notes
//   POST   /v1/doctor/review {id}            mark the patient's falls as seen (they stop flagging the patient)
//   DELETE /v1/doctor/patients?id=           stop seeing a patient
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { IoTClient, AttachPolicyCommand, DetachPolicyCommand } from '@aws-sdk/client-iot';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { randomInt } from 'node:crypto';
import { DEFAULT_TZ_MIN, K, SYNC_KINDS, SYNC_PREFIX, TABLE, ddb, json, localDay, log, type SyncKind } from './shared.ts';

export interface Deps {
  db: DynamoDBDocumentClient;
  table: string;
  /** Resolves the identity id that belongs to the caller's ID token (Cognito GetId). */
  identityFor: (idToken: string) => Promise<string>;
  attachIot: (identityId: string) => Promise<void>;
  detachIot: (identityId: string) => Promise<void>;
  deleteAccount: (username: string) => Promise<void>;
  now?: () => number;
  newCode?: () => string;
}

const MAX_SYNC_ITEMS = 500;
const MAX_ITEM_BYTES = 8_000;
const IDENTITY_RE = /^[a-z]{2}-[a-z]+-\d:[0-9a-f-]{36}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no I, L, O, 0, 1: easy to read out over the phone
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{10}$/;
const SUB_RE = /^[\w-]{1,64}$/;
const CODE_TTL_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
const SHARE_DAYS = [0, 30, 90, 365];                       // how long a doctor keeps access; 0 = until the patient stops it
const NOTE_MAX = 2000;
const defaultCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
/** API Gateway hands array claims over as the string "[doctors]" (a test may pass the array itself). */
const isDoctor = (c: Record<string, unknown>) => /(^|[[\s,])doctors([\],\s]|$)/.test(String(c['cognito:groups'] ?? ''));

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;
const claims = (e: Ev) => e.requestContext.authorizer.jwt.claims as Record<string, string>;

async function queryAll(d: Deps, input: ConstructorParameters<typeof QueryCommand>[0], limit = 5000) {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await d.db.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
    items.push(...((r.Items ?? []) as Record<string, unknown>[]));
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key && items.length < limit);
  return items;
}

/** A query value, URL-decoded once (identity ids contain a colon the client encodes; already-decoded values pass unchanged). */
const qp = (v: string | undefined) => { try { return decodeURIComponent(v ?? ''); } catch { return v ?? ''; } };
const strip = (x: Record<string, unknown>) => { const { pk: _p, sk: _s, ttl: _t, ...rest } = x; return rest; };
/** The few fields of a day the patient list needs (hour buckets stay internal). */
const compactDay = (x: Record<string, unknown>) => ({ day: String(x.sk).slice(4), score: x.score ?? null, episodes: x.episodes ?? 0, falls: x.falls ?? 0, monitoredS: x.monitoredS ?? 0, restingBpm: x.restingBpm ?? null, restingSpo2: x.restingSpo2 ?? null });

export function makeHandler(d: Deps) {
  const now = d.now ?? Date.now;
  const del = (pk: string, sk: string) => d.db.send(new DeleteCommand({ TableName: d.table, Key: { pk, sk } }));
  const owner = async (sub: string) => {
    const r = await d.db.send(new GetCommand({ TableName: d.table, Key: { pk: K.profile(sub), sk: 'PROFILE' } }));
    return (r.Item?.identityId as string | undefined) ?? null;
  };

  return async (e: Ev) => {
    const c = claims(e);
    const sub = c.sub;
    if (!sub) return json(401, { error: 'unauthenticated' });
    const route = `${e.requestContext.http.method} ${e.rawPath}`;
    const q = e.queryStringParameters ?? {};
    try {
      if (route === 'GET /v1/me') {
        const id = await owner(sub);
        const devices = id ? (await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :d)', ExpressionAttributeValues: { ':p': K.user(id), ':d': 'D#' } })).map(strip) : [];
        return json(200, { sub, email: c.email ?? null, identityId: id, devices });
      }

      if (route === 'POST /v1/me/link') {
        const body = JSON.parse(e.body ?? '{}');
        const idToken = (e.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!IDENTITY_RE.test(body.identityId ?? '')) return json(400, { error: 'identityId missing or malformed' });
        const real = await d.identityFor(idToken);                // proves the identity belongs to this token
        if (real !== body.identityId) return json(403, { error: 'identity does not belong to this user' });
        await d.attachIot(real);
        await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: K.profile(sub), sk: 'PROFILE', identityId: real, linkedAt: Date.now() } }));
        return json(200, { identityId: real });
      }

      if (e.rawPath.startsWith('/v1/doctor/')) {
        if (!isDoctor(c)) return json(403, { error: 'This account is not a doctor account.' });
        const doctorKey = K.doctor(sub);
        type Link = { label?: string; since?: number; meds?: boolean; expiresAt?: number | null; reviewedAt?: number | null };
        const p13 = (n: number) => String(Math.round(n)).padStart(13, '0');
        const dropLink = async (pid: string) => { await del(doctorKey, `PT#${pid}`); await del(K.user(pid), `ACC#${sub}`); };
        const runOut = (l: Link) => typeof l.expiresAt === 'number' && l.expiresAt < now();
        /** The doctor's link to a patient, or undefined when there is none or the patient's chosen period has run out (removed on the spot). */
        const linked = async (pid: string): Promise<Link | undefined> => {
          const l = (await d.db.send(new GetCommand({ TableName: d.table, Key: { pk: doctorKey, sk: `PT#${pid}` } }))).Item as Link | undefined;
          if (l && runOut(l)) { await dropLink(pid); return undefined; }
          return l;
        };
        const readBody = (): Record<string, unknown> | null => { try { return JSON.parse(e.body || '{}'); } catch { return null; } };

        if (route === 'POST /v1/doctor/patients') {
          const body = readBody();
          if (!body) return json(400, { error: 'invalid JSON' });
          const code = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!CODE_RE.test(code)) return json(400, { error: 'A code has 10 letters and digits, for example K7M2Q-9XPD4.' });
          const it = (await d.db.send(new GetCommand({ TableName: d.table, Key: { pk: K.share(code), sk: 'CODE' } }))).Item as { owner: string; label: string; expiresAt: number; meds?: boolean; durationDays?: number | null } | undefined;
          if (!it || it.expiresAt < now()) return json(404, { error: 'That code is not valid, was already used, or has expired. Ask the patient for a new one.' });
          const until = it.durationDays ? now() + it.durationDays * DAY_MS : null;
          const meds = it.meds === true;
          await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: doctorKey, sk: `PT#${it.owner}`, label: it.label, since: now(), meds, expiresAt: until, reviewedAt: null } }));
          await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: K.user(it.owner), sk: `ACC#${sub}`, doctor: sub, email: c.email ?? null, since: now(), meds, expiresAt: until, lastViewed: null } }));
          await del(K.share(code), 'CODE');
          log('info', 'patient shared with a doctor');
          return json(200, { patientId: it.owner, label: it.label, expiresAt: until, meds });
        }

        if (route === 'GET /v1/doctor/patients') {
          const links = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': doctorKey, ':s': 'PT#' } }, 200);
          const t = now();
          const from = localDay(t - 13 * DAY_MS, DEFAULT_TZ_MIN), to = localDay(t, DEFAULT_TZ_MIN);
          const patients = [];
          for (const l of links as (Link & Record<string, unknown>)[]) {
            const pid = String(l.sk).slice(3);
            if (runOut(l)) { await dropLink(pid); continue; }
            const [devices, days, events] = await Promise.all([
              queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :d)', ExpressionAttributeValues: { ':p': K.user(pid), ':d': 'D#' } }),
              queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(pid), ':a': K.day(from), ':b': K.day(to) } }),
              queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(pid), ':a': `E#${p13(t - 7 * DAY_MS)}`, ':b': `E#${p13(t)}~` } }),
            ]);
            const falls = events.filter((x) => x.type === 'fall' && ['confirmed', 'no-response'].includes(String((x.fall as { outcome?: string } | undefined)?.outcome)));
            const unseen = falls.filter((x) => Number(x.ts) > (l.reviewedAt ?? 0));
            patients.push({
              id: pid, label: l.label, since: l.since, expiresAt: l.expiresAt ?? null, reviewedAt: l.reviewedAt ?? null,
              devices: devices.map((x) => ({ thing: x.thing, online: x.online, lastSeen: x.lastSeen, fw: x.fw })),
              days: days.map(compactDay),
              falls7: falls.length, unreviewedFalls: unseen.length, lastFallTs: unseen.length ? Math.max(...unseen.map((x) => Number(x.ts))) : null,
            });
          }
          return json(200, { patients });
        }

        if (route === 'GET /v1/doctor/patient') {
          const pid = qp(q.id);
          if (!IDENTITY_RE.test(pid)) return json(400, { error: 'id missing or malformed' });
          const link = await linked(pid);
          if (!link) return json(404, { error: 'This patient has not shared with you (or stopped sharing).' });
          const span = Math.min(90, Math.max(7, Number(q.days) || 30));
          const t = now();
          const from = t - span * DAY_MS;
          const range = (a: string, b: string) => ({ TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(pid), ':a': a, ':b': b } });
          const prefix = (pk: string, s2: string) => ({ TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': pk, ':s': s2 } });
          const [devices, days, events, episodes, vitals, notes, meds, doses] = await Promise.all([
            queryAll(d, prefix(K.user(pid), 'D#')),
            queryAll(d, range(K.day(localDay(from, DEFAULT_TZ_MIN)), K.day(localDay(t, DEFAULT_TZ_MIN)))),
            queryAll(d, range(`E#${p13(from)}`, `E#${p13(t)}~`)),
            queryAll(d, range(`EP#${p13(from)}`, `EP#${p13(t)}~`)),
            queryAll(d, range(`RV#${p13(from)}`, `RV#${p13(t)}~`)),
            queryAll(d, prefix(doctorKey, `NOTE#${pid}#`), 500),
            link.meds ? queryAll(d, prefix(K.user(pid), 'MD#'), 200) : Promise.resolve([]),          // medications only when the patient ticked the box with this code
            link.meds ? queryAll(d, prefix(K.user(pid), 'DS#'), 3000) : Promise.resolve([]),
          ]);
          // the patient can see when a doctor last looked (best effort: a revoked link is not recreated)
          await d.db.send(new UpdateCommand({ TableName: d.table, Key: { pk: K.user(pid), sk: `ACC#${sub}` }, UpdateExpression: 'SET lastViewed = :v', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':v': t } })).catch(() => {});
          return json(200, {
            id: pid, label: link.label, since: link.since, expiresAt: link.expiresAt ?? null, reviewedAt: link.reviewedAt ?? null, medsShared: link.meds === true,
            devices: devices.map(strip),
            days: days.map((x) => Object.fromEntries(Object.entries(strip(x)).filter(([k]) => !/^h\d\d_/.test(k)))),
            events: events.map(strip).sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, 300),
            episodes: episodes.map(strip).filter((x) => !x.demo).sort((a, b) => Number(b.start) - Number(a.start)).slice(0, 300),
            vitals: vitals.map(strip).filter((x) => !x.demo).sort((a, b) => Number(b.t) - Number(a.t)).slice(0, 300),
            notes: notes.map((x) => ({ ts: x.ts, text: x.text })).sort((a, b) => Number(b.ts) - Number(a.ts)),
            meds: meds.map(strip).filter((x) => !x.demo),
            doses: doses.map(strip).filter((x) => !x.demo && Number(x.loggedAt) >= from).sort((a, b) => Number(b.loggedAt) - Number(a.loggedAt)).slice(0, 1000),
          });
        }

        if (route === 'POST /v1/doctor/notes') {
          const body = readBody();
          const pid = String(body?.id ?? '');
          const text = typeof body?.text === 'string' ? body.text.trim() : '';
          if (!body || !IDENTITY_RE.test(pid) || !text || text.length > NOTE_MAX) return json(400, { error: `A note needs a patient id and 1 to ${NOTE_MAX} characters.` });
          if (!(await linked(pid))) return json(404, { error: 'This patient has not shared with you (or stopped sharing).' });
          const ts = now();
          await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: doctorKey, sk: `NOTE#${pid}#${p13(ts)}`, pid, ts, text } }));
          return json(200, { ts });
        }

        if (route === 'DELETE /v1/doctor/notes') {
          const pid = qp(q.id), ts = Number(q.ts);
          if (!IDENTITY_RE.test(pid) || !(ts > 0)) return json(400, { error: 'id and ts required' });
          await del(doctorKey, `NOTE#${pid}#${p13(ts)}`);
          return json(200, { removed: true });
        }

        if (route === 'POST /v1/doctor/review') {
          const pid = String(readBody()?.id ?? '');
          if (!IDENTITY_RE.test(pid)) return json(400, { error: 'id missing or malformed' });
          if (!(await linked(pid))) return json(404, { error: 'This patient has not shared with you (or stopped sharing).' });
          const reviewedAt = now();
          await d.db.send(new UpdateCommand({ TableName: d.table, Key: { pk: doctorKey, sk: `PT#${pid}` }, UpdateExpression: 'SET reviewedAt = :v', ExpressionAttributeValues: { ':v': reviewedAt } }));
          return json(200, { reviewedAt });
        }

        if (route === 'DELETE /v1/doctor/patients') {
          const pid = qp(q.id);
          if (!IDENTITY_RE.test(pid)) return json(400, { error: 'id missing or malformed' });
          await dropLink(pid);
          return json(200, { removed: true });
        }
        return json(404, { error: 'not found' });
      }

      const id = await owner(sub);
      if (!id) return json(409, { error: 'not linked: call POST /v1/me/link first' });

      if (route === 'POST /v1/share') {
        let body: { name?: unknown; days?: unknown; meds?: unknown } = {};
        try { body = JSON.parse(e.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
        const days = body.days === undefined ? 90 : Number(body.days);
        if (!SHARE_DAYS.includes(days)) return json(400, { error: `days must be one of ${SHARE_DAYS.join(', ')} (0 = until you stop it)` });
        const meds = body.meds === true;
        const code = (d.newCode ?? defaultCode)();
        const expiresAt = now() + CODE_TTL_MS;
        await d.db.send(new PutCommand({ TableName: d.table, Item: { pk: K.share(code), sk: 'CODE', owner: id, label: name || c.email || 'Patient', meds, durationDays: days || null, expiresAt, ttl: Math.floor((expiresAt + CODE_TTL_MS) / 1000) } }));
        return json(200, { code, expiresAt, days, meds });
      }

      if (route === 'GET /v1/share') {
        const all = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': K.user(id), ':s': 'ACC#' } });
        const live = [];
        for (const x of all) {
          if (typeof x.expiresAt === 'number' && x.expiresAt < now()) { await del(K.user(id), String(x.sk)); await del(K.doctor(String(x.sk).slice(4)), `PT#${id}`); }
          else live.push(strip(x));
        }
        return json(200, { doctors: live });
      }

      if (route === 'DELETE /v1/share') {
        const doctor = qp(q.doctor);
        if (!SUB_RE.test(doctor)) return json(400, { error: 'doctor missing or malformed' });
        await del(K.user(id), `ACC#${doctor}`);
        await del(K.doctor(doctor), `PT#${id}`);
        return json(200, { removed: true });
      }

      if (route === 'GET /v1/days') {
        const from = q.from ?? '', to = q.to ?? '';
        if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) return json(400, { error: 'from/to must be YYYY-MM-DD, at most 400 days apart' });
        const items = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(id), ':a': K.day(from), ':b': K.day(to) } });
        return json(200, { days: items.map((x) => Object.fromEntries(Object.entries(strip(x)).filter(([k]) => !/^h\d\d_/.test(k)))) });
      }

      if (route === 'GET /v1/events') {
        const from = Number(q.from), to = Number(q.to);
        if (!(from > 0) || !(to >= from) || to - from > 120 * 86_400_000) return json(400, { error: 'from/to must be ms, at most 120 days apart' });
        const items = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(id), ':a': `E#${String(from).padStart(13, '0')}`, ':b': `E#${String(to).padStart(13, '0')}~` } });
        return json(200, { events: items.map(strip) });
      }

      if (route === 'GET /v1/telemetry') {
        const thing = q.thing ?? '', from = Number(q.from), to = Number(q.to);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(thing) || !(from > 0) || !(to >= from) || to - from > 6 * 3_600_000) return json(400, { error: 'thing, from, to (ms, at most 6 h) required' });
        const items = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ExpressionAttributeValues: { ':p': K.user(id), ':a': K.tel(thing, from), ':b': K.tel(thing, to) } });
        return json(200, { telemetry: items.map(strip) });
      }

      if (route === 'PUT /v1/sync') {
        let body: Record<string, unknown[]>;
        try { body = JSON.parse(e.body ?? '{}'); } catch { return json(400, { error: 'invalid JSON' }); }
        const puts: Record<string, unknown>[] = [];
        for (const kind of Object.keys(body)) {
          if (!(kind in SYNC_KINDS)) return json(400, { error: `unknown kind ${kind}` });
          const recs = body[kind];
          if (!Array.isArray(recs)) return json(400, { error: `${kind} must be an array` });
          for (const r of recs) {
            const rec = r as Record<string, unknown>;
            if (typeof rec?.id !== 'string' || rec.id.length > 100) return json(400, { error: `${kind}: every record needs a string id` });
            if (JSON.stringify(rec).length > MAX_ITEM_BYTES) return json(400, { error: `${kind}: record ${rec.id} too large` });
            const sk = (SYNC_KINDS[kind as SyncKind] as (x: never) => string)(rec as never);
            if (sk.includes('NaN')) return json(400, { error: `${kind}: record ${rec.id} lacks its time field` });
            const { pk: _p, sk: _s, ...clean } = rec;
            puts.push({ ...clean, pk: K.user(id), sk, kind, syncedAt: Date.now() });
          }
        }
        if (puts.length > MAX_SYNC_ITEMS) return json(413, { error: `at most ${MAX_SYNC_ITEMS} records per request` });
        for (let i = 0; i < puts.length; i += 25) await batchWrite(d, puts.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })));
        return json(200, { stored: puts.length });
      }

      if (route === 'GET /v1/sync') {
        const kind = q.kind as SyncKind;
        if (!(kind in SYNC_PREFIX)) return json(400, { error: 'kind required' });
        const since = Number(q.since ?? 0);
        const items = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :k)', ExpressionAttributeValues: { ':p': K.user(id), ':k': SYNC_PREFIX[kind] } });
        return json(200, { [kind]: items.filter((x) => ((x.syncedAt as number) ?? 0) >= since).map(strip) });
      }

      if (route === 'DELETE /v1/me') {
        const all = await queryAll(d, { TableName: d.table, KeyConditionExpression: 'pk = :p', ProjectionExpression: 'pk, sk', ExpressionAttributeValues: { ':p': K.user(id) } }, Infinity);
        for (const x of all) if (String(x.sk).startsWith('ACC#')) await del(K.doctor(String(x.sk).slice(4)), `PT#${id}`);     // doctors lose access too
        for (let i = 0; i < all.length; i += 25) await batchWrite(d, all.slice(i, i + 25).map((x) => ({ DeleteRequest: { Key: { pk: x.pk, sk: x.sk } } })));
        await d.detachIot(id).catch((err) => log('warn', 'detach failed', { err: String(err) }));
        await d.db.send(new DeleteCommand({ TableName: d.table, Key: { pk: K.profile(sub), sk: 'PROFILE' } }));
        if (q.account === 'true') await d.deleteAccount(c['cognito:username'] ?? c.username ?? sub);
        log('info', 'user data deleted', { items: all.length, account: q.account === 'true' });
        return json(200, { deleted: all.length, account: q.account === 'true', note: 'Registered devices (IoT things and certificates) are removed with tools/aws/deprovision-device.mjs.' });
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      log('error', 'api error', { route, err: String(err) });
      return json(500, { error: 'internal error' });
    }
  };
}

async function batchWrite(d: Deps, requests: Record<string, unknown>[]) {
  let pending = requests;
  for (let attempt = 0; pending.length && attempt < 8; attempt++) {
    const r = await d.db.send(new BatchWriteCommand({ RequestItems: { [d.table]: pending as never } }));
    pending = (r.UnprocessedItems?.[d.table] ?? []) as Record<string, unknown>[];
    if (pending.length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));   // throttled: back off (small provisioned capacity)
  }
  if (pending.length) throw new Error(`${pending.length} writes not processed after retries`);
}

const region = process.env.AWS_REGION ?? 'ap-south-1';
const ci = new CognitoIdentityClient({ region });
const iot = new IoTClient({ region });
const idp = new CognitoIdentityProviderClient({ region });
export const handler = makeHandler({
  db: ddb(), table: TABLE,
  identityFor: async (idToken) => {
    const r = await ci.send(new GetIdCommand({ IdentityPoolId: process.env.IDENTITY_POOL_ID, Logins: { [process.env.USER_POOL_PROVIDER!]: idToken } }));
    return r.IdentityId!;
  },
  attachIot: async (target) => { await iot.send(new AttachPolicyCommand({ policyName: process.env.USER_IOT_POLICY, target })); },
  detachIot: async (target) => { await iot.send(new DetachPolicyCommand({ policyName: process.env.USER_IOT_POLICY, target })); },
  deleteAccount: async (Username) => { await idp.send(new AdminDeleteUserCommand({ UserPoolId: process.env.USER_POOL_ID, Username })); },
});
