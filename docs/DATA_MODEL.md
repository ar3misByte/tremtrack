# Data model

Status:
- **Local (IndexedDB): implemented in milestone 2.**
- Milestone 4 adds tags, medications and doses.
- Milestone 6 adds the DynamoDB single-table design.

Types: `app/src/logic/model.ts`. Storage: `app/src/data/db.ts`. Writer: `app/src/data/recorder.ts`.

## Local database `htm-local` (version 1)

| Store | Key | Indexes | Holds | Kept |
|---|---|---|---|---|
| `sessions` | `id` | `start` | one row per connection: source, start/end, monitored time, tremor and walking time, episode count, sensitivity, `open` | until deleted |
| `episodes` | `id` | `start`, `sessionId` | one row per stored tremor episode: times, duration, dominant axis and axis shares, mean/peak amplitude, frequency, displacement, band share, cycles, walking share, heart rate, score and its version, sensitivity | until deleted |
| `samples` | `[sessionId, t]` | `t` | one row per second: mean orientation, orientation spread (stillness), tremor share, max band amplitude, frequency, walking share, last valid heart rate and SpO₂, highest PPG state | 30 days (`STORAGE.sampleRetentionDays`), pruned at start-up |

All rows carry `demo: true` when the source is demo mode, a replay, or the generated sample history, so they can be hidden from Trends and deleted separately.

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
