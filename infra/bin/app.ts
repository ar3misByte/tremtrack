// CDK entry point. Settings come from cdk.json "context", overridable on the command line, e.g.
//   npx cdk deploy -c alertEmail=carer@example.com -c budgetEmail=me@example.com -c withHosting=true
import { App } from 'aws-cdk-lib';
import { TremorStack } from '../lib/stack.ts';

const app = new App();
const ctx = (k: string) => app.node.tryGetContext(k);
const region = String(ctx('region') ?? 'ap-south-1');

new TremorStack(app, 'TremorStack', {
  env: { region, account: process.env.CDK_DEFAULT_ACCOUNT },
  description: 'Head Tremor Monitor prototype backend (IoT Core, DynamoDB, Lambda, HTTP API, Cognito, SNS). Not a medical device.',
  alertEmail: String(ctx('alertEmail') ?? '') || undefined,
  budgetEmail: String(ctx('budgetEmail') ?? '') || undefined,
  budgetUsd: Number(ctx('budgetUsd') ?? 5),
  appOrigins: String(ctx('appOrigins') ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  withHosting: String(ctx('withHosting')) === 'true',
  tags: { project: 'head-tremor-monitor' },
});
