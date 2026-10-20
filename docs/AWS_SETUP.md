# AWS setup guide

For someone with a new AWS account who has never used IoT Core, working on **Windows** (PowerShell) with the Arduino IDE.
- **Time:** about 45 minutes the first time.
- **Expected cost:** well under US$1 per month for one device (see `COSTS.md`), normally covered by your sign-up credits.
- **Region:** `ap-south-1` (Mumbai). It is the closest region to India, and every service used here is available there; checked on 2026-10-20, see `COSTS.md`.

> **Status:** the backend, device provisioning, firmware (Wi-Fi, MQTT, compiled but not yet run on a board against real AWS), the app's sign-in, live cloud view, history and sync (tested against a local mock of this backend), and the automated checks are all in place. **A real deployment has not been done yet**: the first run is yours, and steps 3, 5, 6 and 7 are where surprises would show. Tell me what fails.

Commands are for **PowerShell**, run from the repository folder (`D:\mpmc proj`). Quote paths that contain spaces.

---

## 1. Secure the account first (console, about 15 min)

1. **Turn on MFA for the root user.** Sign in as root at <https://console.aws.amazon.com/> → account menu (top right) → **Security credentials** → **Assign MFA device** → an authenticator app.
   *Expected:* the page lists one MFA device. Don't use the root user for anything else from here on.
2. **Check your account plan and credits.**
   - Open **Billing and Cost Management → Free Tier**, then **Credits**.
   - Note whether the account is on the **Free plan** or the **Paid plan**, and when the credits expire.
   - On the Free plan the account is suspended 6 months after it was opened, or when the credits run out. Your resources are kept for 90 days and then erased unless you upgrade.
3. **Create an everyday admin login with IAM Identity Center** (recommended over long-lived access keys).
   1. In the console, open **IAM Identity Center** → **Enable** (in `ap-south-1`).
   2. **Users → Add user**: your name and email, then accept the invitation email and set a password and MFA.
   3. **Permission sets → Create permission set → Predefined → AdministratorAccess**, with a session duration of 4 h.
   4. **AWS accounts →** select your account **→ Assign users or groups →** your user **→** the `AdministratorAccess` set.
   5. Note the **AWS access portal URL** (Settings → Identity source), which looks like `https://d-xxxxxxxxxx.awsapps.com/start`.

   *Expected:* signing in at the portal URL shows your account with the `AdministratorAccess` role.

   > The existing `aws-cli` IAM user on this machine does **not** have the permissions needed to deploy (it was refused IoT, IAM and CloudFormation reads). Use the SSO profile from step 2 instead, and consider deleting that user's access key if nothing else uses it.
4. **Budget and billing alerts:**
   - **Billing → Billing preferences:** turn on **Free Tier usage alerts** and **Receive CloudWatch billing alerts** (email).
   - **Budgets → Create budget → Use a template → Monthly cost budget:** amount `5` USD, your email.

   The stack also creates a `tremor-monthly` budget if you pass `budgetEmail` in step 3, but set this one up now so you're covered from the start.

## 2. Install and configure the tools (about 10 min)

Check these in PowerShell:

```powershell
node --version        # v20 or newer   (have: v24)
git --version
aws --version         # aws-cli/2.x    (have: 2.37)
```

If Node or the AWS CLI is missing: `winget install OpenJS.NodeJS.LTS`, then `winget install Amazon.AWSCLI`, then open a new terminal.

**Sign the CLI in with your SSO user** (no keys are stored, only short-lived tokens):

```powershell
aws configure sso
#   SSO session name: tremor
#   SSO start URL:    https://d-xxxxxxxxxx.awsapps.com/start      (from step 1.3)
#   SSO region:       ap-south-1
#   (a browser opens: approve)
#   choose the account and AdministratorAccess
#   CLI default client Region: ap-south-1
#   CLI default output format: json
#   Profile name: tremor-admin
$env:AWS_PROFILE = "tremor-admin"
aws sts get-caller-identity
```

*Expected:* JSON with your account number and an `Arn` containing `AWSReservedSSO_AdministratorAccess`. When the session expires later, run `aws sso login --profile tremor-admin`.

**Install the project and run the offline checks** (no AWS calls):

```powershell
npm install
npm run test -w infra        # stack template + cloud path against local mocks
npm run cdk:synth            # builds the CloudFormation template
```

*Expected:* `Tests  18 passed`, and `cdk synth` finishes without errors. A note about "feature flags" is harmless.

