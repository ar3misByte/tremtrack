# Telemetry protocol

Status: **v1 local line protocol: specified and implemented. v1 cloud MQTT protocol (section 3): specified and implemented in the simulator and the backend (milestone 6); firmware in milestone 7.**

There are three tiers (see `ARCHITECTURE.md`):

| Tier | Rate | Path | Defined in |
|---|---|---|---|
| Local stream | 50 Hz | ESP32 → app over USB serial, LAN WebSocket, or BLE | Section 1 (this file) |
| Cloud telemetry | 0.2–1 Hz | ESP32 → AWS IoT Core (MQTT/TLS) | Section 3 |
| Cloud events | on change | ESP32 → AWS IoT Core | Section 3 |

Raw 50 Hz data is **never** sent to the cloud.

## 1. Local line protocol (v1)

Text lines terminated by `\n` (a trailing `\r` is ignored). USB serial at 115200 baud, 50 lines/s. The WebSocket and BLE transports (milestone 7) carry the same lines; one WebSocket message may contain several lines.

### Data line

```
$,pitch,roll,yaw,fPitch,fRoll,fYaw,tremor,dir,ampP,ampR,ampY,freq,q,walking,stepHz,cycles,bpm,spo2,ppgState,pulse,axes,aMax,aMin
```

| # | Field | Unit / values | Since |
|---|---|---|---|
| 1–3 | pitch, roll, yaw | degrees. Pitch and roll from a complementary filter; yaw integrated from the gyro (drifts) | 13-value shape |
| 4–6 | fPitch, fRoll, fYaw | band-passed gyro (2.5–10 Hz), °/s | 13-value shape |
| 7 | tremor | 0 / 1 | 13-value shape |
| 8 | dir | 0 = pitch ("yes-yes"), 1 = roll (tilt), 2 = yaw ("no-no"): the alerting axis, else the strongest | 13-value shape |
| 9–11 | ampP, ampR, ampY | peak band amplitude in 3.5–8.5 Hz, °/s | 13-value shape |
| 12 | freq | Hz of the `dir` axis (0 until the window is ready) | 13-value shape |
| 13 | q | share of energy in the band, 0..1 | 13-value shape |
| 14 | walking | 0 / 1 | 16-value shape |
| 15 | stepHz | steps per second while walking, else 0 | 16-value shape |
| 16 | cycles | consistent cycles found in the window | 16-value shape |
| 17 | bpm | beats/min, 0 = no valid reading | 20-value shape |
| 18 | spo2 | %, 0 = no valid reading. Uncalibrated estimate | 20-value shape |
| 19 | ppgState | 0 no sensor, 1 no finger, 2 measuring, 3 valid | 20-value shape |
| 20 | pulse | filtered IR wave, arbitrary units | 20-value shape |
| 21 | axes | bit mask of axes shaking now: 1 pitch, 2 roll, 4 yaw (e.g. 5 = yes-yes + no-no). 0 without tremor. Always includes `dir` while `tremor` = 1 | 23-value shape (milestone 3) |
| 22 | aMax | largest \|a\| (g) over the 100 Hz samples since the previous line (±8 g range) | 23-value shape |
| 23 | aMin | smallest \|a\| (g) over the same samples | 23-value shape |

**Compatibility rule:** new fields are only ever **appended**. Parsers must accept 13, 16, 20 and 23 values, and keep any further values as "extra". Without `axes`, the app derives the mask from `tremor` and `dir`; without `aMax`/`aMin`, fall detection is off. Older parsers, like `legacy/tremor_circle.html`, ignore the extra values. Implemented and tested in `app/src/logic/csv.ts`.

Example (23 values, "no-no" with "yes-yes" at 5.5 Hz, about 1 g):

```
$,12.3,-4.5,30.1,6.10,-0.50,8.75,1,2,7.2,0.3,9.8,5.5,0.82,0,0.00,7,74,97,3,-12.4,5,1.03,0.97
```

### Status line

