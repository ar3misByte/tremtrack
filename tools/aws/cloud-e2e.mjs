#!/usr/bin/env node
// End-to-end test of the DEPLOYED cloud path (run by the owner with deployer credentials):
//   test user -> sign-in (admin flow) -> identity id -> link -> provision a test device -> simulator publishes
//   via MQTT/TLS for a few minutes -> IoT rules -> DynamoDB + events Lambda -> aggregator -> HTTP API checks
//   -> cleanup (user data, test user, device) unless --keep.
//
//   node tools/aws/cloud-e2e.mjs [--minutes 3] [--keep] [--profile p] [--region ap-south-1]
//   node tools/aws/cloud-e2e.mjs --create-user you@example.com   (only creates a user and prints its identity id)
//
// Cost: a few hundred IoT messages and API calls (well under one US cent).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { args, aws, ok, opts, root, stackOutputs } from './lib.mjs';

const a = args();
const o = opts(a);
const out = stackOutputs(o);
if (!out.ApiUrl) { console.error('Stack outputs not found. Deploy first (docs/AWS_SETUP.md step 3).'); process.exit(1); }
const email = a['create-user'] && a['create-user'] !== 'true' ? a['create-user'] : `e2e+${Date.now()}@example.invalid`;
const password = 'E2e-' + randomBytes(9).toString('base64url');
const thing = a.thing ?? 'htm-e2e';
const failures = [];
const check = (cond, msg) => { if (cond) ok(msg); else { failures.push(msg); console.log(`  ✗ ${msg}`); } };

async function api(method, path, token, body) {
  const r = await fetch(out.ApiUrl + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, ...json };
}

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${argv.join(' ')} exited ${c}`))));
  });
}

console.log(`Cloud e2e against ${out.ApiUrl} (${o.region})`);
// 1. user + tokens + identity
aws(['cognito-idp', 'admin-create-user', '--user-pool-id', out.UserPoolId, '--username', email, '--user-attributes', 'Name=email,Value=' + email, 'Name=email_verified,Value=true', '--message-action', 'SUPPRESS'], o);
aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', out.UserPoolId, '--username', email, '--password', password, '--permanent'], o);
const auth = aws(['cognito-idp', 'admin-initiate-auth', '--user-pool-id', out.UserPoolId, '--client-id', out.UserPoolClientId, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${email},PASSWORD=${password}`], o);
const idToken = auth.AuthenticationResult.IdToken;
const provider = `cognito-idp.${o.region}.amazonaws.com/${out.UserPoolId}`;
const identityId = aws(['cognito-identity', 'get-id', '--identity-pool-id', out.IdentityPoolId, '--logins', `${provider}=${idToken}`], o).IdentityId;
ok(`user ${email}, identity ${identityId}`);
if (a['create-user']) { console.log(`\nPassword (shown once): ${password}\nIdentity id (use as --owner when provisioning): ${identityId}`); process.exit(0); }