**Bootstrap CDK once per account and region.** This creates the `CDKToolkit` stack: a small S3 bucket and an ECR repository used for deployment assets.

```powershell
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-south-1
```

*Expected:* `Environment aws://<ACCOUNT_ID>/ap-south-1 bootstrapped.`

## 3. Deploy the stack (about 5 min)

From the `infra` folder:

```powershell
npx cdk deploy -c alertEmail=carer@example.com -c budgetEmail=you@example.com --outputs-file ..\tools\aws\out\outputs.json
```

- `alertEmail` receives caregiver alerts: a confirmed or unanswered fall, a long tremor episode, a low resting SpO₂ estimate. Leave it out for no alerts.
- To host the app on CloudFront as well, run `npm run build` in the repository root first, then add `-c withHosting=true`.
- To allow another browser origin (CORS and sign-in redirects), add `-c appOrigins=http://localhost:5173,https://your.domain`.

The CLI lists the IAM changes and deploys about 50 resources. *Expected* at the end:

```
 ✅  TremorStack
Outputs:
TremorStack.AlertTopicArn = arn:aws:sns:ap-south-1:<acct>:TremorStack-Alerts...
TremorStack.ApiUrl = https://xxxxxxxxxx.execute-api.ap-south-1.amazonaws.com
TremorStack.CognitoDomain = tremor-<acct>.auth.ap-south-1.amazoncognito.com
TremorStack.DevicePolicyName = TremorStack-DevicePolicy-...
TremorStack.IdentityPoolId = ap-south-1:...
TremorStack.UserPoolClientId = ...
TremorStack.UserPoolId = ap-south-1_...
...
```

- **Confirm the SNS email:** open "AWS Notification - Subscription Confirmation" and click **Confirm subscription**. Until then no alerts are delivered.
- **The outputs are saved** to `tools/aws/out/outputs.json`, which is git-ignored. The scripts below read them from there.

## 4. Provision a device and keep its key safe

A device belongs to a **user**, identified by that user's Cognito identity id. Until app sign-in exists (milestone 7), create a user with the test script:

```powershell
node tools/aws/cloud-e2e.mjs --create-user you@example.com
```

*Expected:* `✓ user you@example.com, identity ap-south-1:…`, the password (shown once), and the identity id. Then:

```powershell
node tools/aws/provision-device.mjs --thing htm-01 --owner "ap-south-1:<identity id>"
```

*Expected:*

```
  ✓ endpoint xxxxxxxxxxxx-ats.iot.ap-south-1.amazonaws.com
  ✓ thing created
  ✓ certificate 1a2b3c4d5e6f... (private key saved locally only)
  ✓ policy TremorStack-DevicePolicy-... attached, certificate attached to the thing
  ✓ Amazon Root CA 1 downloaded
  ✓ simulator config tools\aws\out\htm-01\devsim.json
  ✓ firmware/tremor_monitor/device_config.h written (git-ignored)
```

**Keeping the private key safe:**
- It exists only in `tools\aws\out\htm-01\` and `firmware\tremor_monitor\device_config.h`. Both are git-ignored; check with `git status`, which must not list them.
- Never paste them into chats or issues.
- If a key leaks, run `node tools/aws/deprovision-device.mjs --thing htm-01`, then provision again. The old certificate is deleted, so it stops working at once.
- Wi-Fi credentials are not in this file; the firmware asks for them at first boot (milestone 7).

**What the certificate is allowed to do** (device policy):
- connect only with client id = its thing name, and only while the certificate is attached to that thing;
- publish only to `tremor/v1/<its owner>/<its thing>/{telemetry,event,status}`;
- subscribe only to its own `cmd` and `viewer` topics.

## 5. See data arrive (simulator now, board in milestone 7)

```powershell
npm run sim -- --mqtt tools/aws/out/htm-01/devsim.json --minutes 10
```

*Expected:* `[devsim] connected to …-ats.iot.ap-south-1.amazonaws.com as htm-01`, then `event tremor_start`, `event episode`, … and a counter line every minute.

- **In the console:** **IoT Core → Test → MQTT test client → Subscribe** to `tremor/v1/#`. Telemetry appears every 5 s, plus events and the retained `status`.
- **Faster telemetry:** publish `{"v":1,"watching":true,"until":<now+60000 ms>}` to `tremor/v1/<owner>/htm-01/viewer` with **Retain** ticked. The simulator switches to 1 message per second until `until`.
- **In DynamoDB:** **Tables → TremorStack-Table… → Explore table items →** query with `pk = U#<identity id>`.
  - `T#htm-01#…` items are telemetry; they expire after 14 days.
  - `E#…` items are events.
  - `D#htm-01` is the device status.
  - `DAY#…` items appear after the hourly aggregator runs.