`#` followed by human-readable text, e.g. `# Calibrating: keep the board still for 2 seconds...`. The app shows the latest one; nothing parses its content.

### Commands (app → device)

| Bytes | Meaning | Device reply |
|---|---|---|
| `1`…`5` | tremor sensitivity (1 strict, 2 default, 5 very sensitive) | `# Sensitivity N` |

## 1b. Recording file (.rec)

A raw stream saved by the app (Live → Record the raw stream) or made by `tools/hostsim/make-recording.mjs`. Plain text, usually gzipped:

```
#REC v1 start=2026-10-20T08:00:00.000Z source=serial
0	# Tremor Stream starting
20	$,1.2,0.4,...
```

Each line is the offset in ms from `start`, a tab, then the protocol line exactly as received. Implemented in `app/src/logic/recording.ts`.

## 2. Planned local additions

These are not implemented yet. Each will be appended to the data line and listed in the table above when it lands:
- Milestone 8: magnetometer heading quality flag.

(Posture deviation is computed in the app from pitch and roll against the calibrated neutral pose, so it needs no protocol field.)

## 3. Cloud MQTT, version 1 (milestone 6)

Single source of truth: `app/src/logic/protocol.ts` (types and validators). The device simulator, the Lambdas and the app all import it; the firmware implements the same spec in milestone 7. **No raw 50 Hz data is ever sent to the cloud.** The device sends a summary every 5 s, or every 1 s while someone watches.

### Topics

`tremor/v1/{owner}/{thing}/{kind}`

- `owner`: the user's Cognito identity id, for example `ap-south-1:3f2c…`. It is stored as the thing attribute `owner` when the device is provisioned, and the device policy reads it from there, so a device can never publish under another user.
- `thing`: the IoT thing name, which is also the device's MQTT client id.

| Kind | Direction | QoS | Retained | Sent when |
|---|---|---|---|---|
| `telemetry` | device → cloud | 0 | no | every `per` seconds (5, or 1 while watched) |
| `event` | device → cloud | 1 | no | tremor start, episode end, fall (pending, then the outcome), sensitivity change, boot |
| `status` | device → cloud | 1 | **yes** | on connect (`online: true`), every 15 min, and as the **last will** (`online: false`) |
| `cmd` | app → device | 1 | no | change sensitivity or rate |
| `viewer` | app → device | 1 | **yes** | the live cloud view opens (`watching: true, until`); the app renews it while open (milestone 7) |

A version change means a new prefix (`tremor/v2/…`), so old and new devices can run side by side. Fields may be **added** within v1, but the validators reject unknown fields, so a new field goes into `protocol.ts` (and this table) before any device sends it.

### Telemetry

Example (5 s period, a "no-no" tremor in progress), 200 bytes:

```json
{"v":1,"seq":412,"ts":1792483205000,"per":5,"p":-3.1,"r":1.4,"y":12.0,"tr":1,"ax":4,"dir":2,"f":4.6,"a":7.9,
 "sev":3.2,"wk":0,"hr":74,"sp":97,"ppg":3,"pf":2.5,"pt":-1.0,"st":"normal","rssi":-61,"bat":null}
```

| Field | Type / range | Meaning |
|---|---|---|
| `v` | 1 | protocol version |
| `seq` | integer ≥ 0 | increments per message; gaps show lost messages |
| `ts` | ms since epoch (UTC), 2024–2100 | end of the summarised period |
| `per` | 0.2–60 s | seconds summarised |
| `p`, `r`, `y` | degrees | mean pitch, roll, yaw over the period |
| `tr` | 0 / 1 | tremor alert on at the end of the period |
| `ax` | 0–7 | shaking-axes mask: 1 pitch, 2 roll, 4 yaw |
| `dir` | 0 / 1 / 2 | strongest axis |
| `f` | 0–30 Hz | tremor frequency (0 = none) |
| `a` | 0–2000 deg/s | band amplitude, combined across shaking axes |
| `sev` | 0–10 | severity of the episode in progress so far (0 = none); same formula as `SEVERITY.md` |
| `wk` | 0 / 1 | walking |
| `hr`, `sp` | bpm 20–250 / % 50–100, or null | last valid heart rate and SpO₂ estimate |
| `ppg` | 0–3 | pulse sensor state, as in the line protocol |
| `pf`, `pt` | degrees, or null | posture against the calibrated neutral pose (forward, side); null = not calibrated |
| `st` | `still` / `normal` / `restless` / `walking` | motion state |
| `rssi` | dBm, or null | Wi-Fi signal |
| `bat` | %, or null | battery; null = mains or unknown |

