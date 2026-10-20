# Head Tremor Monitor

A prototype that tracks head tremor from a head-worn ESP32 + MPU6050, with heart rate and SpO₂ from a MAX30102. It has a phone-first web app (PWA) and an optional AWS backend for live telemetry, history and caregiver alerts.

> **Not a medical device.** This is a demonstration prototype. It does not diagnose anything, has not been clinically validated, and its SpO₂ value is an uncalibrated estimate from a hobby sensor.

## Status

| Milestone | State |
|---|---|
| 1. Skeleton, protocol parser, simulators, live 3D view (USB / WebSocket / demo) | **done** |
| 2. Local data (IndexedDB), episodes, severity score, history, demo replay | **done** |
| 3. Posture and stillness, fall detection (firmware ±8 g), resting vitals, combined-axis tremor | **done** |
| 4. Medication, tags, correlations, type hints | **done** |
| 5. Doctor report PDF | **done** |
| 6. AWS stack, provisioning, simulator to cloud, `docs/AWS_SETUP.md` | **done** (tested against local mocks; first real deployment pending, see below) |
| 7. Firmware Bluetooth / Wi-Fi / MQTT, installable phone app, cloud sign-in, live cloud view, history, sync | **done** (compiles and is tested in simulators; **not yet run on a real board or a real AWS account**) |
| 8. Compass (QMC5883P) yaw correction and calibration screen | **done** (same caveat) |
| 9. Polish, accessibility audit, final docs, stage demo script | **done** |

## On your phone (the goal)

**`docs/PHONE_SETUP.md`** takes you from the Arduino IDE to the app installed on an Android phone, reading the headset over Bluetooth:
flash `firmware/tremor_monitor` (libraries: MAX3010x, NimBLE-Arduino, WebSockets) → publish the app (the `Publish app (GitHub Pages)` workflow, or upload `app/dist` anywhere with https) → open it in Chrome → *Install app* → connection button → **Bluetooth** → `HeadTremor-XXXX`.

## Quick start (about 10 minutes, no hardware needed)

Requirements: Node 20+ and Git. For the firmware simulator you also need g++ (MSYS2 on Windows). A Chromium browser is needed for USB.

```bash
npm install
npm run dev                  # app on http://localhost:5173
```

1. Open http://localhost:5173, tap the connection pill (top right) and choose **Demo mode**. The scripted 2-minute showcase plays: still, a "no-no" tremor, walking, a "yes-yes" tremor, finger off the pulse sensor. Or choose **Replay a recording → Showcase**, which plays real firmware output recorded in the host simulator.
2. Open **Trends**. Every connection is saved on the device as a session, and tremor alerts become scored episodes. For a fuller picture, use **Settings → Load 4 weeks of sample history** (clearly marked as sample data, removable).
3. Try the optional **cloud** screens with no AWS account: `npm run cloudmock` in a second terminal, paste the code it prints on the **Cloud** screen (cloud icon at the top), sign in, and start a simulated headset with `npm run sim -- --mqtt tools/devsim/out/mock-device.json`.
4. To stream like a real device over WebSocket, run in a second terminal:
   ```bash
   npm run sim -- --ws                                     # synthetic showcase on ws://localhost:8787
   npm run hostsim                                         # builds the real sketch for the host (first time)
   npm run sim -- --ws --hostsim tremor_no_4.5hz_6dps      # the real firmware's output
   ```
   In the app choose **Wi-Fi or simulator**.
5. With the board on USB (desktop Chrome or Edge), flash `firmware/tremor_monitor` (see `firmware/README.md`), close the Serial Monitor, and choose **USB cable**.

## Cloud (optional)

The app never needs AWS. To try the backend in your own account (about 45 minutes the first time; typically well under US$1 a month, see `docs/COSTS.md`), follow **`docs/AWS_SETUP.md`**. In short:

```bash
npm run test -w infra && npm run cdk:synth           # offline: stack template + cloud path against local mocks
cd infra && npx cdk bootstrap && npx cdk deploy --outputs-file ../tools/aws/out/outputs.json
node tools/aws/cloud-e2e.mjs --minutes 3             # throw-away user + device, simulator over MQTT/TLS, API checks, cleanup
node tools/aws/killswitch.mjs                        # emergency stop: disables the IoT rules
cd infra && npx cdk destroy                          # remove everything
```

Certificates, keys and stack outputs are written to `tools/aws/out/` and `firmware/tremor_monitor/device_config.h`, both git-ignored.

## Checks

```bash
npm test                     # unit tests (app, device simulator incl. MQTT against a local broker, infra)
npm run lint && npm run typecheck
npm run cdk:synth                         # CloudFormation template builds
npm run build && npm run size -w app      # bundle budget
node tools/hostsim/run.mjs --check        # detector regression against the legacy baseline
npm run e2e:local -w app                  # real firmware -> devsim -> app in a browser (needs npm run dev)
npm run e2e:history -w app                # replay -> recorder -> IndexedDB -> Trends (needs npm run dev)
npm run e2e:report -w app                 # sample history -> Report -> downloaded PDF checked (needs npm run dev)
npm run e2e:log -w app                    # medication due now -> reminder -> Taken; tags; Insights results (needs npm run dev)
npm run e2e:device -w app                 # fake Bluetooth headset streaming real firmware output; Wi-Fi setup; compass calibration (needs npm run dev)
npm run e2e:cloud -w app                  # setup code, sign-in, live view through the cloud, history, sync, delete, against cloudmock (needs npm run dev)
npm run hostsim:cloud                     # the firmware's C++ cloud reporter vs the TypeScript reference
node tools/hostsim/compass-check.mjs      # compass calibration, drift, disturbance, mirrored mounting
npm run e2e:fall -w app                   # demo fall -> alert -> I'm OK / no response -> Trends (needs npm run dev)
node tools/hostsim/make-fixtures.mjs      # regenerate firmware-output test fixtures after a firmware change
npm run screenshots -w app                # docs/screenshots at phone and desktop width
```

## Layout

```
firmware/   ESP32 sketch (Arduino IDE)          app/     React + Vite + three.js PWA
tools/      hostsim (firmware on the host), devsim (stream simulator, MQTT), aws (provisioning, kill switch, cloud e2e)
infra/      AWS CDK stack and Lambdas (TypeScript)
docs/       PHONE_SETUP, DEMO_SCRIPT, ACCESSIBILITY, ORIENTATION, ARCHITECTURE, TELEMETRY_PROTOCOL, SEVERITY, FALLS_POSTURE_VITALS, INSIGHTS_AND_MEDICATION, REPORT, DATA_MODEL, DETECTOR_BASELINE, HEAD_MODEL, PRIVACY, COSTS, AWS_SETUP
legacy/     the original sketch and page (read-only reference)
```
