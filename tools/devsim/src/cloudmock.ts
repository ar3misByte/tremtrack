// A local stand-in for the whole AWS backend, for developing and testing the app without a deployment:
//   - Cognito hosted login + token endpoint (authorization code + PKCE, refresh tokens), signed-in as one demo user
//   - Cognito identity (GetId / GetCredentialsForIdentity)
//   - the HTTP API, running the REAL Lambda code (infra/lambda/api.ts) on an in-memory table
//   - an MQTT broker (WebSocket for the browser, TCP for tools/devsim --mqtt) with the IoT rules applied to what
//     devices publish (telemetry / status -> table, events -> the real events Lambda, hourly aggregator)
// What it does not check: signatures (SigV4, JWT) and IoT policies; those are verified by unit tests and by AWS.
//
//   npx tsx tools/devsim/src/cloudmock.ts [--demo-history] [--port 8801] [--mqtt-port 8802] [--tcp-port 8803]
// prints the setup link for the app and writes tools/devsim/out/mock-device.json for `npm run sim -- --mqtt`.
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { makeHandler as makeApi } from '../../../infra/lambda/api.ts';
import { makeHandler as makeAggregate } from '../../../infra/lambda/aggregate.ts';
import { makeHandler as makeEvents } from '../../../infra/lambda/events.ts';
import { FakeDdb, rules } from '../../../infra/test/fakeDdb.ts';
import { encodeConfig } from '../../../app/src/cloud/config.ts';
import { parseTopic, validateEvent, validateStatus, validateTelemetry } from '../../../app/src/logic/protocol.ts';