**With the board:** open `firmware/tremor_monitor` in the Arduino IDE with the generated `device_config.h` next to it, choose **Tools → Partition Scheme → Huge APP (3MB No OTA/1MB SPIFFS)** (the cloud code does not fit the default), upload, then give it Wi-Fi from the app (Settings → Headset, over Bluetooth; see `PHONE_SETUP.md`). The serial monitor shows `# WIFI connected`, `# TIME synchronised`, `# CLOUD connected`. Watch the same topics in the console.

## 6. App: sign in, live data, history, sync

1. **Get the setup link.** It carries your pool ids and addresses (nothing secret):
   ```powershell
   node tools/aws/app-link.mjs --app-url https://<your-name>.github.io/<repository>/
   ```
   The app must be served from an address you gave the stack: deploy with `-c appOrigins=http://localhost:5173,https://<your-name>.github.io/<repository>` (a path is allowed). With `-c withHosting=true` the stack hosts the app itself and `app-link` uses that address.
2. **Open the link on the phone** (or paste the code in the app: **Cloud** icon at the top, *Set up the cloud*). Check the details it shows (region, sign-in address, API address), then **Use this setup**. The app refuses any address that is not an AWS address for that region.
3. **Sign in.** The first time you choose *Create account* on the Cognito page (email and a password of 10 or more characters; the code arrives by email). You return to the app signed in. The app links your sign-in to your cloud identity automatically.
4. The **Headsets** card lists every headset that has reported. **Watch live** opens the Live screen on its data (a new summary every second while you watch, none of it saved on the phone). **Last 30 days** and **Recent events** come from the hourly aggregator and the event Lambda.
5. **Sync** uploads this phone's records to your account and downloads what your other devices uploaded. Medication names and doses are only included if you tick the box.
6. **Delete my cloud data** removes everything stored for you (and optionally the account).

*Expected:* `Signed in · demo@…`, your headset *Online* within a minute of it connecting, *Watch live* moving the 3D head, *Sync now* → "sent N records".

To try all of this **without AWS**, run `npm run cloudmock` and paste the code it prints: a local copy of the sign-in page, the API (the real Lambda code), the broker and the IoT rules, plus `npm run sim -- --mqtt tools/devsim/out/mock-device.json` for a simulated headset.

## 7. Test the whole cloud path without hardware

```powershell
node tools/aws/cloud-e2e.mjs --minutes 3
```

It creates a throw-away user and device, publishes the scripted showcase over MQTT/TLS for 3 minutes, runs the aggregator, checks every API route, then deletes the user, its data and the device. *Expected* (abridged):

```
  ✓ user e2e+…@example.invalid, identity ap-south-1:…
  ✓ POST /v1/me/link
  ✓ linking someone else's identity is refused
  ✓ API without a token is refused
  ...provisioning and simulator output...
  ✓ device registered (htm-e2e: offline)
  ✓ telemetry stored: 36 messages (expected about 36)
  ✓ events stored: tremor_start, episode, …, fall:pending, fall:no-response
  ✓ unanswered fall stored (a caregiver email should have been sent if alertEmail was set and confirmed)
  ✓ daily aggregate: 180 s monitored, 2 episodes, score not enough data (< 10 min)
  ✓ PUT /v1/sync
  ✓ GET /v1/sync
  ✓ DELETE /v1/me removed … items and the test account
PASS: the deployed cloud path works end to end.
```

If `alertEmail` was confirmed, a "possible fall" email arrives within a minute. That is expected: the script leaves the simulated fall unanswered on purpose.

## 8. Read the bill, and tear everything down

- **Usage and credits:**
  - **Billing and Cost Management → Free Tier** shows always-free usage against its limits.
  - **Credits** shows what has been used.
  - **Bills** (by service) and **Cost Explorer** (daily, by service) show the money. IoT Core lines appear as *AWS IoT*: connectivity, messaging, rules engine.
- **Emergency stop** (a device stuck in a publish loop, or an unexpected cost):
  ```powershell
  node tools/aws/killswitch.mjs            # disables all IoT rules; --enable to undo, --status to check
  ```
