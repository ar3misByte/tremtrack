#!/usr/bin/env node
// Removes a headset from AWS: clears its retained MQTT messages, deletes its registry and status rows in
// DynamoDB, detaches and deletes its certificates, and deletes the thing. Its telemetry and events stay with
// the user (deleted by DELETE /v1/me; telemetry also expires after 14 days).
//   node tools/aws/deprovision-device.mjs --thing htm-01 [--profile p] [--region ap-south-1] [--delete-local]
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { args, aws, ok, opts, outDir, stackOutputs } from './lib.mjs';

const a = args();
const o = opts(a);
if (!a.thing) { console.error('--thing NAME required'); process.exit(2); }
const out = stackOutputs(o);
const firstLine = (e) => e.message.split(/\r?\n/)[0].slice(0, 160);

let found = false, owner = null;
try { owner = aws(['iot', 'describe-thing', '--thing-name', a.thing], o).attributes?.owner ?? null; found = true; }
catch (e) { console.error(`  (thing not found: ${firstLine(e)})`); }

if (owner) {
  // An empty retained message deletes the retained one.
  try {
    const endpoint = aws(['iot', 'describe-endpoint', '--endpoint-type', 'iot:Data-ATS'], o).endpointAddress;
    for (const k of ['status', 'viewer']) aws(['iot-data', 'publish', '--endpoint-url', `https://${endpoint}`, '--topic', `tremor/v1/${owner}/${a.thing}/${k}`, '--retain', '--qos', '1'], o);
    ok('retained status and viewer messages cleared');
  } catch (e) { console.error(`  (could not clear retained messages: ${firstLine(e)})`); }
}
if (out.TableName) {
  const del = (pk, sk) => aws(['dynamodb', 'delete-item', '--table-name', out.TableName, '--key', JSON.stringify({ pk: { S: pk }, sk: { S: sk } })], o);
  del('DEVICES', a.thing);
  if (owner) del(`U#${owner}`, `D#${a.thing}`);
  ok('registry and status rows deleted');
}
if (found) {
  const principals = aws(['iot', 'list-thing-principals', '--thing-name', a.thing], o).principals ?? [];
  for (const p of principals) {
    const id = p.split('/').pop();
    aws(['iot', 'detach-thing-principal', '--thing-name', a.thing, '--principal', p], o);
    if (out.DevicePolicyName) { try { aws(['iot', 'detach-policy', '--policy-name', out.DevicePolicyName, '--target', p], o); } catch { /* not attached */ } }
    aws(['iot', 'update-certificate', '--certificate-id', id, '--new-status', 'INACTIVE'], o);
    aws(['iot', 'delete-certificate', '--certificate-id', id, '--force-delete'], o);
    ok(`certificate ${id.slice(0, 12)}... deleted`);
  }
  aws(['iot', 'delete-thing', '--thing-name', a.thing], o);
  ok(`thing ${a.thing} deleted`);
}
if (a['delete-local'] === 'true') { rmSync(join(outDir, a.thing), { recursive: true, force: true }); ok('local key files deleted'); }
