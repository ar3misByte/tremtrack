#!/usr/bin/env node
// Makes an existing user a doctor (adds them to the Cognito group "doctors"), or takes it away.
// Only someone with your AWS credentials can do this: signing up in the app never gives doctor access.
//
//   node tools/aws/make-doctor.mjs --email dr@example.com            add to the group
//   node tools/aws/make-doctor.mjs --email dr@example.com --remove   take them out again
//   node tools/aws/make-doctor.mjs --list                            who is a doctor
//
// The person must have signed up in the app first (Cloud -> Sign in -> Create account). They must sign out and in
// again afterwards: the group is written into the sign-in token.
import { args, aws, ok, opts, stackOutputs } from './lib.mjs';

const a = args();
const o = opts(a);
const out = stackOutputs(o);
if (!out.UserPoolId) { console.error('Stack outputs not found. Deploy first (docs/AWS_SETUP.md step 3).'); process.exit(1); }

if (a.list) {
  const r = aws(['cognito-idp', 'list-users-in-group', '--user-pool-id', out.UserPoolId, '--group-name', 'doctors'], o);
  const users = r.Users ?? [];
  console.log(users.length ? users.map((u) => '  ' + (u.Attributes?.find((x) => x.Name === 'email')?.Value ?? u.Username)).join('\n') : '  (no doctors yet)');
  process.exit(0);
}

const email = a.email;
if (!email || email === 'true') { console.error('Usage: node tools/aws/make-doctor.mjs --email dr@example.com [--remove]   (or --list)'); process.exit(1); }
const found = aws(['cognito-idp', 'list-users', '--user-pool-id', out.UserPoolId, '--filter', `email = "${email.replace(/"/g, '')}"`], o).Users ?? [];
if (!found.length) { console.error(`No user with the email ${email}. They need to sign up in the app first (Cloud -> Sign in -> Create account).`); process.exit(1); }
const username = found[0].Username;
aws([ 'cognito-idp', a.remove ? 'admin-remove-user-from-group' : 'admin-add-user-to-group', '--user-pool-id', out.UserPoolId, '--username', username, '--group-name', 'doctors'], o);
ok(a.remove ? `${email} is no longer a doctor` : `${email} is now a doctor. They must sign out and sign in again, then open #/doctor in the app.`);
