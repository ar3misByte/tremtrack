// Device simulator, cloud mode: behaves like the milestone-7 firmware towards AWS IoT Core.
//   npm run sim -- --mqtt tools/aws/out/htm-01/devsim.json [--fall-answer cancelled|confirmed|no-response] [--minutes 10]
// Uses the certificate written by tools/aws/provision-device.mjs. Publishes:
//   status    (retained, QoS 1) online on connect; last will = offline
//   telemetry (QoS 0) every 5 s, every 1 s while someone watches (viewer topic)
//   event     (QoS 1) tremor start, episodes, fall candidate + the wearer's answer
// Subscribes: cmd (sensitivity, rate), viewer.
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { DemoGenerator, scriptAt } from '../../../app/src/logic/demoGen.ts';
import { parseLine } from '../../../app/src/logic/csv.ts';
import { CloudSummarizer, type CloudMessage } from '../../../app/src/logic/cloudSummary.ts';
import { topic, validateEvent, validateTelemetry, type Viewer, type Command, type DeviceEvent } from '../../../app/src/logic/protocol.ts';

export interface MqttConfig { endpoint: string; thing: string; owner: string; cert: string; key: string; ca: string; /** tests only: plain mqtt:// URL of a local broker */ url?: string }

export function startMqtt(cfgPath: string | MqttConfig, opt: { fallAnswer: 'cancelled' | 'confirmed' | 'no-response'; minutes: number; log: (m: string) => void; exitOnStop?: boolean; script?: (t: number) => ReturnType<typeof scriptAt> }) {
  const cfg = typeof cfgPath === 'string' ? (JSON.parse(readFileSync(cfgPath, 'utf8')) as MqttConfig) : cfgPath;
  const t = (k: Parameters<typeof topic>[2]) => topic(cfg.owner, cfg.thing, k);
  const statusOffline = JSON.stringify({ v: 1, online: false });
  const tls = cfg.url ? {} : { key: readFileSync(cfg.key), cert: readFileSync(cfg.cert), ca: readFileSync(cfg.ca) };
  const client = mqtt.connect(cfg.url ?? `mqtts://${cfg.endpoint}:8883`, {
    clientId: cfg.thing, ...tls,
    protocolVersion: 4, keepalive: 60, clean: true, reconnectPeriod: 2000, connectTimeout: 15000,
    will: { topic: t('status'), payload: Buffer.from(statusOffline), qos: 1, retain: true },
  });
  let backoff = 2000;
  let sent = 0, events = 0, dropped = 0;
  const gen = new DemoGenerator();
  const t0 = Date.now();
  const sum = new CloudSummarizer(t0, 5);
  let viewerUntil = 0;

  const pub = (m: CloudMessage) => {
    const ok = m.kind === 'telemetry' ? validateTelemetry(m.msg).ok : validateEvent(m.msg).ok;
    if (!ok) { dropped++; opt.log(`invalid ${m.kind} not sent`); return; }
    if (!client.connected) { dropped++; return; }              // a real device buffers a few; the simulator just counts
    client.publish(t(m.kind), JSON.stringify(m.msg), { qos: m.kind === 'event' ? 1 : 0 });
    if (m.kind === 'event') { events++; opt.log(`event ${(m.msg as { type: string }).type}`); } else sent++;
  };

  client.on('connect', () => {
    backoff = 2000;
    opt.log(`connected to ${cfg.endpoint} as ${cfg.thing}`);
    client.publish(t('status'), JSON.stringify({ v: 1, online: true, ts: Date.now(), fw: 'devsim', tzMin: -new Date().getTimezoneOffset(), rate: 0.2 }), { qos: 1, retain: true });
    client.subscribe([t('cmd'), t('viewer')], { qos: 1 }, (err) => { if (err) opt.log('subscribe failed: ' + err.message); });
  });
  client.on('message', (tp, payload) => {
    try {
      const m = JSON.parse(payload.toString());
      if (tp.endsWith('/viewer')) { const v = m as Viewer; viewerUntil = v.watching ? v.until : 0; opt.log(`viewer ${v.watching ? 'watching' : 'gone'}: telemetry every ${v.watching ? 1 : 5} s`); }
      if (tp.endsWith('/cmd')) { const c = m as Command; opt.log(`command ${JSON.stringify(c)}`); if (c.sens && c.sens >= 1 && c.sens <= 5) pub(sum.sensitivity(Date.now(), c.sens)); }
    } catch { opt.log('bad message on ' + tp); }
  });
  client.on('reconnect', () => { opt.log(`reconnecting (next try in ${Math.round(backoff / 1000)} s)`); backoff = Math.min(60_000, backoff * 2); client.options.reconnectPeriod = backoff; });
  client.on('error', (e) => opt.log('mqtt error: ' + e.message));
  client.on('offline', () => opt.log('offline'));

  const heartbeat = setInterval(() => { if (client.connected) client.publish(t('status'), JSON.stringify({ v: 1, online: true, ts: Date.now(), fw: 'devsim', tzMin: -new Date().getTimezoneOffset(), rate: viewerUntil > Date.now() ? 1 : 0.2 }), { qos: 1, retain: true }); }, 15 * 60_000);
  const tick = setInterval(() => {
    const now = Date.now();
    sum.setPeriod(viewerUntil > now ? 1 : 5);
    const s = (opt.script ?? scriptAt)((now - t0) / 1000);
    const p = parseLine(gen.next(now / 1000, s.controls));
    if (p?.kind !== 'frame') return;
    for (const m of sum.push(p.frame, now)) {
      pub(m);
      if (m.kind === 'event' && (m.msg as { type: string }).type === 'fall') {
        const fall = (m.msg as DeviceEvent & { type: 'fall' }).fall;
        if (fall.outcome === 'pending') setTimeout(() => pub(sum.fallOutcome(Date.now(), { ...fall, outcome: opt.fallAnswer })), opt.fallAnswer === 'cancelled' ? 6000 : 30_000);
      }
    }
  }, 20);
  const report = setInterval(() => opt.log(`telemetry ${sent}, events ${events}, not sent ${dropped}`), 60_000);
  const stop = () => {
    clearInterval(tick); clearInterval(heartbeat); clearInterval(report);
    for (const m of sum.close(Date.now())) pub(m);
    client.publish(t('status'), statusOffline, { qos: 1, retain: true }, () => client.end(false, () => { if (opt.exitOnStop !== false) process.exit(0); }));
  };
  if (opt.minutes > 0) setTimeout(stop, opt.minutes * 60_000);
  if (opt.exitOnStop !== false) process.on('SIGINT', stop);
  return { stop, client, stats: () => ({ sent, events, dropped }) };
}