Maximum 512 bytes (one 5 KB IoT metering unit).

### Events

Every event has `v`, `seq`, `ts` and `type`, plus:

| `type` | Fields | Example |
|---|---|---|
| `tremor_start` | `ax` (1–7), `f` | `{"v":1,"seq":7,"ts":1792483201000,"type":"tremor_start","ax":4,"f":4.6}` |
| `episode` | `ep`: `start`, `end`, `durationS`, `axes` [0–2], `pattern` (single / diagonal / circular / independent / mixed), `ampDps`, `freqHz`, `score`, `bpm` | `{"v":1,"seq":8,"ts":1792483230000,"type":"episode","ep":{"start":1792483201000,"end":1792483229000,"durationS":28,"axes":[2],"pattern":"single","ampDps":7.9,"freqHz":4.6,"score":3.4,"bpm":74}}` |
| `fall` | `fall`: `t`, `path` (freefall+impact / impact), `peakG`, `freeFallMs`, `orientationChangeDeg`, `outcome` | sent twice: `pending` at detection, then `cancelled` / `confirmed` / `no-response` |
| `sensitivity` | `level` 1–5 | after a `cmd` or a local change |
| `boot` | `fw` (≤ 40 chars), `tzMin` (−720…840) | the time-zone offset sets the user's local day in the cloud |

Maximum 2 KB.

### Status, commands, viewer

```json
{"v":1,"online":true,"ts":1792483000000,"fw":"htm-0.7.0","tzMin":330,"rate":0.2}    status (retained)
{"v":1,"online":false}                                                               last will (retained)
{"v":1,"sens":3}                       cmd: sensitivity 1-5     {"v":1,"rate":1}   cmd: telemetry rate (0.2 or 1 Hz)
{"v":1,"watching":true,"until":1792483265000}                                        viewer (retained)
```

The device sends 1 Hz telemetry while `watching` is true and `until` lies in the future, then drops back to 0.2 Hz on its own. A forgotten browser tab therefore cannot keep the rate high, which keeps cost bounded (`COSTS.md`).

### Validation and where it happens

| Where | What is checked |
|---|---|
| IoT policy | the device publishes only under its own `owner`/`thing`; the browser only under its own identity |
| `tremor_telemetry` rule SQL | `v = 1`, `seq` and `ts` are numbers, `ts` within 2024–2100 in **milliseconds**, `per` is a number, `tr` is 0 or 1. Anything else is dropped. Failed actions go to the `RuleErrors` log group |
| events Lambda | the full `validateEvent` schema; invalid events are logged and dropped |
| API (`GET /v1/telemetry`) | items are returned as stored; the app validates with `validateTelemetry` on display |
| tests | `protocol.test.ts` (schemas, sizes, message rate), `infra/test/cloud.e2e.test.ts` (a TypeScript mirror of the rule SQL) |

### Rules (IoT Core → storage)

| Rule | Topic filter | Action |
|---|---|---|
| `tremor_telemetry` | `tremor/v1/+/+/telemetry` | DynamoDB `pk=U#owner`, `sk=T#thing#ts`, `ttl` = now + 14 days |
| `tremor_status` | `tremor/v1/+/+/status` | DynamoDB `D#thing` under the user, and the `DEVICES` registry row |
| `tremor_events` | `tremor/v1/+/+/event` | events Lambda: stores `E#…`, sends caregiver emails (fall confirmed or unanswered; episode ≥ 10 min), one per kind per 30 min |
