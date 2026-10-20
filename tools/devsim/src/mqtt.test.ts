// The simulator's cloud mode against a local MQTT broker (aedes): status + last will, telemetry rate,
// viewer switch to 1 Hz, events, fall answer. TLS and IoT Core policies are covered by the real-deployment
// test (tools/aws/cloud-e2e.mjs); this checks the client behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { startMqtt } from './mqtt.ts';
import { DEFAULT_CONTROLS } from '../../../app/src/logic/demoGen.ts';
import { validateTelemetry, validateEvent } from '../../../app/src/logic/protocol.ts';

test('cloud mode publishes status, telemetry and events, and speeds up while watched', async () => {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const owner = 'ap-south-1:11111111-2222-3333-4444-555555555555', thing = 'htm-test';
  const pre = `tremor/v1/${owner}/${thing}/`;
  const seen: { topic: string; at: number; msg: any; retain: boolean }[] = [];
  const watcher = mqtt.connect(`mqtt://localhost:${port}`);
  await new Promise<void>((r) => watcher.on('connect', () => watcher.subscribe(pre + '#', () => r())));
  watcher.on('message', (topic, p, pkt) => seen.push({ topic, at: Date.now(), msg: JSON.parse(p.toString()), retain: pkt.retain }));

  // a tremor from 1 s, a fall at 9 s answered "cancelled" after 6 s
  const script = (t: number) => ({ label: '', step: 0, controls: { ...DEFAULT_CONTROLS, tremorAxes: t > 1 && t < 6 ? [2 as const] : [], fall: t > 9 } });
  const sim = startMqtt({ endpoint: '', thing, owner, cert: '', key: '', ca: '', url: `mqtt://localhost:${port}` }, { fallAnswer: 'cancelled', minutes: 0, log: () => {}, exitOnStop: false, script });
  await new Promise((r) => setTimeout(r, 12_000));
  watcher.publish(pre + 'viewer', JSON.stringify({ v: 1, watching: true, until: Date.now() + 60_000 }), { retain: true });
  await new Promise((r) => setTimeout(r, 6_000));
  sim.stop();
  await new Promise((r) => setTimeout(r, 500));

  const status = seen.filter((s) => s.topic === pre + 'status');
  assert.equal(status[0].msg.online, true);
  assert.equal(status.at(-1)!.msg.online, false);
  const tel = seen.filter((s) => s.topic === pre + 'telemetry');
  for (const m of tel) assert.ok(validateTelemetry(m.msg).ok);
  const slow = tel.filter((m) => m.msg.per === 5).length, fast = tel.filter((m) => m.msg.per === 1).length;
  assert.ok(slow >= 1 && slow <= 3, `5 s telemetry before watching: ${slow}`);
  assert.ok(fast >= 4, `1 s telemetry while watched: ${fast}`);
  const ev = seen.filter((s) => s.topic === pre + 'event').map((s) => s.msg);
  for (const e of ev) assert.ok(validateEvent(e).ok);
  const types = ev.map((e) => e.type + (e.fall ? ':' + e.fall.outcome : ''));
  assert.ok(types.includes('tremor_start'), types.join());
  assert.ok(types.includes('episode'), types.join());
  assert.ok(types.includes('fall:pending') && types.includes('fall:cancelled'), types.join());
  watcher.end(); sim.client.end(true); server.close(); broker.close();
});
