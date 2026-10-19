# Tremor severity score (version 1)

**An engineering score for self-tracking, from 0 to 10. It is not a clinical scale.** It can't be compared with clinical tremor ratings (for example TETRAS or Fahn–Tolosa–Marín), and it isn't evidence about any condition. Its only use is to compare your own days and weeks, measured the same way.

Code: `app/src/logic/severity.ts`. Weights: `app/src/config/thresholds.ts` (`SEVERITY`). Tests: `severity.test.ts`, which checks the caps, monotonicity and the worked examples below.

## Inputs, per episode

An episode is a period when the device's tremor alert is on. Alerts less than 3 s apart are merged, and alerts shorter than 1 s are dropped. During the episode the app uses:
- **A**: mean band amplitude on the alerting axis (°/s), from the firmware;
- **f**: mean frequency (Hz);
- **D**: duration (s).

## Episode score

1. **Head movement:** θ = A ÷ (2π f), the peak angular displacement of a sinusoid with peak rate A, in degrees. This is how frequency enters the score: at the same angular rate, slower shaking moves the head further.
2. **Intensity:** I = ln(1 + θ/θ₀) ÷ ln(1 + θmax/θ₀), capped to 0–1, with θ₀ = 0.05° and θmax = 5°.
   - A log scale because perceived and functional impact grow much more slowly than the raw amplitude.
   - θ₀ is about the smallest movement the default detector flags (2.4 °/s at 5 Hz ≈ 0.08°).
   - θmax = 5° is treated as "as large as this scale distinguishes".
3. **Duration term:** Dn = ln(1 + D/d₀) ÷ ln(1 + dmax/d₀), capped to 0–1, with d₀ = 2 s and dmax = 5 min.
4. **Score** = 10 × (0.7 I + 0.3 Dn). The weights favour how strong the shaking is over how long one episode lasts; time spent shaking across the day is counted by the daily score.

## Daily score

- **Burden:** B = Σ(Dᵢ × Iᵢ) ÷ T, where T is the monitored time that day (seconds with data arriving; gaps over 1 s excluded). This is the intensity-weighted share of time spent shaking.
- **Daily** = 10 × ln(1 + B/b₀) ÷ ln(1 + bmax/b₀), capped to 0–10, with b₀ = 0.002 and bmax = 0.3.
- Days with less than **10 minutes** of monitoring show **"not enough data"** instead of a score.
- A monitored day with no episodes scores 0. A day with no monitoring has no score; it is not 0.
- **Trend:** a trailing 7-day mean of the days that have a score, shown only when at least 3 of the 7 days do.
- **Weekly:** the mean of scored days in a Monday-to-Sunday week.

## Properties (tested)

- Always within 0 to 10.
- Episode score never decreases when amplitude or duration increases. At a fixed angular rate, it rises as frequency falls.
- With monitored time fixed, the daily score never decreases when an episode is added, made longer or made stronger. That's why the daily score uses a sum over episodes rather than a mean intensity: with a mean, adding a weak episode could lower the score.

## Worked examples

| Episode | θ | I | Dn | Score |
|---|---|---|---|---|
| 3 °/s at 5 Hz for 5 s (weak, near the detection threshold) | 0.095° | 0.23 | 0.25 | **2.4** |
| 15 °/s at 5 Hz for 30 s | 0.48° | 0.51 | 0.55 | **5.2** |
| 60 °/s at 4 Hz for 5 min | 2.39° | 0.84 | 1.00 | **8.9** |

| Day (2 h monitored) | Share of time | Daily |
|---|---|---|
| one 5 s episode at 3 °/s | 0.07 % | **0.2** |
| three 20 s episodes at 6 °/s | 0.8 % | **1.8** |
| ten 60 s episodes at 15 °/s | 8.3 % | **6.2** |

## Known limitations

- The firmware raises an alert about 1.7 s after shaking starts and clears it about 0.5 s after it stops, so stored times are shifted by about 1.5 s. Durations are roughly right.
- Amplitude is in °/s at the board, so it depends on how the board is mounted. Scores are comparable for one person and one mounting, not between people.
- A tremor at a multiple of the step rate is missed while walking (see `DETECTOR_BASELINE.md`), so walking-heavy days may under-score.
- Changing the device's sensitivity changes which episodes exist. Each episode stores the sensitivity it was recorded with.
- Any change to the weights must bump `SEVERITY.version`. Each episode stores the version its score was computed with.