- **Tear down everything:**
  ```powershell
  node tools/aws/deprovision-device.mjs --thing htm-01 --delete-local   # for each device you provisioned
  cd infra; npx cdk destroy --force
  ```
  This deletes the table (**all cloud data**), users, API, rules, policies, the bucket and the distribution. Then, if you want nothing left:
  - delete the `CDKToolkit` stack in **CloudFormation**, after emptying its `cdk-hnb659fds-assets-…` bucket in S3;
  - delete the budget in **Budgets**.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cdk deploy`: *SSM parameter /cdk-bootstrap/hnb659fds/version not found* | Not bootstrapped in this region | Step 2, `cdk bootstrap aws://<acct>/ap-south-1` |
| `AccessDenied` / *not authorized to perform* during deploy or scripts | Using the restricted `aws-cli` user, or the SSO session expired | `$env:AWS_PROFILE="tremor-admin"`; `aws sso login --profile tremor-admin` |
| Deploy fails with *service not available for your account plan* | Free account plan restriction | Upgrade to the Paid plan in Billing (credits still apply), or contact support |
| `npm install` warns *allow-scripts … esbuild*, and bundling then fails | npm 11 blocked esbuild's install script | `npm approve-scripts esbuild`, then `npm install` again |
| Simulator/ESP32: TLS handshake fails, *certificate verify failed* | ESP32 clock not set (certificates look "not yet valid"); wrong endpoint type; wrong root CA | Firmware syncs NTP **before** TLS (milestone 7). Use the `-ats` endpoint from `describe-endpoint --endpoint-type iot:Data-ATS` with Amazon Root CA 1 |
| Connects, then is disconnected right away | Client id ≠ thing name; certificate not attached to the thing; policy not attached; certificate inactive | Re-run `provision-device.mjs --force`; in IoT Core → Security → Certificates check *Active* and the attached thing and policy |
| Connected, but publishing causes a disconnect, or nothing arrives | Topic doesn't match `tremor/v1/<owner attribute>/<thing>/…` (IoT Core disconnects clients for unauthorised publishes) | Check the thing's `owner` attribute equals the identity id in your topics (IoT Core → Things → htm-01 → Attributes) |
| Wrong region / *endpoint not found* | Device or CLI pointed at another region | Everything uses `ap-south-1`: `aws configure get region`, `--region ap-south-1` |
| Messages in the MQTT test client but no DynamoDB items | Rule `WHERE` rejected them (`v` missing, `ts` in seconds instead of ms, `tr` not 0/1) or the rules are disabled | Check the `RuleErrors` log group; `node tools/aws/killswitch.mjs --status`; validate payloads with `app/src/logic/protocol.ts` |
| Events stored but no caregiver email | SNS subscription not confirmed, email in spam, or alert throttled (one per kind per 30 min) | Confirm the subscription email; check SNS → Subscriptions shows *Confirmed* |
| API returns 401 | Missing or expired token, or an access token sent instead of the **ID token** | Send `Authorization: Bearer <IdToken>`; tokens last 1 h |
| API returns 409 *not linked* | The user hasn't linked their identity yet | `POST /v1/me/link` with the identity id (the app does this after sign-in) |
| Browser: *CORS* error | Page origin not in `appOrigins` | Redeploy with `-c appOrigins=http://localhost:5173,https://…` |
| Cognito hosted login: *redirect_mismatch* | Callback URL differs (they end with `/`) | Use exactly `<origin>/`; redeploy with the right `appOrigins` |
| Device shows offline although it runs | Wi-Fi drop; MQTT keep-alive (60 s) missed. The broker publishes the last will after about 1.5 × keep-alive | The ESP-IDF client reconnects by itself and republishes `online` (retained); **events** (not telemetry) wait in a 16-slot queue meanwhile |
| Browser live view stops after about an hour | Identity-pool credentials expire (1 h) | The app signs a fresh URL on every reconnect and retries up to 6 times; if it gives up, press *Watch live* again |
| Sign-in page says *redirect_mismatch* | The address you opened the app from is not in the stack's callback URLs | Redeploy with `-c appOrigins=…` including exactly that address (a path is fine), then `app-link` again |
| Cloud screen: *The setup … is not valid* | The link was cut off by a messenger | Copy the whole link, or use the bare code from `app-link` |
| Live view connects, then drops at once | The browser policy was not attached (linking failed) or the clock is wrong | Cloud → Refresh (it re-links); check the phone's date and time |
| Bill higher than expected | A device publishing at 1 Hz all day, or a loop | Cost Explorer by service; killswitch; check `rate` in the device status |
