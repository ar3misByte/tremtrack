# Data model

Status:
- **Local (IndexedDB): implemented in milestone 2, extended in milestones 3 and 4 (database version 3).**
- Milestone 6 adds the DynamoDB single-table design.

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
