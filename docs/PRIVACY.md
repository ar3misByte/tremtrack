# Privacy

This app handles health-related personal data: head-motion patterns, heart rate, SpO₂, and later medication and symptom logs. This file lists what is stored, where, for how long, and how to delete it. It is updated in every milestone that changes the answer.

## Current state (milestone 1)

| Data | Where | Retention | How to delete |
|---|---|---|---|
| Display settings (view mode, exaggeration, WebSocket address, sensitivity, text size) | Browser `localStorage`, key `htm.settings.v1` | Until cleared | Clear site data in the browser |
| Live sensor stream | Memory only (last 5 s for the charts) | Gone when the page closes | n/a |

Nothing is sent to any server. The service worker caches only the app's own files, for offline use.

## Planned
- Milestone 2: episodes and session history in IndexedDB on the device, export (JSON/CSV) and "delete all my data".
- Milestone 6: optional cloud sync to DynamoDB in `ap-south-1`, only when signed in. Encrypted in transit and at rest. Raw 1 Hz telemetry expires automatically (TTL); retention periods will be listed here. Cloud deletion will be added to "delete all my data".
