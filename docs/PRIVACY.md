# Privacy

This app handles health-related personal data: head-motion patterns, heart rate, SpO₂, and later medication and symptom logs. This file lists what is stored, where, for how long, and how to delete it. It is updated in every milestone that changes the answer.

## On this device (milestones 1–5)

| Data | Where | Retention | How to delete |
|---|---|---|---|
| Settings (view, exaggeration, WebSocket address, sensitivity, text size, demo filter, **neutral head pose** (two angles), feature switches, threshold overrides) | Browser `localStorage`, key `htm.settings.v1` | Until deleted | Settings → Delete all my data, or clear site data |
| Sessions and tremor episodes (times, axis, frequency, amplitude, score, heart rate during the episode) | Browser IndexedDB `htm-local` | Until deleted | Settings → Delete all my data |
| One-second samples (orientation, stillness, posture deviation, tremor share, heart rate, SpO₂) | IndexedDB `htm-local` | 30 days, then deleted automatically | Settings → Delete all my data |
| Resting heart-rate and SpO₂ readings, with quality | IndexedDB `htm-local` | Until deleted | Settings → Delete all my data |
| Fall / impact candidates and your answer (I'm OK / help / no response) | IndexedDB `htm-local` | Until deleted | Settings → Delete all my data |
| Quick tags (coffee, stress, poor sleep, …, custom text) | IndexedDB `htm-local` | Until deleted | Delete on the Log screen, or Settings → Delete all my data |
| **Medication names and doses you type**, schedules, and your dose log | IndexedDB `htm-local` | Until deleted | Delete the medication (also deletes its log) on the Log screen, or Settings → Delete all my data |
| Doctor report PDF | Made in the browser and saved where **you** choose; the optional name is printed only, never stored | Your file | Delete the file |
| Snoozed reminders | Browser `sessionStorage` | Until the tab closes | Close the tab |
| Raw stream recordings | Only in files **you** download from the Live screen | Your files | Delete the files |
| Live sensor stream | Memory only (last 5 s for the charts) | Gone when the page closes | n/a |

Without cloud sign-in, nothing is sent to any server. Exports (JSON/CSV) are created in the browser and saved where you choose. The service worker caches only the app's own files and the bundled demo recording, for offline use. Data stored by a browser on a shared computer is readable by anyone using that browser profile.

## Headset and phone link (milestone 7)

| Data | Where | Notes |
|---|---|---|
| Wi-Fi network name and password you enter in Settings → Headset | sent once to the headset, stored in the **headset's flash memory**; not kept by the app (the field is cleared after sending) | sent over Bluetooth **unencrypted**, within a few metres, only while the headset accepts setup (first 10 minutes after power-up; always over USB). `!forget` over USB deletes it |
| Compass calibration (offsets and scale, no location) | headset flash | `!mag clear` forgets it |
| Bluetooth pairing | none: the app picks the headset by its service each time; Chrome remembers the permission per site | clear in Chrome's site settings |
| Cloud sign-in tokens (ID, access and refresh token) | this browser's `localStorage` | readable by script on this origin (the app loads no third-party scripts); deleted by **Sign out** |
| Cloud setup (pool ids, addresses; nothing secret) | `localStorage` | deleted by *Forget this cloud setup* |
| Time of last sync, "include medications" choice | `localStorage` | |
| Remote live view | memory only; **not saved on the phone** | |

Android lists Bluetooth scanning under "Location" on Android 11 and older; the app never reads your location.

## Cloud (milestone 6 backend, used by the app from milestone 7)

The cloud is **optional**. The app works fully signed out, and nothing leaves the phone unless you sign in and connect a headset to Wi-Fi. When you use it, data is stored in **your own AWS account** in `ap-south-1` (Mumbai, India); nobody else operates this backend.

| Data | Where | Retention | How to delete |
|---|---|---|---|
| Your email and password hash | Cognito user pool | Until the account is deleted | `DELETE /v1/me?account=true` (the app's "Delete my cloud account" in M7) |
| Telemetry summaries (every 5 s, 1 s while watched): orientation, tremor flag, frequency, amplitude, motion state, posture, heart rate, SpO₂ estimate, Wi-Fi signal, battery | DynamoDB | **14 days**, then deleted automatically (TTL; AWS removes expired items, usually within a few days) | `DELETE /v1/me` |
| Events: tremor starts, episodes with score, falls and their outcome, sensitivity changes, firmware version and time-zone offset | DynamoDB | Until deleted | `DELETE /v1/me` |
| Day summaries: monitored and tremor time, score, episode and fall counts, resting heart rate and SpO₂ | DynamoDB | Until deleted | `DELETE /v1/me` |
| Records you sync from the app (episodes, sessions, tags, **medication names and doses**, dose log, resting vitals, falls) | DynamoDB | Until deleted | `DELETE /v1/me` |
| Device registry: thing name, owner identity id, last seen, online | DynamoDB, IoT Core registry | Until the device is removed | `node tools/aws/deprovision-device.mjs --thing NAME` |
| Device status and "someone is watching" flag | IoT Core retained messages | Replaced on each update | Cleared by the deprovision script |
| Caregiver alert emails (possible fall, long episode, low SpO₂ estimate) | SNS → the email address you set at deploy time | In the recipient's mailbox | Unsubscribe link in the email, or redeploy without `alertEmail` |
| Function logs: counts, errors, identity id and thing name; up to 40 characters of a field that failed validation. The IoT rule error log holds the **full payload** of any message that could not be stored | CloudWatch Logs | **7 days** | Expire automatically |
| Per-device certificate and private key | Only on your computer (`tools/aws/out/`, git-ignored) and in the headset firmware | Until you delete them | Deprovision with `--delete-local` |

**Sharing with a doctor (optional, off until you do it).** Nobody can see your data unless you give them a one-time code from **Cloud → Share with my doctor**.
- **Who:** only an account an administrator added to the Cognito group `doctors` can use the doctor routes, and then only for patients who gave that doctor a code. Signing up in the app never makes anyone a doctor.
- **What the doctor sees:** your name or email as you gave it, headset status, daily scores, episode and fall counts, falls and tremor episodes with their outcome, resting heart rate and SpO₂ estimates, and the episodes you synced. **Not** tags, notes or the live view. **Medication names, doses and the dose log only if you tick "Also share my medication list and dose log" when you make the code** (and only what you synced with the medication box ticked); to change that, stop sharing and make a new code.
- **The code:** 10 characters, works once, valid for 24 hours, stored until it is used or expires. Anyone who has it before the doctor does could add themselves as a doctor if they hold a doctor account, so give it to your doctor in person or by phone.
- **How long:** you choose when you make the code: 30 days, 90 days (the default), 1 year, or until you stop it. When the time is up the doctor's access ends by itself and the link is removed.
- **Who looked:** the Cloud screen shows each doctor's access, how long it lasts, whether medications are shared, and when they last opened your data.
- **Doctor's notes:** a doctor can write private notes about you. They belong to the doctor, are stored under the doctor's account, and are **not** deleted when you stop sharing or delete your cloud data (clinical notes are the doctor's record). The patient cannot read them.
- **Stopping it:** **Stop sharing** (in the app) removes that doctor's access immediately; deleting your cloud data removes every doctor link. A doctor can also remove a patient from their own list.
- **Records of access:** the doctor's account id and email are stored with your data so you can see who has access, with the time of the last look. The API does not keep a log of every read.
- **Exports:** a doctor can download a patient's data as a CSV file. What they do with the file afterwards is outside this system.

**Protection:**
- **In transit:** TLS for everything. The device uses MQTT over TLS with its own X.509 certificate; the browser uses HTTPS and MQTT over WSS.
- **At rest:** AWS-managed encryption for DynamoDB and SNS.
- **Access:** each device can publish only under its owner's identity, and each signed-in user can read only their own topics and records (IoT policies with variables; no wildcard permissions).
- **Credentials:** the browser gets temporary credentials (1 h) from the identity pool. No long-lived AWS keys exist in the app or the firmware.
- **API:** requires a Cognito ID token, accepts only the configured origins (CORS), and is rate-limited.

**Deleting.** Cloud screen → *Delete my cloud data* (or *and account*) calls `DELETE /v1/me`: every telemetry, event, day summary and synced record under your identity, and the link between your sign-in and your identity (and the Cognito user if you chose that). It does not remove IoT things or certificates; use `tools/aws/deprovision-device.mjs` for that. No DynamoDB backups or point-in-time recovery are enabled, so deleted items are not kept anywhere else, apart from the 7-day logs above. Settings → *Delete all my data* deletes only this device's data.

**Sync is manual and selective.** Nothing is uploaded unless you press *Sync now*. Demo, replay and sample data are never uploaded. Medication names, doses and the dose log are uploaded only if you tick the box.

**Not a medical service:** alerts are best-effort emails from a prototype. They can be late, duplicated or missed, and must not be relied on for safety.
