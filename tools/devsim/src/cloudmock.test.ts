// The app's real cloud code (sign-in, identity, API client, live source, sync) against the local mock backend,
// with the simulated headset publishing over MQTT. What AWS itself would verify (signatures, IoT policies) is not covered.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startCloudMock, type MockCloud } from './cloudmock.ts';
import { startMqtt } from './mqtt.ts';
import { Auth, type KV } from '../../../app/src/cloud/auth.ts';
import { Api, getCredentials, getIdentityId } from '../../../app/src/cloud/aws.ts';
import { validateConfig, type CloudConfig } from '../../../app/src/cloud/config.ts';
import { CloudSource } from '../../../app/src/cloud/liveSource.ts';
import { parseLine } from '../../../app/src/logic/csv.ts';
import { syncNow, type Records, type SyncIO } from '../../../app/src/cloud/sync.ts';

const mem = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const REDIRECT = 'http://localhost:5173/';
const until = async (cond: () => boolean, ms: number, what: string) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await new Promise((r) => setTimeout(r, 50)); } };

describe('app cloud code against the local mock backend', { timeout: 120_000 }, () => {
  let mock: MockCloud, cfg: CloudConfig, auth: Auth, api: Api, device: ReturnType<typeof startMqtt> | undefined;
  const deviceLog: string[] = [];

  before(async () => {
    mock = await startCloudMock({ port: 0, mqttPort: 0, tcpPort: 0 });
    const v = validateConfig({ ...mock.config, apiUrl: `http://localhost:${mock.ports.http}`, authBase: `http://localhost:${mock.ports.http}`, identityBase: `http://localhost:${mock.ports.http}`, mqttUrl: `ws://localhost:${mock.ports.mqttWs}/mqtt` });
    assert.ok(v.ok, v.ok ? '' : v.error);
    cfg = v.config;
    auth = new Auth(cfg, { redirectUri: REDIRECT, storage: mem(), session: mem() });
    api = new Api(cfg, () => auth.idToken());
  });
  after(async () => {
    if (device) await new Promise<void>((r) => { device!.client.once('close', () => r()); device!.stop(); });
    await mock.close();
  });

  it('signs in through the hosted page with PKCE', async () => {
    assert.equal(auth.isSignedIn(), false);
    const r = await fetch(await auth.loginUrl(), { redirect: 'manual' });
    assert.equal(r.status, 302);
    const back = r.headers.get('location')!;
    assert.ok(back.startsWith(REDIRECT + '?code='));
    assert.deepEqual(await auth.completeLogin(back), { ok: true });
    assert.equal(auth.isSignedIn(), true);
    assert.equal(auth.claims()?.email, 'demo@example.com');
    // a stolen code does not work without the verifier
    const again = await fetch(await auth.loginUrl(), { redirect: 'manual' });
    const code = new URL(again.headers.get('location')!).searchParams.get('code')!;
    const bad = await fetch(`${cfg.authBase}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, code, redirect_uri: REDIRECT, code_verifier: 'wrong' }).toString() });
    assert.equal(bad.status, 400);
  });

  it('gets its identity, links it, and is refused another one', async () => {
    const tok = (await auth.idToken())!;
    const me0 = await api.me();
    assert.equal(me0.identityId, null);
    const id = await getIdentityId(cfg, tok);
    assert.equal(id, mock.identityId);
    await assert.rejects(api.link('ap-south-1:00000000-0000-0000-0000-000000000000'), /does not belong/);
    await api.link(id);
    assert.equal((await api.me()).identityId, id);
    const c = await getCredentials(cfg, tok, id);
    assert.ok(c.creds.accessKeyId && c.creds.sessionToken && c.expiresAt > Date.now());
  });

  it('refuses API calls without a valid token', async () => {
    const r = await fetch(`${cfg.apiUrl}/v1/me`);
    assert.equal(r.status, 401);
    const stale = new Api(cfg, async () => 'a.b.c');
    await assert.rejects(stale.me(), /401|Unauthorized|expired|answered/);
  });

  it('shows a simulated headset live and keeps history', async () => {
    // the headset publishes over MQTT to the broker; the app watches through the WebSocket
    const dev = startMqtt({ endpoint: 'mock', thing: 'htm-mock', owner: mock.identityId, cert: '', key: '', ca: '', url: `mqtt://127.0.0.1:${mock.ports.tcp}` }, { fallAnswer: 'cancelled', minutes: 0, log: (m) => deviceLog.push(m), exitOnStop: false });
    device = dev;
    const lines: string[] = [], states: string[] = [], statuses: boolean[] = [];
    const src = new CloudSource(cfg, { identityId: async () => mock.identityId, credentials: async () => (await getCredentials(cfg, (await auth.idToken())!, mock.identityId)).creds }, 'htm-mock', { status: (_t, s) => statuses.push(s.online) });
    await src.start({ line: (l) => lines.push(l), state: (s) => states.push(s) });
    await until(() => lines.length >= 3, 20_000, 'three live summaries');
    assert.ok(states.includes('open'));
    for (const l of lines) { const p = parseLine(l); assert.equal(p?.kind, 'frame'); }
    assert.ok(statuses.includes(true), 'the retained "online" status reaches the viewer');
    assert.ok(deviceLog.some((l) => /viewer watching: telemetry every 1 s/.test(l)), 'the viewer flag makes the headset send every second');
    await src.send('4\n');
    await until(() => deviceLog.some((l) => /command .*"sens":4/.test(l)), 5000, 'the sensitivity command');
    await src.stop();
    await until(() => deviceLog.some((l) => /viewer gone/.test(l)), 5000, 'the viewer flag to clear');

    // stored by the IoT rules, readable through the API
    const me = await api.me();
    assert.ok(me.devices.some((d) => d.thing === 'htm-mock'), 'the device is registered');
    const tel = await api.telemetry('htm-mock', Date.now() - 600_000, Date.now() + 1000);
    assert.ok(tel.telemetry.length >= 3);
    assert.equal((await mock.runAggregator() as { hours: number }).hours >= 0, true);
  });

  it('syncs records through the real API code and a second device receives them', async () => {
    const mkIO = (data: Partial<Records>): { io: SyncIO; data: Records } => {
      const d: Records = { episodes: [], sessions: [], tags: [], meds: [], doses: [], vitals: [], falls: [], ...data };
      return { data: d, io: { readLocal: async () => structuredClone(d), importRemote: async (r) => { for (const [k, v] of Object.entries(r)) (d as unknown as Record<string, unknown[]>)[k].push(...(v as unknown[])); } } };
    };
    const a = mkIO({ tags: [{ id: 't-1', t: Date.now(), kind: 'coffee', label: null, demo: false }], episodes: [{ id: 'e-1', start: Date.now() - 5000, demo: false, durationS: 9, score: 2.2 } as never] });
    const r1 = await syncNow(api, a.io, { includeMeds: false, since: 0 });
    assert.deepEqual([r1.uploaded.tags, r1.uploaded.episodes], [1, 1]);
    const b = mkIO({});
    const r2 = await syncNow(api, b.io, { includeMeds: false, since: 0 });
    assert.deepEqual([r2.downloaded.tags, r2.downloaded.episodes], [1, 1]);
    assert.equal(b.data.tags[0].id, 't-1');
  });

  it('deletes all the user\'s cloud data on request', async () => {
    const r = await api.deleteMe(false);
    assert.ok(r.deleted > 0);
    const me = await api.me();
    assert.equal(me.identityId, null, 'the link to the cloud identity is removed too');
    assert.deepEqual(me.devices, []);
    await assert.rejects(api.syncGet('tags', 0), /not linked/);
  });
});
