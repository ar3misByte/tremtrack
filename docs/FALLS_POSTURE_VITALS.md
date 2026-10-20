# Combined tremor, falls, posture and resting vitals

Milestone 3 features. Each one is a pure, unit-tested module with its thresholds in `app/src/config/thresholds.ts` (some can be changed in Settings) and a "how this is measured" note in the app. **None of them is a diagnosis or a clinical measurement.**

## 1. Shaking on several axes at once ("yes-yes" and "no-no" together)

**Firmware:** the alert logic is unchanged. It still decides *whether* there is a tremor and which axis is strongest (`dir`). A new appended field `axes` reports *every* axis that is shaking: a second axis is included when it passes all the same tremor tests on its own **and** is at least 30 % as strong as the alerting axis (`CO_AXIS_MIN_FRAC`). The 30 % rule stops cross-talk from a tilted board counting as a combined tremor: a pure "no-no" with the board tilted 15° leaks about 26 % into pitch.

**App (`logic/multiaxis.ts`):** while two axes shake, the app compares their band-passed signals over the last 1.5 s:

| Pattern | Rule | What the head does |
|---|---|---|
| diagonal | same frequency, phase within 30° of 0° or 180° | moves along one slanted line |
| circular | same frequency, phase within 35° of 90° | traces a circle or ellipse |
| two separate rhythms | frequencies differ by more than max(0.6 Hz, 12 %) | two independent tremors |
| mixed | same frequency, phase coherence below 0.6 | no fixed timing |

**Episodes** store every axis that shook for at least 30 % of the episode, the share of time and mean amplitude per axis, and the most common pattern. The episode amplitude for a combined tremor is the magnitude across the axes involved, √(Σ aᵢ²). That's severity score **version 2**: a combined tremor scores at least as high as either axis alone.

**Checked with the host simulator (real sketch, 5 seeds each):**

| Scenario | Both axes reported | Wrongly reported as combined |
|---|---|---|
| Yes-yes + no-no 5 Hz, in step | 100 % | – |
| Yes-yes + no-no 5 Hz, quarter cycle apart | 100 % | – |
| Two tremors, 4.4 Hz + 5.6 Hz | 100 % | – |
| Pure no-no, board tilted 15° | – | 0 % |
| Yes-yes joins a no-no for 10 s | 100 % while both shake | 4 % (≈0.5 s lag after it stops) |

The app recognised the right pattern on the firmware's output for each of these (tests in `tracker.test.ts`, `showcase.test.ts`).

## 2. Fall / sudden-impact candidates

**Firmware:** the accelerometer range changed from ±2 g to **±8 g** (it saturated at 2.15 g on a simulated 9 g impact; it now reports 8.04 g). New appended fields `aMax`, `aMin` give the largest and smallest |a| over the 100 Hz samples since the previous line, so a 40 ms impact isn't lost at 50 lines/s. Tremor and walking detection were checked to be identical before and after (see `tools/hostsim/README.md`).

**Rules (`logic/fall.ts`):**
1. Either a **free fall** (|a| < 0.5 g for ≥ 0.1 s) followed within 1 s by an **impact** > 2.5 g, or a hard **impact > 4 g** without free fall (trips, slips).
2. Then **stillness** for 2 s, starting 0.5 s after the impact: |a| within 0.85–1.15 g, not walking, and orientation spread under 4°, for ≥ 85 % of the time.
3. Optional (off by default): the head must end up turned over by ≥ 30°. A fall can end sitting up.
4. 15 s cooldown.

**On a candidate**, a full-screen alert gives a 30 s countdown (configurable), with vibration and a beep. "I'm OK" cancels. "Get help now", or no answer, leads to a caregiver alert. **Caregiver alerts aren't wired up yet**: the SNS email arrives with the cloud (milestone 6), and the app says so plainly. Every candidate and its outcome is stored and listed in Trends.

**Tested on firmware output from the host simulator:**

| Scenario | Flagged? |
|---|---|
| Fall: free fall 0.35 s, 9 g impact, lying still | yes |
| Trip: 6 g impact without free fall, lying still | yes |
| Headset dropped on a table | **yes: a false alarm by design** |
| Sitting down hard (0.6 g dip, 2.2 g bump) | no |
| Small jump while walking (free fall + 3 g landing, keeps walking) | no (stillness check) |
| Head turns and nods, brisk walking, combined tremor | no |

During development the jump-while-walking case was first flagged, because walking bounce (±0.2 g) fit the original 0.7–1.3 g "still" band. The fix was to never count walking as still and to narrow the band to 0.85–1.15 g. Both are principled limits for a person lying still, not tuned to the test.

**Limits:** it will miss slow slumps and soft landings (no impact), and it can't tell a fall from the headset being dropped or thrown down. Real falls haven't been recorded; every test signal is synthetic. Without the milestone 7 firmware, detection runs in the app only, so it needs the phone or laptop connected.

## 3. Posture and stillness

- **Calibrate** a neutral pose on the Live screen: hold still and comfortably upright for 3 s. The orientation must not spread more than 2°, and walking or tremor during calibration fails it with a reason.
- **Each second** is classed as still (< 0.4° orientation spread), restless (> 2°), walking, or normal.
- **Posture zones** (relative to the calibrated pose, after the axis mapping): forward > 15°, back > 20°, side tilt > 12°.
- A **gentle reminder** appears after about 2 minutes mostly (≥ 80 %) outside the range, at most once every 10 minutes. It can be switched off.
- Sessions store still, restless, pose-monitored and outside-range seconds; Trends shows them per day.
- **Mounting differs between people**, and a headband can slip. Recalibrate when the numbers look off. The board is assumed to be head-mounted.

## 4. Resting heart rate and SpO₂

- "Resting" means low motion (orientation spread ≤ 1° per second, no walking, no tremor alert) for at least **3 minutes**. Then one reading every 30 s.
- A reading is the median of the seconds with a valid PPG signal (`ppgState = 3`). It carries quality metadata: share of valid seconds, heart-rate IQR, mean motion, and a rating:
  - **good:** ≥ 80 % valid and IQR ≤ 6 bpm;
  - **fair:** ≥ 50 % valid;
  - **poor:** below that. Poor readings are stored but excluded from trends.
- **Trends** shows the daily median resting heart rate and SpO₂, each in its own chart (no dual axes).
- **Flags** (worded as observations): the resting SpO₂ estimate was below 92 % on ≥ 2 of the last 7 days, or the resting heart rate was above 100 bpm on ≥ 2 days. The wording says the sensor is uncalibrated and "may be worth mentioning to a doctor". Never a condition name.
- The SpO₂ value comes from a hobby MAX30102 with a generic calibration curve: it's an **uncalibrated estimate**.
