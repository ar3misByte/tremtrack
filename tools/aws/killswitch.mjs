#!/usr/bin/env node
// Emergency stop: disables the IoT rules so nothing more is written or invoked (e.g. a device stuck in a
// publish loop). Devices can still connect; messages are dropped by the broker without rule actions.
//   node tools/aws/killswitch.mjs            disable all tremor_* rules
//   node tools/aws/killswitch.mjs --enable   re-enable them
//   node tools/aws/killswitch.mjs --status
import { args, aws, ok, opts, stackOutputs } from './lib.mjs';

const a = args();
const o = opts(a);
const names = (stackOutputs(o).RuleNames ?? 'tremor_telemetry,tremor_status,tremor_registry,tremor_events').split(',');
for (const n of names) {
  if (a.status === 'true') { const r = aws(['iot', 'get-topic-rule', '--rule-name', n], o); console.log(`  ${n}: ${r.rule.ruleDisabled ? 'DISABLED' : 'enabled'}`); continue; }
  aws(['iot', a.enable === 'true' ? 'enable-topic-rule' : 'disable-topic-rule', '--rule-name', n], o);
  ok(`${n} ${a.enable === 'true' ? 'enabled' : 'DISABLED'}`);
}
if (a.status !== 'true' && a.enable !== 'true') console.log('\nAll rules disabled. To also stop the hourly aggregator: aws events disable-rule --name <HourlyRule> (see the stack resources), or destroy the stack.');
