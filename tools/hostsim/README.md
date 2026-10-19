# Host simulator (detector regression tests)

Compiles the **real sketch**, unchanged, with g++ against mock `Arduino.h`, `Wire.h` and `MAX30105.h`. Simulated sensors sit on the mock I2C bus:
- **MPU6050:** head motion from a scenario, plus gyro bias (0.8 / −1.1 / 0.4 °/s) and noise (0.05 °/s and 0.003 g RMS per sample). It quantises and **saturates according to the range registers the sketch writes**, so the ±2 g → ±8 g change shows up without any change here.
- **MAX30102:** a pulse wave at about 72 bpm, with the red/IR ratio set to give about 97 % on the sketch's SpO₂ curve, and a removable finger.

Time is virtual, so a 90 s scenario runs in about 0.1 s.

```
npm run hostsim                                    # current firmware vs baseline, table for sensitivity 2
node tools/hostsim/run.mjs --check                 # CI: exit 1 on regression
node tools/hostsim/run.mjs --md docs/DETECTOR_BASELINE.md
node tools/hostsim/run.mjs --write-baseline        # re-record baseline.json from legacy/ (only when intended)
tools/hostsim/bin/sim_current --list               # scenarios
tools/hostsim/bin/sim_current --scenario fall --csv out.csv   # dump the stream
```

**Scenarios** (after 5 s of stillness for boot and calibration): still; slow looking around with quick turns, nods and tilts; fidget jerks; moderate and animated talking; walking at 1.8, 2.2 and 2.8 steps/s; tremors on each axis at 3, 6 and 15 °/s; a tremor during head turns; tremors during walking, both off and on a step harmonic; a fall with a 9 g impact; finger removed. Each runs with 5 seeds at sensitivity 1 to 5.

**Regression rule (`--check`):** compared with `baseline.json` (legacy sketch), the current firmware may not:
- raise false-alert time by more than 0.2 percentage points;
- add more than 0.2 false episodes per run;
- lose more than 2 points of recall;
- add more than 0.25 s of latency.

## Baseline findings, legacy detector at default sensitivity 2 (recorded 2026-10-20)

| | Result |
|---|---|
| Still, head turns, fidgeting, moderate talking, walking at 1.8 and 2.2 steps/s | 0 false alerts |
| Tremor alone, 3–15 °/s, any axis | 100 % recall, correct axis, ~1.7 s latency, frequency error < 0.1 Hz |
| Tremor during head turns | ~90 % recall |
| **Brisk walking at 2.8 steps/s** | **~1.2 % false-alert time, about 1 false episode per minute** |
| **Animated talking (stress test)** | **~7.8 % false-alert time** |
| **Tremor while walking, not on a step harmonic** | **~52 % recall, latency ~3.9 s**: the doubled walking threshold and step-harmonic filter suppress about half |
| Tremor at exactly 3× the step rate | 0 % recall: the known, documented limit |
| Fall, 9 g impact | accelerometer saturates at 2.15 g with the legacy ±2 g range: the reason for the milestone 3 change |

**Caveats.** These are synthetic signals I designed: clean sinusoidal tremor, and a talking model based on my own estimate (about 1.5 °/s RMS in band at "moderate"). They show the code behaves as designed and catch regressions. They are **not** evidence of accuracy on real heads; real tremor is less regular and real noise is messier.

## Firmware changes checked with this tool

| Change | Result (5 seeds, sensitivity 1–5, all scenarios) |
|---|---|
| `axes`, `aMax`, `aMin` output fields | Alert on/off, axis, latency, frequency and walking metrics **identical** to the baseline (zero differences). Combined tremor (diagonal, circular, two frequencies): both axes reported in 100 % of settled alert frames. Pure "no-no" with a 15° board tilt (26 % cross-talk): never reported as combined. When a second axis stops, its report clears after about 0.5 s. |
| Accelerometer ±2 g → ±8 g (`0x1C = 0x10`, 4096 LSB/g) | Alert metrics and walking detection (98 %) **identical**. Orientation after the fall identical (pitch −0.2° → 85.1°). Fall impact now reported at **8.04 g** instead of saturating at **2.15 g** (9 g simulated; a 40 ms peak falls between 100 Hz samples). Resolution is 0.24 mg per count, far below the walking detector's 35 mg activity floor. |

The detector thresholds have not been changed. Any change will be proposed with before/after numbers from this tool.
