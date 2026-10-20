# Telemetry protocol

Status: **v1 local line protocol: specified and implemented.** Cloud MQTT topics and schemas: milestone 6 (section 3 is a placeholder).

There are three tiers (see `ARCHITECTURE.md`):

| Tier | Rate | Path | Defined in |
|---|---|---|---|
| Local stream | 50 Hz | ESP32 → app over USB serial, LAN WebSocket, or BLE | Section 1 (this file) |
| Cloud telemetry | 0.2–1 Hz | ESP32 → AWS IoT Core (MQTT/TLS) | Section 3 (milestone 6) |
| Cloud events | on change | ESP32 → AWS IoT Core | Section 3 (milestone 6) |

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

## 3. Cloud MQTT (milestone 6)

To be defined with versioned topic names (`tremor/v1/{thingName}/…`), JSON schemas and example payloads for telemetry, events, status (last will) and commands. It will also cover validation in the IoT rule or Lambda.