export interface MockOptions { port?: number; mqttPort?: number; tcpPort?: number; demoHistory?: boolean; log?: (m: string) => void; email?: string }
export interface MockCloud {
  config: Record<string, string>;
  identityId: string;
  owner: string;
  db: FakeDdb;
  alerts: string[];
  runAggregator: () => Promise<unknown>;
  ports: { http: number; mqttWs: number; tcp: number };
  close: () => Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const SUB = 'mock-user-1';
export const identityFor = (sub: string) => { const h = createHash('sha256').update(sub).digest('hex'); return `ap-south-1:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const jwt = (claims: Record<string, unknown>) => `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.mock`;
const decode = (t: string) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return null; } };

export async function startCloudMock(o: MockOptions = {}): Promise<MockCloud> {
  const log = o.log ?? (() => {});
  const email = o.email ?? 'demo@example.com';
  const db = new FakeDdb();
  const alerts: string[] = [];
  const identityId = identityFor(SUB);
  const put = (Item: Record<string, unknown>) => db.send({ constructor: { name: 'PutCommand' }, input: { Item } } as never);

  // ---------- IoT Core stand-in: broker + rules ----------
  const broker = await Aedes.createBroker();
  const events = makeEvents({ db: db as never, table: 't', now: () => Date.now(), publish: async (subject) => { alerts.push(subject); log(`ALERT email would be sent: ${subject}`); } });
  broker.on('publish', (packet, client) => {
    if (!client || !packet.topic.startsWith('tremor/v1/')) return;
    const tp = parseTopic(packet.topic);
    if (!tp) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(packet.payload.toString()); } catch { return; }
    void (async () => {
      if (tp.kind === 'telemetry') { const item = validateTelemetry(msg).ok ? rules.telemetry(packet.topic, msg, Date.now()) : null; if (item) await put(item); }
      else if (tp.kind === 'status') { const items = validateStatus(msg).ok ? rules.status(packet.topic, msg, Date.now()) : null; for (const i of items ?? []) await put(i); }
      else if (tp.kind === 'event') { const ev = validateEvent(msg).ok ? rules.event(packet.topic, msg) : null; if (ev) await events(ev as never); }
    })().catch((e) => log('rule error: ' + (e as Error).message));
  });

  const tcp = createTcp(broker.handle);
  const httpWs = createHttp();
  const wss = new WebSocketServer({ server: httpWs, path: '/mqtt' });
  wss.on('connection', (ws, req) => broker.handle(createWebSocketStream(ws), req));
  // The broker's WebSocket lives on its own port; a second HTTP server below serves the auth + API endpoints.
  await new Promise<void>((r) => tcp.listen(o.tcpPort ?? 8803, '127.0.0.1', r));
  await new Promise<void>((r) => httpWs.listen(o.mqttPort ?? 8802, '127.0.0.1', r));

  // ---------- Lambdas ----------
  const api = makeApi({
    db: db as never, table: 't',
    identityFor: async (token) => identityFor(String(decode(token)?.sub ?? '')),
    attachIot: async (id) => log(`attached the browser IoT policy to ${id}`),
    detachIot: async () => {}, deleteAccount: async (u) => log(`deleted Cognito user ${u}`),
  });
  const aggregate = makeAggregate({ db: db as never, table: 't', now: () => Date.now(), publish: async (s) => { alerts.push(s); } });
  const runAggregator = () => aggregate({ includeCurrentHour: true });
  const aggTimer = setInterval(() => { void runAggregator().catch(() => {}); }, 20_000);

  // ---------- Cognito + API over HTTP ----------
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const body = (req: IncomingMessage) => new Promise<string>((res) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => res(s)); });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-amz-target,x-amz-user-agent', 'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS' };
  const send = (res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
  const tokens = () => {
    const now = Math.floor(Date.now() / 1000);
    return { id_token: jwt({ sub: SUB, email, 'cognito:username': SUB, iat: now, exp: now + 3600, aud: 'mock' }), access_token: jwt({ sub: SUB, iat: now, exp: now + 3600 }), expires_in: 3600, token_type: 'Bearer' };
  };

  const server = createHttp(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-max-age': '600' }); res.end(); return; }
    try {
      if (url.pathname === '/oauth2/authorize') {                       // "the user signs in": approve at once
        const redirect = url.searchParams.get('redirect_uri') ?? '', state = url.searchParams.get('state') ?? '';
        if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) { res.writeHead(400); res.end('PKCE required'); return; }
        const code = randomBytes(12).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
        res.writeHead(302, { location: `${redirect}${redirect.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state)}` }); res.end(); return;
      }
      if (url.pathname === '/oauth2/token' && req.method === 'POST') {
        const f = new URLSearchParams(await body(req));
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '');
          codes.delete(f.get('code') ?? '');
          const ok = c && c.redirect === f.get('redirect_uri') && b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === c.challenge;
          if (!ok) return send(res, 400, { error: 'invalid_grant' });
          return send(res, 200, { ...tokens(), refresh_token: 'mock-refresh' });
        }
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'mock-refresh') return send(res, 200, tokens());
        return send(res, 400, { error: 'invalid_grant' });
      }
      if (req.method === 'POST' && req.headers['x-amz-target']) {
        const target = String(req.headers['x-amz-target']).split('.')[1];
        const j = JSON.parse((await body(req)) || '{}') as { Logins?: Record<string, string> };
        const idToken = Object.values(j.Logins ?? {})[0] ?? '';
        const claims = decode(idToken);
        if (!claims || Number(claims.exp) < Date.now() / 1000) return send(res, 400, { __type: 'NotAuthorizedException', message: 'Token expired' });
        if (target === 'GetId') return send(res, 200, { IdentityId: identityFor(String(claims.sub)) });
        if (target === 'GetCredentialsForIdentity') return send(res, 200, { IdentityId: identityFor(String(claims.sub)), Credentials: { AccessKeyId: 'MOCK-ACCESS-KEY-ID', SecretKey: 'mock-secret', SessionToken: 'mock-session-token', Expiration: Math.floor(Date.now() / 1000) + 3600 } });
        return send(res, 400, { __type: 'UnknownOperationException' });
      }
      if (url.pathname === '/_mock/aggregate' && req.method === 'POST') return send(res, 200, await runAggregator());
      if (url.pathname.startsWith('/v1/')) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const claims = decode(token);
        if (!claims || Number(claims.exp) < Date.now() / 1000) return send(res, 401, { message: 'Unauthorized' });
        const r = (await api({
          rawPath: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams), body: (await body(req)) || undefined,
          headers: { authorization: `Bearer ${token}` },
          requestContext: { http: { method: req.method }, authorizer: { jwt: { claims } } },
        } as never)) as { statusCode: number; body: string };
        return send(res, r.statusCode, r.body);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { log('mock error: ' + (e as Error).stack); send(res, 500, { error: String(e) }); }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 8801, '127.0.0.1', r));
  const ports = { http: (server.address() as { port: number }).port, mqttWs: (httpWs.address() as { port: number }).port, tcp: (tcp.address() as { port: number }).port };

  const config = {
    region: 'ap-south-1', userPoolId: 'ap-south-1_MockPool1', clientId: 'mockclientid1234567890abcd', identityPoolId: `ap-south-1:${identityId.split(':')[1]}`,
    domain: 'mock', iotEndpoint: 'mock', apiUrl: `http://localhost:${ports.http}`,
    authBase: `http://localhost:${ports.http}`, identityBase: `http://localhost:${ports.http}`, mqttUrl: `ws://localhost:${ports.mqttWs}/mqtt`,
  };

  if (o.demoHistory) await seedHistory(put, identityId);

  return {
    config, identityId, owner: identityId, db, alerts, runAggregator, ports,
    close: async () => { clearInterval(aggTimer); for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); httpWs.closeAllConnections(); await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => httpWs.close(r)), new Promise((r) => tcp.close(r)), new Promise<void>((r) => broker.close(() => r()))]); },
  };
}

