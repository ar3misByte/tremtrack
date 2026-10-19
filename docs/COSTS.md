# Costs and AWS Free Tier

Status: **skeleton.** Nothing in this project uses AWS yet (milestones 1–5 are local only).

## What is known now
- The AWS account was created **after 15 July 2025**, so it is on the newer Free Tier: sign-up credits plus a free-plan period, rather than the legacy 12-month free tier. The exact terms will be looked up and recorded below, with the check date and links, before any infrastructure is written (milestone 6).
- Design rules already fixed:
  - No 50 Hz data to the cloud. Telemetry is 0.2 Hz by default and 1 Hz only while someone watches the live cloud view.
  - No Lambda per telemetry message: an IoT rule writes straight to DynamoDB.
  - A budget alarm, short log retention, and a kill-switch script are part of the stack.

## To fill in (milestone 6)
- [ ] Current Free Tier / credit terms for: IoT Core, DynamoDB, Lambda, API Gateway HTTP API, Cognito, SNS, S3, CloudFront, CloudWatch Logs, EventBridge. Each with the source link and the date checked.
- [ ] Service availability in `ap-south-1`.
- [ ] Message budget for a typical day (device worn 8 h, live view open 20 min), with IoT Core message counts in 5 KB units, rule actions, and DynamoDB writes.
- [ ] Expected monthly cost after credits: target a few cents.