let cleanup = async () => {};
try {
  // 2. link (verifies the identity server-side and attaches the browser IoT policy)
  const link = await api('POST', '/v1/me/link', idToken, { identityId });
  check(link.status === 200 && link.identityId === identityId, 'POST /v1/me/link');
  check((await api('POST', '/v1/me/link', idToken, { identityId: 'ap-south-1:00000000-0000-0000-0000-000000000000' })).status === 403, 'linking someone else\'s identity is refused');
  check((await fetch(out.ApiUrl + '/v1/me')).status === 401, 'API without a token is refused');
  cleanup = async () => {
    if (a.keep === 'true') { console.log('  (--keep: leaving the test user, data and device in place)'); return; }
    const del = await api('DELETE', '/v1/me?account=true', idToken);
    check(del.status === 200, `DELETE /v1/me removed ${del.deleted} items and the test account`);
    await run('node', ['tools/aws/deprovision-device.mjs', '--thing', thing, '--region', o.region, ...(o.profile ? ['--profile', o.profile] : []), '--delete-local']);
  };

  // 3. device + simulator over MQTT/TLS
  await run('node', ['tools/aws/provision-device.mjs', '--thing', thing, '--owner', identityId, '--force', '--region', o.region, ...(o.profile ? ['--profile', o.profile] : [])]);
  const minutes = Number(a.minutes ?? 3);
  console.log(`Simulator publishing for ${minutes} min (the scripted showcase: tremors, walking, a fall left unanswered)...`);
  const t0 = Date.now();
  await run('npx', ['tsx', 'tools/devsim/src/devsim.ts', '--mqtt', `tools/aws/out/${thing}/devsim.json`, '--minutes', String(minutes), '--fall-answer', 'no-response']);
  await new Promise((r) => setTimeout(r, 5000));

  // 4. what arrived
  const me = await api('GET', '/v1/me', idToken);
  check(me.devices?.some((d) => d.thing === thing), `device registered (${me.devices?.map((d) => `${d.thing}: ${d.online ? 'online' : 'offline'}`).join(', ')})`);
  const tel = await api('GET', `/v1/telemetry?thing=${thing}&from=${t0}&to=${Date.now()}`, idToken);
  check((tel.telemetry?.length ?? 0) >= minutes * 10, `telemetry stored: ${tel.telemetry?.length} messages (expected about ${minutes * 12})`);
  const ev = await api('GET', `/v1/events?from=${t0}&to=${Date.now()}`, idToken);
  const types = (ev.events ?? []).map((e) => e.type + (e.fall ? ':' + e.fall.outcome : ''));
  check(types.includes('tremor_start') && types.includes('episode'), `events stored: ${types.join(', ')}`);
  if (minutes >= 3) check(types.includes('fall:no-response'), 'unanswered fall stored (a caregiver email should have been sent if alertEmail was set and confirmed)');

  // 5. aggregator (including the hour in progress)
  const fns = aws(['cloudformation', 'describe-stack-resources', '--stack-name', 'TremorStack'], o).StackResources.filter((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId.startsWith('AggregateFn'));
  aws(['lambda', 'invoke', '--function-name', fns[0].PhysicalResourceId, '--cli-binary-format', 'raw-in-base64-out', '--payload', '{"includeCurrentHour":true}', process.platform === 'win32' ? 'NUL' : '/dev/null'], o);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const days = await api('GET', `/v1/days?from=${today}&to=${today}`, idToken);
  const d = days.days?.[0];
  check(d && d.monitoredS > 0, `daily aggregate: ${d ? `${Math.round(d.monitoredS)} s monitored, ${d.episodes} episodes, score ${d.score ?? 'not enough data (< 10 min)'}` : 'missing'}`);

  // 6. sync round trip
  const sync = await api('PUT', '/v1/sync', idToken, { tags: [{ id: 'e2e-tag', t: Date.now(), kind: 'coffee', label: null, demo: true }] });
  check(sync.stored === 1, 'PUT /v1/sync');
  const back = await api('GET', '/v1/sync?kind=tags', idToken);
  check(back.tags?.[0]?.id === 'e2e-tag', 'GET /v1/sync');

  // 7. doctor sharing: a throw-away doctor, consent by code, per-patient access, revoking
  const docEmail = `e2e-doctor+${Date.now()}@example.invalid`;
  aws(['cognito-idp', 'admin-create-user', '--user-pool-id', out.UserPoolId, '--username', docEmail, '--user-attributes', 'Name=email,Value=' + docEmail, 'Name=email_verified,Value=true', '--message-action', 'SUPPRESS'], o);
  const prevCleanup = cleanup;
  cleanup = async () => { await prevCleanup(); if (a.keep !== 'true') { try { aws(['cognito-idp', 'admin-delete-user', '--user-pool-id', out.UserPoolId, '--username', docEmail], o); ok('doctor test user deleted'); } catch { /* already gone */ } } };
  aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', out.UserPoolId, '--username', docEmail, '--password', password, '--permanent'], o);
  aws(['cognito-idp', 'admin-add-user-to-group', '--user-pool-id', out.UserPoolId, '--username', docEmail, '--group-name', 'doctors'], o);
  const docToken = aws(['cognito-idp', 'admin-initiate-auth', '--user-pool-id', out.UserPoolId, '--client-id', out.UserPoolClientId, '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${docEmail},PASSWORD=${password}`], o).AuthenticationResult.IdToken;
  check((await api('GET', '/v1/doctor/patients', idToken)).status === 403, 'a patient account cannot use the doctor routes');
  check((await api('GET', `/v1/doctor/patient?id=${encodeURIComponent(identityId)}`, docToken)).status === 404, 'a doctor sees nothing before the patient shares');
  const share = await api('POST', '/v1/share', idToken, { name: 'E2E patient' });
  check(share.status === 200 && /^[A-Z2-9]{10}$/.test(share.code ?? ''), 'POST /v1/share makes a code');
  check((await api('POST', '/v1/doctor/patients', docToken, { code: 'ZZZZZZZZZZ' })).status === 404, 'a wrong code is refused');
  const added = await api('POST', '/v1/doctor/patients', docToken, { code: share.code });
  check(added.status === 200 && added.patientId === identityId, 'the doctor adds the patient with the code');
  check((await api('POST', '/v1/doctor/patients', docToken, { code: share.code })).status === 404, 'the code works only once');
  const list = await api('GET', '/v1/doctor/patients', docToken);
  check(list.patients?.length === 1 && list.patients[0].id === identityId && list.patients[0].devices?.some((d) => d.thing === thing), 'the doctor\'s patient list shows the patient and the headset');
  const detail = await api('GET', `/v1/doctor/patient?id=${encodeURIComponent(identityId)}&days=7`, docToken);
  check(detail.status === 200 && Array.isArray(detail.days) && Array.isArray(detail.events) && detail.events.length > 0, `the doctor reads the patient's days and events (${detail.events?.length} events)`);
  check(!JSON.stringify(detail).includes('"meds"') && !JSON.stringify(detail).includes('"pk"'), 'no medications or internal keys in what the doctor reads');
  check((await api('GET', '/v1/share', idToken)).doctors?.length === 1, 'the patient sees who has access');
  const doctorSub = (await api('GET', '/v1/share', idToken)).doctors?.[0]?.doctor;
  check((await api('DELETE', `/v1/share?doctor=${encodeURIComponent(doctorSub)}`, idToken)).status === 200, 'the patient stops sharing');
  check((await api('GET', `/v1/doctor/patient?id=${encodeURIComponent(identityId)}`, docToken)).status === 404, 'the doctor loses access at once');
} catch (e) {
  failures.push(String(e.message ?? e));
  console.error('  ✗ ' + (e.message ?? e));
} finally {
  await cleanup().catch((e) => failures.push('cleanup: ' + e.message));
}
console.log(failures.length ? `\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}` : '\nPASS: the deployed cloud path works end to end.');
process.exit(failures.length ? 1 : 0);
