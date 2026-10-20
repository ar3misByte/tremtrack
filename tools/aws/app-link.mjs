#!/usr/bin/env node
// Prints the link (and the bare code) that sets the app up for YOUR deployed stack: open it on your phone, or paste
// it on the app's Cloud screen. Nothing secret is in it. Needs your AWS CLI login (it reads the stack outputs and
// asks IoT Core for the account's data endpoint).
//   node tools/aws/app-link.mjs [--app-url https://user.github.io/head-tremor/] [--profile p] [--region ap-south-1]
import { args, aws, opts, stackOutputs } from './lib.mjs';
import { setupCode, setupConfig, setupLink } from './setup-code.mjs';

const a = args();
const o = opts(a);
const out = stackOutputs(o);
if (!out.UserPoolId) { console.error('Stack outputs not found. Deploy first (docs/AWS_SETUP.md step 3).'); process.exit(1); }
const endpoint = aws(['iot', 'describe-endpoint', '--endpoint-type', 'iot:Data-ATS'], o).endpointAddress;
const cfg = setupConfig(out, o.region, endpoint);
const appUrl = a['app-url'] && a['app-url'] !== 'true' ? a['app-url'] : out.AppUrl;

console.log('\nCloud setup for the app (no secrets in it):\n');
if (appUrl) console.log(`  Link (open on your phone):\n  ${setupLink(appUrl, cfg)}\n`);
else console.log('  (no --app-url given and the stack has no hosting: paste the code below on the app\'s Cloud screen)\n');
console.log(`  Code (paste on the Cloud screen):\n  ${setupCode(cfg)}\n`);
console.log(`Sign-in redirect: the app must be served from one of the URLs you gave the stack as appOrigins (now allowed by Cognito: see the stack's callback URLs).`);
