// The whole backend in one stack (one-command deploy and destroy). See docs/ARCHITECTURE.md and docs/COSTS.md.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Fn, Aws } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface TremorProps extends StackProps {
  alertEmail?: string;          // caregiver alerts (SNS email subscription; the address must confirm)
  budgetEmail?: string;         // budget alarms
  budgetUsd: number;
  appOrigins: string[];         // where the app is served, e.g. http://localhost:5173 or https://user.github.io/head-tremor (CORS uses the origin, Cognito callbacks the full URL)
  withHosting: boolean;         // S3 + CloudFront for the built app (app/dist)
}

export const RULE_NAMES = ['tremor_telemetry', 'tremor_status', 'tremor_registry', 'tremor_events'] as const;
export const TELEMETRY_TTL_S = 14 * 86_400;

export class TremorStack extends Stack {
  constructor(scope: Construct, id: string, p: TremorProps) {
    super(scope, id, p);
    const arn = (res: string) => `arn:${Aws.PARTITION}:iot:${Aws.REGION}:${Aws.ACCOUNT_ID}:${res}`;
    const logGroup = (name: string) => new logs.LogGroup(this, name, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });

    // ---------------- storage: one table, provisioned within the always-free 25 RCU / 25 WCU ----------------
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 10, writeCapacity: 15,
      timeToLiveAttribute: 'ttl',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,           // demo: `cdk destroy` removes all data
    });

    // ---------------- alerts ----------------
    const topic = new sns.Topic(this, 'Alerts', { displayName: 'Head Tremor Monitor alerts', masterKey: kms.Alias.fromAliasName(this, 'SnsKey', 'alias/aws/sns') });
    if (p.alertEmail) topic.addSubscription(new subs.EmailSubscription(p.alertEmail));

    // ---------------- Lambdas ----------------
    const fn = (name: string, entry: string, timeout = 10, env: Record<string, string> = {}) => new nodejs.NodejsFunction(this, name, {
      entry: path.join(here, '../lambda', entry),
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64, memorySize: 256,
      timeout: Duration.seconds(timeout),
      logGroup: logGroup(`${name}Logs`),
      environment: { TABLE: table.tableName, ...env },
      bundling: { format: nodejs.OutputFormat.ESM, minify: true, sourceMap: false, target: 'node22', externalModules: ['@aws-sdk/*'] },
    });
    const eventsFn = fn('EventsFn', 'events.ts', 10, { ALERT_TOPIC: topic.topicArn });
    const aggregateFn = fn('AggregateFn', 'aggregate.ts', 60, { ALERT_TOPIC: topic.topicArn });
    // least privilege: only the DynamoDB actions each function calls
    table.grant(eventsFn, 'dynamodb:PutItem', 'dynamodb:GetItem');
    table.grant(aggregateFn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    topic.grantPublish(eventsFn);
    topic.grantPublish(aggregateFn);
    new events.Rule(this, 'Hourly', { schedule: events.Schedule.rate(Duration.hours(1)), targets: [new targets.LambdaFunction(aggregateFn)] });

    // ---------------- IoT Core ----------------
    // Device policy: a device may connect only as its own thing (client id = thing name, certificate attached
    // to that thing) and use only the topics of its owner and itself (owner = thing attribute set at provisioning).
    const devTopic = (k: string) => arn(`topic/tremor/v1/\${iot:Connection.Thing.Attributes[owner]}/\${iot:Connection.Thing.ThingName}/${k}`);
    const devFilter = (k: string) => arn(`topicfilter/tremor/v1/\${iot:Connection.Thing.Attributes[owner]}/\${iot:Connection.Thing.ThingName}/${k}`);
    const devicePolicy = new iot.CfnPolicy(this, 'DevicePolicy', {
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'iot:Connect', Resource: arn('client/${iot:Connection.Thing.ThingName}'), Condition: { Bool: { 'iot:Connection.Thing.IsAttached': 'true' } } },
          { Effect: 'Allow', Action: ['iot:Publish', 'iot:RetainPublish'], Resource: ['telemetry', 'event', 'status'].map(devTopic) },
          { Effect: 'Allow', Action: 'iot:Subscribe', Resource: ['cmd', 'viewer'].map(devFilter) },
          { Effect: 'Allow', Action: 'iot:Receive', Resource: ['cmd', 'viewer'].map(devTopic) },
        ],
      },
    });
    // Browser (signed-in user via the Cognito identity pool): only its own owner prefix. Attached to each identity by POST /v1/me/link.
    const sub = '${cognito-identity.amazonaws.com:sub}';
    const userIotStatements = [
      { Effect: 'Allow', Action: 'iot:Connect', Resource: [arn(`client/${sub}`), arn(`client/${sub}-*`)] },
      { Effect: 'Allow', Action: 'iot:Subscribe', Resource: arn(`topicfilter/tremor/v1/${sub}/*`) },
      { Effect: 'Allow', Action: 'iot:Receive', Resource: arn(`topic/tremor/v1/${sub}/*`) },
      { Effect: 'Allow', Action: ['iot:Publish', 'iot:RetainPublish'], Resource: [arn(`topic/tremor/v1/${sub}/*/cmd`), arn(`topic/tremor/v1/${sub}/*/viewer`)] },
    ];
    const userPolicy = new iot.CfnPolicy(this, 'UserIotPolicy', { policyDocument: { Version: '2012-10-17', Statement: userIotStatements } });

    const ruleErrors = logGroup('RuleErrors');
    const ruleRole = new iam.Role(this, 'RuleRole', { assumedBy: new iam.ServicePrincipal('iot.amazonaws.com') });
    table.grant(ruleRole, 'dynamodb:PutItem');
    ruleErrors.grantWrite(ruleRole);
    const errorAction = { cloudwatchLogs: { logGroupName: ruleErrors.logGroupName, roleArn: ruleRole.roleArn } };
    const ddbAction = { dynamoDBv2: { putItem: { tableName: table.tableName }, roleArn: ruleRole.roleArn } };
    // The rule SQL checks the version and the key fields; full schema validation of telemetry happens on read
    // (API) and in tests; events are validated in the events Lambda. Only the owner's own device can publish here.
    const rule = (name: string, sql: string, actions: iot.CfnTopicRule.ActionProperty[]) => new iot.CfnTopicRule(this, name, {
      ruleName: name,
      topicRulePayload: { sql, awsIotSqlVersion: '2016-03-23', ruleDisabled: false, actions, errorAction },
    });
    rule('tremor_telemetry',
      `SELECT *, concat('U#', topic(3)) AS pk, concat('T#', topic(4), '#', cast(ts AS String)) AS sk, topic(4) AS thing, floor(timestamp() / 1000) + ${TELEMETRY_TTL_S} AS ttl ` +
      `FROM 'tremor/v1/+/+/telemetry' WHERE v = 1 AND seq >= 0 AND ts > 1704067200000 AND ts < 4102444800000 AND per >= 0 AND (tr = 0 OR tr = 1)`,
      [ddbAction]);
    rule('tremor_status',
      `SELECT *, concat('U#', topic(3)) AS pk, concat('D#', topic(4)) AS sk, topic(4) AS thing, timestamp() AS lastSeen FROM 'tremor/v1/+/+/status' WHERE v = 1 AND (online = true OR online = false)`,
      [ddbAction]);
    rule('tremor_registry',
      `SELECT 'DEVICES' AS pk, topic(4) AS sk, topic(3) AS owner, timestamp() AS lastSeen, tzMin, online FROM 'tremor/v1/+/+/status' WHERE v = 1 AND (online = true OR online = false)`,
      [ddbAction]);
    const eventsRule = rule('tremor_events', `SELECT *, topic(3) AS owner, topic(4) AS thing FROM 'tremor/v1/+/+/event' WHERE v = 1`, [{ lambda: { functionArn: eventsFn.functionArn } }]);
    eventsFn.addPermission('IotInvoke', { principal: new iam.ServicePrincipal('iot.amazonaws.com'), sourceArn: eventsRule.attrArn, sourceAccount: Aws.ACCOUNT_ID });

    // ---------------- hosting (optional): private S3 + CloudFront with origin access control ----------------
    let appUrl: string | undefined;
    let dist: cloudfront.Distribution | undefined;
    let bucket: s3.Bucket | undefined;
    if (p.withHosting) {
      bucket = new s3.Bucket(this, 'AppBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
      });
      dist = new cloudfront.Distribution(this, 'AppCdn', {
        defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS },
        defaultRootObject: 'index.html',
        errorResponses: [{ httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' }, { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' }],
        priceClass: cloudfront.PriceClass.PRICE_CLASS_200,              // includes India edge locations
      });
      appUrl = `https://${dist.distributionDomainName}`;
    }
    // appOrigins may include a path (https://user.github.io/head-tremor): CORS needs the origin, Cognito the full URL
    const appUrls = [...p.appOrigins, ...(appUrl ? [appUrl] : [])].map((u) => u.replace(/\/+$/, ''));
    const origins_ = [...new Set(appUrls.map((u) => new URL(u).origin))];

    // ---------------- auth: user pool (email sign-up) + identity pool (live MQTT in the browser) ----------------
    const pool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: true, signInAliases: { email: true }, autoVerify: { email: true },
      passwordPolicy: { minLength: 10, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const domain = pool.addDomain('Domain', { cognitoDomain: { domainPrefix: Fn.join('-', ['tremor', Aws.ACCOUNT_ID]) } });
    const client = pool.addClient('App', {
      generateSecret: false,
      authFlows: { userSrp: true, adminUserPassword: true },          // adminUserPassword: only for scripts run with deployer credentials (cloud e2e)
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE], callbackUrls: appUrls.map((u) => `${u}/`), logoutUrls: appUrls.map((u) => `${u}/`) },
      idTokenValidity: Duration.hours(1), accessTokenValidity: Duration.hours(1), refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });
    const idPool = new cognito.CfnIdentityPool(this, 'Identities', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{ clientId: client.userPoolClientId, providerName: pool.userPoolProviderName }],
    });
    const authRole = new iam.Role(this, 'BrowserRole', {
      assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
        StringEquals: { 'cognito-identity.amazonaws.com:aud': idPool.ref },
        'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
      }, 'sts:AssumeRoleWithWebIdentity'),
      maxSessionDuration: Duration.hours(1),
    });
    for (const s of userIotStatements) authRole.addToPolicy(new iam.PolicyStatement({ actions: ([] as string[]).concat(s.Action), resources: ([] as string[]).concat(s.Resource) }));
    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityRoles', { identityPoolId: idPool.ref, roles: { authenticated: authRole.roleArn } });

    // ---------------- HTTP API ----------------
    const apiFn = fn('ApiFn', 'api.ts', 15, {
      IDENTITY_POOL_ID: idPool.ref, USER_POOL_PROVIDER: pool.userPoolProviderName, USER_POOL_ID: pool.userPoolId, USER_IOT_POLICY: userPolicy.ref,
    });
    table.grant(apiFn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem');
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['iot:AttachPolicy', 'iot:DetachPolicy'], resources: [arn(`policy/${userPolicy.ref}`)] }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminDeleteUser'], resources: [pool.userPoolArn] }));
    const api = new apigw.HttpApi(this, 'Api', {
      corsPreflight: { allowOrigins: origins_, allowHeaders: ['authorization', 'content-type'], allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.PUT, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE], maxAge: Duration.hours(1) },
      createDefaultStage: false,
    });
    new apigw.HttpStage(this, 'Stage', { httpApi: api, stageName: '$default', autoDeploy: true, throttle: { rateLimit: 10, burstLimit: 20 } });
    const auth = new HttpJwtAuthorizer('Jwt', `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}`, { jwtAudience: [client.userPoolClientId] });
    const integ = new HttpLambdaIntegration('ApiInteg', apiFn);
    const routes: [string, apigw.HttpMethod][] = [
      ['/v1/me', apigw.HttpMethod.GET], ['/v1/me', apigw.HttpMethod.DELETE], ['/v1/me/link', apigw.HttpMethod.POST], ['/v1/days', apigw.HttpMethod.GET],
      ['/v1/events', apigw.HttpMethod.GET], ['/v1/telemetry', apigw.HttpMethod.GET], ['/v1/sync', apigw.HttpMethod.PUT], ['/v1/sync', apigw.HttpMethod.GET],
    ];
    for (const [pth, m] of routes) api.addRoutes({ path: pth, methods: [m], integration: integ, authorizer: auth });

    // ---------------- budget alarm ----------------
    if (p.budgetEmail) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: p.budgetEmail }];
      new budgets.CfnBudget(this, 'Budget', {
        budget: { budgetName: 'tremor-monthly', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: p.budgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 20, thresholdType: 'PERCENTAGE' }, subscribers },
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 50, thresholdType: 'PERCENTAGE' }, subscribers },
          { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
          { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers },
        ],
      });
    }

    // ---------------- app deployment (the app is configured with the link from tools/aws/app-link.mjs, not a config file) ----------------
    if (bucket && dist) {
      new s3deploy.BucketDeployment(this, 'AppDeploy', {
        destinationBucket: bucket, distribution: dist, distributionPaths: ['/*'], memoryLimit: 256,
        sources: [
          s3deploy.Source.asset(path.join(here, '../../app/dist')),
        ],
      });
    }

    // ---------------- outputs (read by tools/aws/*.mjs) ----------------
    const out = (k: string, v: string) => new CfnOutput(this, k, { value: v });
    out('Region', Aws.REGION);
    out('TableName', table.tableName);
    out('DevicePolicyName', devicePolicy.ref);
    out('UserIotPolicyName', userPolicy.ref);
    out('UserPoolId', pool.userPoolId);
    out('UserPoolClientId', client.userPoolClientId);
    out('IdentityPoolId', idPool.ref);
    out('CognitoDomain', `${domain.domainName}.auth.${Aws.REGION}.amazoncognito.com`);
    out('ApiUrl', api.apiEndpoint);
    out('AlertTopicArn', topic.topicArn);
    out('RuleNames', RULE_NAMES.join(','));
    if (appUrl) out('AppUrl', appUrl);
  }
}
