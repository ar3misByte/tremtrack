# Data model

Status:
- **Local (IndexedDB): implemented in milestone 2, extended in milestones 3 and 4 (database version 3).**
- **Cloud (DynamoDB single table): implemented in milestone 6** (see the last section).

Types: `app/src/logic/model.ts`. Storage: `app/src/data/db.ts`. Writer: `app/src/data/recorder.ts`.

## Local database `htm-local` (version 3)

| Store | Key | Indexes | Holds | Kept |
|---|---|---|---|---|
| `sessions` | `id` | `start` | one row per connection: source, start/end, monitored time, tremor and walking time, episode count, sensitivity, `open`; v2 adds still, restless, pose-monitored and outside-range seconds | until deleted |
| `episodes` | `id` | `start`, `sessionId` | one row per stored tremor episode: times, duration, dominant axis and axis shares, **all axes involved, per-axis share and amplitude, pattern (single / diagonal / circular / two rhythms / mixed)**, amplitude (combined across axes), peak, frequency, displacement, band share, cycles, walking share, heart rate, score and its version, sensitivity | until deleted |
| `samples` | `[sessionId, t]` | `t` | one row per second: mean orientation, orientation spread, motion state (still / normal / restless / walking), posture deviation and zone vs the neutral pose, tremor share, shaking-axes mask, max band amplitude, frequency, walking share, last valid heart rate and SpO₂, highest PPG state | 30 days (`STORAGE.sampleRetentionDays`), pruned at start-up |
| `vitals` (v2) | `id` | `t` | resting heart-rate / SpO₂ readings: median bpm and SpO₂ of a 30 s window after ≥ 3 min of low motion, valid share, bpm IQR, motion, rested time, quality (good / fair / poor) | until deleted |
| `tags` (v3) | `id` | `t` | quick tags: time, kind (coffee, poor sleep, stress, exercise, alcohol, meal, custom), custom label | until deleted |
| `meds` (v3) | `id` | – | medication schedules: free-text name and dose, times (HH:MM), weekdays, active, created | until deleted |
| `doses` (v3) | `id` = `medId@scheduledFor` (one log per scheduled dose) or a random id for extra doses | `loggedAt` | dose log: scheduled time, taken time or skipped, when logged | until deleted (deleted with its medication) |
| `events` (v2) | `id` | `t` | fall / impact candidates: impact time, rule path, peak g, free-fall ms, orientation change, outcome (pending / cancelled / confirmed / no-response), caregiver alert state | until deleted |

Rows written before version 2 lack the new optional fields; the app treats them as single-axis episodes and sessions without posture data. All rows carry `demo: true` when the source is demo mode, a replay, or the generated sample history, so they can be hidden from Trends and deleted separately.

## How rows are produced

```
frame (50 Hz) ──> SessionTracker (logic/tracker.ts, pure)
                     ├─ session counters (monitored time excludes gaps > 1 s)
                     ├─ episode: opens on alert, merges gaps < 3 s, dropped if < 1 s
                     └─ 1 s sample
recorder (data/recorder.ts): flush every 5 s in one transaction; close the session after 10 s
without data or on disconnect; sessions left open by a closed tab are closed at the next start.
```

Days are local calendar days (`logic/daily.ts`). A session's monitored time is split across midnight in proportion to its wall-clock span.

## Exports
- **JSON:** every store, with format and version fields.
- **CSV:** episodes, and daily summaries (score, episodes, tremor and monitored seconds, share, axis counts).

## Cloud: DynamoDB single table (milestone 6)

One table (`TremorStack-Table…`, `ap-south-1`), keys `pk` / `sk` (strings), TTL attribute `ttl`.
- **Capacity:** provisioned 10 RCU / 15 WCU, inside the always-free 25 / 25.
- **Encryption:** AWS-managed encryption at rest.
- **Access:** no scans anywhere; every read is a key query.
- **Code:** keys in `infra/lambda/shared.ts`; writers are the IoT rules (`infra/lib/stack.ts`) and the Lambdas.

`owner` is the user's Cognito **identity id**, `sub` the user-pool subject, `ts13` a millisecond timestamp padded to 13 digits so that keys sort by time.

| Item | `pk` | `sk` | Written by | Holds | Expires |
|---|---|---|---|---|---|
| Telemetry | `U#owner` | `T#thing#ts13` | rule `tremor_telemetry` | the telemetry message as sent, plus `thing` | **14 days** (TTL) |
| Event | `U#owner` | `E#ts13#thing#seq` | events Lambda | validated event (tremor start, episode, fall, sensitivity, boot), `thing` | kept |
| Device status | `U#owner` | `D#thing` | rule `tremor_status` | `online`, `fw`, `tzMin`, `rate`, `lastSeen` | kept until the device is removed |
| Day summary | `U#owner` | `DAY#yyyy-mm-dd` (the user's local day) | hourly aggregator | one `hHH_thing` bucket per completed hour (monitored, tremor, walking, still, restless seconds; heart-rate and SpO₂ sums and counts, overall and at rest), and the day's totals: `score` (same formula as the app), `episodes`, `combinedEpisodes`, `falls`, `maxEpisodeScore`, `restingBpm`, `restingSpo2` (only with ≥ 30 still readings), `meanBpm` | kept |
| Alert throttle | `U#owner` | `N#kind` | events Lambda, aggregator | when the last alert of this kind was sent | 30 min (low SpO₂: 2 days) |
| Synced app records | `U#owner` | `EP#ts13#id`, `SE#…`, `TG#…`, `MD#id`, `DS#id`, `RV#…`, `FE#…` | `PUT /v1/sync` | the app's own rows (episodes, sessions, tags, medications, doses, resting vitals, falls), each ≤ 8 KB | kept until deleted |
| Profile link | `P#sub` | `PROFILE` | `POST /v1/me/link` | the identity id this sign-in owns, after the API checked it with Cognito | kept until the account is deleted |
| Share code | `SHARE#code` | `CODE` | `POST /v1/share` | `owner`, `label` (the name the doctor will see), `expiresAt` (24 h); deleted when used | 48 h (TTL) |
| Doctor access (patient side) | `U#owner` | `ACC#doctorSub` | `POST /v1/doctor/patients` | the doctor's sub and email, since when | until the patient or doctor removes it, or the patient deletes their data |
| Doctor access (doctor side) | `DOC#doctorSub` | `PT#owner` | `POST /v1/doctor/patients` | `label`, `since`; every doctor read checks this item | same |
| Device registry | `DEVICES` | `thing` | rule `tremor_status` | `owner`, `lastSeen`, `tzMin`, `online`, `aggHour` (the aggregator's cursor) | kept until the device is removed |

**Access patterns, all queries:**
- **Live history:** `pk = U#owner AND sk BETWEEN T#thing#from AND T#thing#to`, at most 6 hours per request.
- **Events:** `sk BETWEEN E#from AND E#to~`.
- **Days:** `sk BETWEEN DAY#from AND DAY#to`.
- **Sync:** `begins_with(sk, prefix)`.
- **Aggregator:** queries the `DEVICES` partition, then each active device's telemetry one hour at a time.

**Idempotency:**
- Telemetry and events have deterministic keys, so a redelivered message overwrites itself.
- The aggregator overwrites whole hour buckets, then recomputes the totals from the buckets, so re-runs and retries give the same day.

**Deleting:** `DELETE /v1/me` deletes every `U#owner` item and the profile link. With `?account=true` it also deletes the Cognito user. Devices are removed with `tools/aws/deprovision-device.mjs`.
