# Data model

Status: **skeleton.**
- Milestone 2 adds the local IndexedDB stores: sessions, episodes, daily aggregates, settings.
- Milestone 4 adds tags, medications and doses.
- Milestone 6 adds the DynamoDB single-table design: keys, GSIs, TTL on raw telemetry, and access patterns.

The local live frame is documented in `TELEMETRY_PROTOCOL.md` and typed in `app/src/logic/csv.ts` (`Frame`).
