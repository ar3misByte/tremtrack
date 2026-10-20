# Head Tremor Monitor

A prototype that tracks head tremor from a head-worn ESP32 + MPU6050, with heart rate and SpO₂ from a MAX30102. It has a phone-first web app (PWA) and, in later milestones, an AWS backend for live telemetry and history.

> **Not a medical device.** This is a demonstration prototype. It does not diagnose anything, has not been clinically validated, and its SpO₂ value is an uncalibrated estimate from a hobby sensor.

## Status

| Milestone | State |
|---|---|
| 1. Skeleton, protocol parser, simulators, live 3D view (USB / WebSocket / demo) | **done** |
| 2. Local data (IndexedDB), episodes, severity score, history, demo replay | **done** |
| 3. Posture and stillness, fall detection (firmware ±8 g), resting vitals, combined-axis tremor | **done** |
| 4. Medication, tags, correlations, type hints | next |
| 5. Doctor report PDF | |
| 6. AWS stack, provisioning, simulator to cloud, `docs/AWS_SETUP.md` | |
| 7. Firmware Wi-Fi / BLE / MQTT, live cloud view, sync | |
| 8. Magnetometer yaw fusion and calibration UI | |
| 9. Polish, accessibility, final docs, stage demo script | |

## Quick start (about 10 minutes, no hardware needed)

Requirements: Node 20+ and Git. For the firmware simulator you also need g++ (MSYS2 on Windows). A Chromium browser is needed for USB.

```bash
npm install
npm run dev                  # app on http://localhost:5173
```

1. Open http://localhost:5173, tap the connection pill (top right) and choose **Demo mode**. The scripted 2-minute showcase plays: still, a "no-no" tremor, walking, a "yes-yes" tremor, finger off the pulse sensor. Or choose **Replay a recording → Showcase**, which plays real firmware output recorded in the host simulator.
2. Open **Trends**. Every connection is saved on the device as a session, and tremor alerts become scored episodes. For a fuller picture, use **Settings → Load 4 weeks of sample history** (clearly marked as sample data, removable).
3. To stream like a real device over WebSocket, run in a second terminal:
   ```bash
   npm run sim -- --ws                                     # synthetic showcase on ws://localhost:8787
   npm run hostsim                                         # builds the real sketch for the host (first time)
   npm run sim -- --ws --hostsim tremor_no_4.5hz_6dps      # the real firmware's output
   ```
   In the app choose **Wi-Fi or simulator**.
4. With the board on USB (desktop Chrome or Edge), flash `firmware/tremor_monitor` (see `firmware/README.md`), close the Serial Monitor, and choose **USB cable**.

## Checks

```bash
npm test                     # unit tests (app + device simulator)
npm run lint && npm run typecheck
npm run build && npm run size -w app      # bundle budget
node tools/hostsim/run.mjs --check        # detector regression against the legacy baseline
npm run e2e:local -w app                  # real firmware -> devsim -> app in a browser (needs npm run dev)
npm run e2e:history -w app                # replay -> recorder -> IndexedDB -> Trends (needs npm run dev)
npm run e2e:fall -w app                   # demo fall -> alert -> I'm OK / no response -> Trends (needs npm run dev)
node tools/hostsim/make-fixtures.mjs      # regenerate firmware-output test fixtures after a firmware change
npm run screenshots -w app                # docs/screenshots at phone and desktop width
```

## Layout

```
firmware/   ESP32 sketch (Arduino IDE)          app/     React + Vite + three.js PWA
tools/      hostsim (firmware on the host), devsim (stream simulator)
docs/       ARCHITECTURE, TELEMETRY_PROTOCOL, SEVERITY, FALLS_POSTURE_VITALS, DATA_MODEL, DETECTOR_BASELINE, HEAD_MODEL, PRIVACY, COSTS, AWS_SETUP
legacy/     the original sketch and page (read-only reference)
```
