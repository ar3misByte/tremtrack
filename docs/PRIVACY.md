# Privacy

This app handles health-related personal data: head-motion patterns, heart rate, SpO₂, and later medication and symptom logs. This file lists what is stored, where, for how long, and how to delete it. It is updated in every milestone that changes the answer.

## Current state (milestone 2)

| Data | Where | Retention | How to delete |
|---|---|---|---|
| Display settings (view, exaggeration, WebSocket address, sensitivity, text size, demo filter) | Browser `localStorage`, key `htm.settings.v1` | Until deleted | Settings → Delete all my data, or clear site data |
| Sessions and tremor episodes (times, axis, frequency, amplitude, score, heart rate during the episode) | Browser IndexedDB `htm-local` | Until deleted | Settings → Delete all my data |
| One-second samples (orientation, stillness, tremor share, heart rate, SpO₂) | IndexedDB `htm-local` | 30 days, then deleted automatically | Settings → Delete all my data |
| Raw stream recordings | Only in files **you** download from the Live screen | Your files | Delete the files |
| Live sensor stream | Memory only (last 5 s for the charts) | Gone when the page closes | n/a |

Nothing is sent to any server. Exports (JSON/CSV) are created in the browser and saved where you choose. The service worker caches only the app's own files and the bundled demo recording, for offline use. Data stored by a browser on a shared computer is readable by anyone using that browser profile.

## Planned
- Milestone 6: optional cloud sync to DynamoDB in `ap-south-1`, only when signed in. Encrypted in transit and at rest. Raw 1 Hz telemetry expires automatically (TTL); retention periods will be listed here. Cloud deletion will be added to "delete all my data".