/** Two weeks of plausible day summaries and a few events, so the dashboard has something to show at once. */
async function seedHistory(put: (i: Record<string, unknown>) => Promise<unknown>, owner: string) {
  const now = Date.now();
  const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let d = 14; d >= 1; d--) {
    const t = now - d * 86_400_000;
    const day = new Date(t + 330 * 60_000).toISOString().slice(0, 10);
    const monitoredS = 6 * 3600 + Math.round(rnd() * 3 * 3600);
    const episodes = Math.round(4 + rnd() * 20);
    const score = Math.round((1.2 + rnd() * 3.8 + (d % 7 === 3 ? 1.8 : 0)) * 10) / 10;
    await put({ pk: `U#${owner}`, sk: `DAY#${day}`, day, tzMin: 330, monitoredS, tremorS: episodes * 14, walkingS: 1200, stillS: 9000, restlessS: 600, score, episodes, combinedEpisodes: Math.round(episodes / 5), falls: d === 9 ? 1 : 0, maxEpisodeScore: Math.round((score + 1.2) * 10) / 10, restingBpm: 66 + Math.round(rnd() * 8), restingSpo2: 96 + Math.round(rnd() * 2), meanBpm: 74 });
  }
  const ev = (ts: number, extra: Record<string, unknown>) => put({ pk: `U#${owner}`, sk: `E#${String(ts).padStart(13, '0')}#htm-mock#${ts % 1000}`, v: 1, seq: ts % 1000, ts, thing: 'htm-mock', owner, ...extra });
  await ev(now - 9 * 86_400_000, { type: 'fall', fall: { t: now - 9 * 86_400_000, path: 'freefall+impact', peakG: 7.2, freeFallMs: 310, orientationChangeDeg: 70, outcome: 'cancelled' } });
  for (let i = 0; i < 6; i++) { const s = now - (i + 1) * 5 * 3600_000; await ev(s + 30_000, { type: 'episode', ep: { start: s, end: s + 30_000, durationS: 30, axes: [i % 3], pattern: 'single', ampDps: 5 + i, freqHz: 4.6, score: 2.5 + i * 0.4, bpm: 72 } }); }
}

// ---------------------------------------------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('cloudmock.ts')) {
  const a = process.argv.slice(2);
  const num = (k: string, d: number) => (a.includes(k) ? Number(a[a.indexOf(k) + 1]) : d);
  const m = await startCloudMock({ port: num('--port', 8801), mqttPort: num('--mqtt-port', 8802), tcpPort: num('--tcp-port', 8803), demoHistory: a.includes('--demo-history'), log: (s) => process.stderr.write(`[cloudmock] ${s}\n`) });
  const out = join(dirname(fileURLToPath(import.meta.url)), '../out');
  mkdirSync(out, { recursive: true });
  const device = { endpoint: 'mock', thing: 'htm-mock', owner: m.owner, cert: '', key: '', ca: '', url: `mqtt://127.0.0.1:${m.ports.tcp}` };
  writeFileSync(join(out, 'mock-device.json'), JSON.stringify(device, null, 2));
  const code = encodeConfig(m.config as never);
  process.stderr.write(`\nLocal mock cloud running.\n  API / sign-in:  http://localhost:${m.ports.http}\n  MQTT (browser): ws://localhost:${m.ports.mqttWs}/mqtt   (devices: mqtt://127.0.0.1:${m.ports.tcp})\n\nOpen the app's Cloud screen and paste this setup code:\n\n${code}\n\nStart a simulated headset:  npm run sim -- --mqtt tools/devsim/out/mock-device.json\n\n`);
  process.on('SIGINT', () => { void m.close().then(() => process.exit(0)); });
}
