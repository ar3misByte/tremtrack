// HTTP API (API Gateway v2, Cognito JWT authorizer). Every route is scoped to the signed-in user.
//   GET    /v1/me                  profile: linked identity id, devices
//   POST   /v1/me/link             link the caller's Cognito identity (verified) and allow it to read its MQTT topics
//   GET    /v1/days?from=&to=      daily aggregates (YYYY-MM-DD, max 400 days)
//   GET    /v1/events?from=&to=    device events (ms, max 120 days)
//   GET    /v1/telemetry?thing=&from=&to=   raw 0.2-1 Hz telemetry (ms, max 6 h; kept 14 days)
//   PUT    /v1/sync                upsert app records {episodes, sessions, tags, meds, doses, vitals, falls}
//   GET    /v1/sync?kind=&since=   read synced records back (other devices / reinstall)
//   DELETE /v1/me[?account=true]   delete all of the user's cloud data (and optionally the account)
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { IoTClient, AttachPolicyCommand, DetachPolicyCommand } from '@aws-sdk/client-iot';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { K, SYNC_KINDS, SYNC_PREFIX, TABLE, ddb, json, log, type SyncKind } from './shared.ts';

export interface Deps {
  db: DynamoDBDocumentClient;
  table: string;
  /** Resolves the identity id that belongs to the caller's ID token (Cognito GetId). */
  identityFor: (idToken: string) => Promise<string>;
  attachIot: (identityId: string) => Promise<void>;
  detachIot: (identityId: string) => Promise<void>;
  deleteAccount: (username: string) => Promise<void>;
}

const MAX_SYNC_ITEMS = 500;
const MAX_ITEM_BYTES = 8_000;
const IDENTITY_RE = /^[a-z]{2}-[a-z]+-\d:[0-9a-f-]{36}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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

const strip = (x: Record<string, unknown>) => { const { pk: _p, sk: _s, ttl: _t, ...rest } = x; return rest; };

export function makeHandler(d: Deps) {
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

      const id = await owner(sub);
      if (!id) return json(409, { error: 'not linked: call POST /v1/me/link first' });

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
