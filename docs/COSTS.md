# Costs and AWS Free Tier

**Checked on 2026-10-20.** Prices and terms change; re-check the linked pages before relying on them.

## Your account

- **Plan type:** the account was created after 15 July 2025, so it is on the **new Free Tier**.
  - New customers get **US$100 in credits**, plus up to US$100 more for completing activities. Activities reported by third parties include creating a Budgets alert and deploying a Lambda function, and both happen in `AWS_SETUP.md`.
  - At sign-up you choose a **Free account plan** or a **Paid account plan**.
- **Free account plan:**
  - Only **Always Free** offers apply. Short-term trials, such as IoT Core's 12-month allowance, do not.
  - Usage beyond them is paid from credits.
  - The plan ends **6 months after the account was opened, or when credits run out, whichever comes first**. The account is then suspended, and its data erased after 90 days unless you upgrade to the Paid plan.
  - Some services are not available on the Free plan; AWS doesn't publish the full list on the pages checked.
- **Paid account plan:** Always Free and short-term trials apply, credits are used next, then normal pay-as-you-go prices.
- **Credit expiry:** the pages disagree (6 or 12 months), so check **Billing → Credits** for your account's actual date.
- **What I could not check:** your account's plan, because the `aws-cli` user isn't allowed to read billing data. Look at **Billing → Free Tier** in the console.

Sources:
- [AWS Free Tier (billing docs)](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html)
- [AWS Free Tier page](https://aws.amazon.com/free/)
- [Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/)
- [Free Tier terms](https://aws.amazon.com/free/terms)

## Service by service (what this project uses)

| Service | Free offer (type) | Price beyond it | Source |
|---|---|---|---|
| **IoT Core** | 2.25M connection minutes, 500K messages, 225K registry/shadow ops, 250K rules + 250K actions per month, **12 months** (short-term: not on the Free plan, so credits are used) | Connectivity $0.08 per 1M minutes; messages about $1.00 per 1M (Ireland example; Mumbai not shown), metered in **5 KB** units; rules $0.15 per 1M triggered + $0.15 per 1M actions (Canada example) | [IoT Core pricing](https://aws.amazon.com/iot-core/pricing/) |
| **DynamoDB** | 25 GB storage, **25 WCU + 25 RCU of provisioned capacity**, always free (provisioned mode only; on-demand is billed per request) | Not reached | [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/) |
| **Lambda** | 1M requests + 400K GB-s per month | Not reached | [Lambda pricing](https://aws.amazon.com/lambda/pricing/) (the page doesn't say "always free" explicitly) |
| **API Gateway HTTP API** | 1M calls per month for **12 months** (short-term) | $1.00 per 1M requests (512 KB units) | [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/) |
| **Cognito** | 10,000 MAU (Lite/Essentials), indefinitely; identity pools free | $0.015 per MAU (Essentials) | [Cognito pricing](https://aws.amazon.com/cognito/pricing/) |
| **SNS (email)** | Pricing page doesn't state email allowances; third parties cite 1,000 email deliveries per month always free (**unverified**) | A few emails a month: negligible | [SNS pricing](https://aws.amazon.com/sns/pricing/) |
| **CloudFront** (optional hosting) | Flat-rate **Free plan, $0/month**: 1M requests, 100 GB transfer, 5 GB S3 included | Pro $15/month (not needed) | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) |
| S3, CloudWatch Logs, EventBridge schedule, KMS (AWS-managed SNS key), Budgets | Small; exact allowances under the new plan **not verified** | Expected under $0.05 per month together | [AWS Free Tier](https://aws.amazon.com/free/) |

**Region:** `ap-south-1` (Mumbai) is listed for IoT Core control, data and credential endpoints, and for Cognito user pools and identity pools ([IoT endpoints](https://docs.aws.amazon.com/general/latest/gr/iot-core.html), [Cognito endpoints](https://docs.aws.amazon.com/general/latest/gr/cognito_identity.html)). DynamoDB, Lambda, API Gateway, SNS, S3 and EventBridge are core services available in Mumbai. The deployment itself is the final proof.

## Message budget: a typical day

Assumptions: one headset worn **8 h a day**; the live cloud view open **20 min a day**; telemetry every 5 s (0.2 Hz) normally and every 1 s while someone watches (the `viewer` topic); about 30 tremor episodes a day.

| Item | Per day | Per month (30 d) |
|---|---|---|
| Telemetry published: 8 h × 720/h, plus the extra while watched (1,200 at 1 Hz instead of 240) | about 6,700 | 201,000 |
| Events (tremor starts, episodes, falls, boot) | about 70 | 2,100 |
| Status (connect, 15-min heartbeat, last will) | about 35 | 1,050 |
| Messages delivered to the browser while watching (telemetry + events) | about 1,250 | 37,500 |
| **Messages (each under 5 KB, so 1 unit each)** | **about 8,050** | **about 242,000** |
| Rules triggered (telemetry 1, status 2, event 1 per message) | about 6,840 | 205,000 (+ the same number of actions) |
| Connection minutes (device 480 + browser 20) | 500 | 15,000 |
| DynamoDB writes (telemetry + status + events + day records) | about 6,900 | 207,000 (average 0.08 WCU; 15 provisioned) |
| DynamoDB storage (14-day telemetry TTL, about 0.45 KB per item) | – | about 45 MB |
| Lambda invocations (events, hourly aggregator, API) | about 200 | about 6,000 |
| API requests (app sync and history, milestone 7) | about 100 | about 3,000 |

**What that costs:**

| | IoT messages | IoT rules + actions | IoT connectivity | API Gateway | Other | **Total** |
|---|---|---|---|---|---|---|
| Typical (8 h a day) | 0.24M × $1 = $0.24 | 0.41M × $0.15 = $0.06 | 15K min ≈ $0.001 | ≈ $0.003 | < $0.05 | **about $0.35 a month** |
| Worst case (worn 24 h at 1 Hz) | 2.6M × $1 = $2.60 | 5.2M × $0.15 = $0.78 | 43K min ≈ $0.004 | ≈ $0.003 | < $0.10 | **about $3.50 a month** |

- **Free plan:** the IoT and API Gateway amounts come out of the credits. Everything else stays inside Always Free.
- **Paid plan in its first 12 months:** the IoT allowances (500K messages, 250K rules) cover the typical case completely.
- **Budget:** the alarm (`budgetEmail`, $5 a month by default) emails at 20 %, 50 % and 100 % actual spend, and at 100 % forecast.
- **Sending all 50 Hz data instead** would be about 4.3M messages a day (130M a month, around $130 a month in messages alone), which is why the protocol never does it.

## Cost controls built into the stack

- **No Lambda per telemetry message:** an IoT rule writes telemetry straight into DynamoDB.
- **Adaptive rate:** telemetry every 5 s unless someone watches, every 1 s only while the `viewer` flag is set.
- **DynamoDB:** provisioned 10 RCU / 15 WCU (inside the always-free 25/25), raw telemetry expires after 14 days, daily aggregates are kept.
- **Logs:** CloudWatch log groups keep 7 days.
- **API:** throttled to 10 requests per second (burst 20).
- **Kill switch:** `node tools/aws/killswitch.mjs` disables all IoT rules.
- **Teardown:** `npx cdk destroy` removes everything (see `AWS_SETUP.md` step 8).
- **Small fixed extras:** the CDK bootstrap stack (an S3 bucket with a few MB of deployment assets, and an empty ECR repository) costs well under one cent a month.
