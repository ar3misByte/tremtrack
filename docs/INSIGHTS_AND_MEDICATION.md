# Medication, tags and Insights (milestone 4)

Nothing on these screens is medical advice, a diagnosis, or evidence of a cause.
- **Code:** `app/src/logic/meds.ts`, `correlate.ts`, `stats.ts`, `hints.ts`; the hint table is in `app/src/config/hints.ts`.
- **Thresholds:** `app/src/config/thresholds.ts` (`TAGS`, `CORRELATION`, `MEDS`, `HINTS`).
- **Tests:** `app/src/logic/m4.test.ts`, plus the end-to-end test `npm run e2e:log -w app`.

## Medication schedule and reminders

- **Schedule:** a free-text name and dose (shown back to you only), times of day, and weekdays (or every day). A medication can be paused.
- **Dose states:**
  - **taken:** logged within 30 min of the scheduled time;
  - **late:** taken more than 30 min after it;
  - **skipped**;
  - **missed:** nothing logged 2 h after the time;
  - **due / upcoming:** not yet in the past.

  Extra, unscheduled doses can be logged.
- **Adherence:** taken ÷ scheduled doses that are no longer due or upcoming, over 7 and 30 days. Paused medications are not counted.
- **Reminders:**
  - an in-app banner on every screen, with Taken / snooze 10 min / Skip;
  - a browser notification, if you allow them.

  A web app cannot remind you while it is **closed**: there is no push server. Email reminders through AWS SNS arrive with the cloud backend (milestone 6). The Log screen says so.
- **The app does not** suggest doses, check interactions, or comment on any medication.

## Comparisons on the Insights screen

**Measure.** The share of monitored time with a tremor episode inside a window. Monitored time comes from the sessions overlapping the window, so time without the headset doesn't count. A window needs at least 50 % monitoring to be used.

**Tags vs time-of-day-matched baseline.**
- For each tag, the window after it (coffee 30–180 min, alcohol 30–240, stress / exercise / meal / custom 0–120, poor sleep 0–720) is compared with **the same clock-time window on other days without a tag of that kind** (up to ±14 days, at least 60 min from such tags).
- Mornings are therefore compared with mornings. The first version tiled all other monitored time, which mixed in time-of-day effects and gave long windows such as poor sleep no baseline at all.

**Medication: paired before / after.**
- For each dose logged as taken: tremor share in the 30–180 min after it minus the 2 h before it.
- Pairing reduces the effect of slow day-to-day change. Time of day, meals and activity can still differ between the two windows, and the screen says so.

**Heart rate.**
- **During episodes vs resting:** the heart rate during episodes minus the same day's median resting heart rate.
- **Before episodes vs calm:** the mean heart rate in the 5 min before episodes minus calm periods in the same session (more than 10 min from any episode). This needs 1 s samples, which are kept 30 days.

**Statistics.**
- Bootstrap percentile intervals with 2000 resamples and a fixed seed, so the same data gives the same answer.
- When several comparisons are shown together, each interval is **Bonferroni-corrected** to level 1 − 0.05/m. With four tags, each interval is 98.75 %.
- The verdict is "higher" or "lower" only when the interval excludes zero, otherwise "no clear difference".
- **"Not enough data yet"** below 5 tagged windows or 10 baseline windows (tags), 5 paired doses (medication), or 8 episodes (heart rate).
- Every result shows the two means, the difference, the interval and its level, and the counts.

**Wording.** "Tremor was higher in the 30–180 min after coffee than at the same time on days without it (+1.6 percentage points). This is an association in your data, not proof of a cause." Never causal.

**Known limits.**
- These are observational self-tracking data: things that happen together, such as coffee and stress, can't be separated.
- Tags are only as reliable as the logging.
- With few events the intervals are wide by design.

## Tremor pattern hints

> **The clinical wording has NOT been reviewed by a clinician.** Every row is marked `needs-clinical-review`, and the app shows a banner saying so. It must be reviewed before any real use. A test enforces that no rule text contains a disease or condition name or the word "diagnosis".

**Features from the episodes:**
- main axis per episode;
- share of combined (multi-axis) episodes and their pattern;
- median frequency and interquartile range;
- regularity (mean band-energy share and even cycles per window);
- share of episodes while walking, episodes per monitored day, and weekly mean scores.

**Confidence** reflects how many episodes support the description, not certainty about any cause:
- nothing below 5 episodes;
- low below 15;
- moderate from 15;
- higher from 40.

| id | Text (as shown) | Condition | Source note |
|---|---|---|---|
| regular-horizontal | Pattern consistent with a regular side-to-side ("no-no") head tremor, around {f} Hz. *Worth mentioning to a doctor.* | "no-no" main axis in ≥ 60 % of episodes, regular, median 3.5–8.5 Hz | Bhatia et al., Consensus Statement on the Classification of Tremors, Mov Disord 2018;33(1):75–87 |
| regular-vertical | … up-and-down ("yes-yes") head tremor … | "yes-yes" ≥ 60 %, regular | same |
| tilting | … regular side-tilting head tremor … | tilt ≥ 60 %, regular | same |
| combined | The shaking often involves two directions at once, mostly {pattern}. | ≥ 30 % of episodes combined | same + engineering note |
| varying-direction | The direction of the shaking varies between episodes. | no axis ≥ 60 %, few combined | same |
| lower-frequency | The frequency is at the lower end of the band the device looks at (around {f} Hz). | median < 4.5 Hz | Elble & McNames, Using portable transducers to measure tremor severity, Tremor Other Hyperkinet Mov 2016;6:375 |
| higher-frequency | … upper end … | median > 7 Hz | same |
| irregular | Episodes are less regular than a steady rhythmic tremor; some may be other movements such as talking or fidgeting. | band share < 0.6 or < 5 even cycles | engineering note (no clinical source) |
| while-walking | Many episodes were detected while walking, where the detector is less reliable. | ≥ 30 % while walking | engineering note: detector limits |
| frequent | Episodes are frequent: about {n} a day on days with monitoring. *Worth mentioning to a doctor.* | ≥ 10 a day over ≥ 5 days | self-tracking guidance (thresholds are engineering choices) |
| rising | The weekly severity score has risen over recent weeks (from {a} to {b}). *Worth mentioning to a doctor.* | +1.5 over the last 3–4 weeks | same |

The bibliographic details above are from memory and should be checked against the publications during the clinical review.
