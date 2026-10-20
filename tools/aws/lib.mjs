// Shared helpers for the AWS scripts. They call the AWS CLI with YOUR credentials (profile/region from the
// environment or --profile / --region), so nothing secret is stored in this repo.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const outDir = join(root, 'tools/aws/out');           // git-ignored: certificates, keys, outputs

export function args(argv = process.argv.slice(2)) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; o[k] = v; }
    else o._.push(argv[i]);
  }
  return o;
}

export function aws(cliArgs, opt = {}) {
  const a = [...cliArgs, '--output', 'json'];
  if (opt.region) a.push('--region', opt.region);
  if (opt.profile) a.push('--profile', opt.profile);
  try {
    const out = execFileSync('aws', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() ? JSON.parse(out) : {};
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    throw new Error(`aws ${cliArgs.slice(0, 2).join(' ')} failed: ${msg}`);
  }
}

/** Stack outputs, from the CDK outputs file or CloudFormation. */
export function stackOutputs(opt = {}) {
  const f = join(outDir, 'outputs.json');
  if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.TremorStack) return j.TremorStack; }
  try {
    const r = aws(['cloudformation', 'describe-stacks', '--stack-name', 'TremorStack'], opt);
    return Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  } catch (e) {
    console.error(`  (could not read the stack: ${e.message.split(/\r?\n/)[0].slice(0, 200)})`);
    return {};
  }
}

export function opts(a) { return { region: a.region ?? process.env.AWS_REGION ?? 'ap-south-1', profile: a.profile ?? process.env.AWS_PROFILE }; }
export const ok = (m) => console.log(`  ✓ ${m}`);

// Scripts end with a one-line error instead of a stack trace.
process.on('uncaughtException', (e) => { console.error('ERROR: ' + (e?.message ?? e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('ERROR: ' + (e?.message ?? e)); process.exit(1); });
