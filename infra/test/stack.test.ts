import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TremorStack, TELEMETRY_TTL_S } from '../lib/stack.ts';

function synth(extra: Partial<ConstructorParameters<typeof TremorStack>[2]> = {}) {
  const app = new App();
  const s = new TremorStack(app, 'T', { env: { region: 'ap-south-1', account: '111111111111' }, budgetUsd: 5, appOrigins: ['http://localhost:5173'], withHosting: false, budgetEmail: 'me@example.com', alertEmail: 'carer@example.com', ...extra });
  return Template.fromStack(s);
}
const t = synth();
const json = JSON.stringify(t.toJSON());

describe('TremorStack template', () => {
  it('DynamoDB: provisioned within the always-free 25 RCU / 25 WCU, TTL on, encrypted', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 15 },
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      SSESpecification: { SSEEnabled: true },
    });
  });

  it('IoT rules: telemetry to DynamoDB with a 14-day TTL and checks; events to Lambda; error logging', () => {
    const rules = t.findResources('AWS::IoT::TopicRule');
    const byName = Object.fromEntries(Object.values(rules).map((r: any) => [r.Properties.RuleName, r.Properties.TopicRulePayload]));
    expect(Object.keys(byName).sort()).toEqual(['tremor_events', 'tremor_registry', 'tremor_status', 'tremor_telemetry']);
    const tel = byName.tremor_telemetry.Sql as string;
    for (const s of ["FROM 'tremor/v1/+/+/telemetry'", 'v = 1', 'seq >= 0', 'ts > 1704067200000', '(tr = 0 OR tr = 1)', `+ ${TELEMETRY_TTL_S} AS ttl`, "concat('U#', topic(3)) AS pk", "concat('T#', topic(4), '#', cast(ts AS String)) AS sk"]) expect(tel).toContain(s);
    expect(byName.tremor_events.Actions[0].Lambda).toBeDefined();
    for (const p of Object.values(byName) as any[]) expect(p.ErrorAction.CloudwatchLogs).toBeDefined();
  });

  it('device policy: own client id, attached certificate, own owner/thing topics only', () => {
    const pol = Object.values(t.findResources('AWS::IoT::Policy')).map((r: any) => JSON.stringify(r.Properties.PolicyDocument));
    const dev = pol.find((p) => p.includes('iot:Connection.Thing.ThingName'))!;
    expect(dev).toContain('iot:Connection.Thing.IsAttached');
    expect(dev).toContain('${iot:Connection.Thing.Attributes[owner]}/${iot:Connection.Thing.ThingName}/telemetry');
    expect(dev).not.toMatch(/topic\/tremor\/v1\/\*|"Resource":"\*"/);
    const user = pol.find((p) => p.includes('cognito-identity.amazonaws.com:sub'))!;
    expect(user).toContain('tremor/v1/${cognito-identity.amazonaws.com:sub}/*');
  });

  it('Lambdas get only the DynamoDB actions they use (no Scan, no table-wide wildcards)', () => {
    expect(json).not.toContain('dynamodb:Scan');
    expect(json).not.toMatch(/"dynamodb:*"/);
  });

  it('no wildcard IAM actions or resources', () => {
    const docs = [...Object.values(t.findResources('AWS::IAM::Policy')), ...Object.values(t.findResources('AWS::IAM::Role'))].map((r: any) => r.Properties.PolicyDocument ?? r.Properties.Policies).filter(Boolean);
    for (const d of docs) {
      const s = JSON.stringify(d);
      expect(s).not.toMatch(/"Action":"\*"/);
      expect(s).not.toMatch(/"Action":\["\*"\]/);
      expect(s).not.toMatch(/"Resource":"\*"/);
    }
  });

  it('Lambdas: Node 22 on arm64, 7-day log retention', () => {
    t.resourcePropertiesCountIs('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Architectures: ['arm64'] }, 3);
    for (const g of Object.values(t.findResources('AWS::Logs::LogGroup')) as any[]) expect(g.Properties.RetentionInDays).toBe(7);
  });

  it('an app URL with a path (GitHub Pages): CORS gets the origin, Cognito gets the full callback URL', () => {
    const p = synth({ appOrigins: ['http://localhost:5173', 'https://user.github.io/head-tremor/'] });
    p.hasResourceProperties('AWS::Cognito::UserPoolClient', { CallbackURLs: ['http://localhost:5173/', 'https://user.github.io/head-tremor/'], LogoutURLs: ['http://localhost:5173/', 'https://user.github.io/head-tremor/'] });
    p.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.objectLike({ AllowOrigins: ['http://localhost:5173', 'https://user.github.io'] }) });
  });

  it('HTTP API: CORS locked to the app origins, JWT on every route, throttled', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: { AllowOrigins: ['http://localhost:5173'] } });
    for (const r of Object.values(t.findResources('AWS::ApiGatewayV2::Route')) as any[]) expect(r.Properties.AuthorizationType).toBe('JWT');
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 }) });
  });

  it('identity pool: no unauthenticated access; browser role scoped to its own topics', () => {
    t.hasResourceProperties('AWS::Cognito::IdentityPool', { AllowUnauthenticatedIdentities: false });
    expect(json).toContain(':topicfilter/tremor/v1/${cognito-identity.amazonaws.com:sub}/*');
    expect(json).not.toContain('topicfilter/tremor/v1/*');
  });

  it('budget alarm and encrypted alert topic when emails are given', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' }, TimeUnit: 'MONTHLY' }) });
    t.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    t.resourceCountIs('AWS::SNS::Subscription', 1);
  });

  it('without emails: no budget, no subscription', () => {
    const t2 = synth({ budgetEmail: undefined, alertEmail: undefined });
    t2.resourceCountIs('AWS::Budgets::Budget', 0);
    t2.resourceCountIs('AWS::SNS::Subscription', 0);
  });
});
