# Orientation and the compass

The board reports **pitch** (nod), **roll** (tilt) and **yaw** (turn left and right) in degrees.

| Angle | From | Behaviour |
|---|---|---|
| pitch, roll | complementary filter: gyro (fast) + accelerometer (gravity, used only when |a| is close to 1 g) | stable, no drift |
| yaw | gyro integrated over time, **plus a slow correction from the compass when one is fitted** | the gyro alone drifts slowly (bias and temperature); the compass has no drift but is noisy and can be disturbed |

The tremor detector never uses yaw angle or the compass: it works on the band-passed gyro rates. A test (`tools/hostsim/compass-check.mjs`) shows that tremor, walking and every other output are **identical** with and without a compass.

## What the correction does (`firmware/tremor_monitor/mag.h`)

At 50 Hz the QMC5883P is read and its field vector is corrected with the calibration (hard-iron offset, soft-iron scale), tilt-compensated with the pitch and roll above, and turned into a heading. The yaw is then pulled towards that heading with a **time constant of 5 s**:

```
yaw += (1 - exp(-dt / 5 s)) * wrap180(headingYaw - yaw)
```

- A steady drift of the gyro of `b` degrees per second ends up as an error of about `b × 5 s` (a stress test with 0.6 °/s of bias drift stays within 3.5°; without the compass it ends 45° off).
- A tremor at 3.5 Hz or more averages out in this filter: it cannot move the yaw.
- The reference direction is taken the first time the compass is used after start-up or **Recentre**, so "straight ahead" stays what you chose; nothing needs to point north.

### When the compass is ignored (state "ignored" in the app)

- The field strength differs by more than ±20 % from the calibration: a magnet or steel is close (a 10 s, 0.6 G disturbance in the test changes the yaw by at most 4°);
- the head is tilted more than 60°;
- the horizontal part of the field is too small to give a direction.

During this the gyro carries the yaw alone, exactly as without a compass.

## Calibration (`!mag start`, from Settings → Headset)

Turn the headset slowly, **level**, through a full circle. Measured: the minimum and maximum of x and y give the hard-iron offset and soft-iron scale. It finishes when **all twelve 30° sectors** have been visited with enough samples (stopping at eleven missed a field peak and left a 14° error in an early version; the test now keeps this honest).

- **Direction check.** While turning, the change of compass heading is compared with the change of gyro yaw. A strong positive correlation: same direction. Strong negative: the chip is mirrored relative to the gyro, which is recorded and corrected (a mirror image is not tilt-compensated exactly, so the error is a few degrees more: set `HTM_MAG_FLIP_*` in `mag.h` for a perfect fit). **No correlation** (for example the chip is mounted on its side) → calibration is refused with a message, and the yaw stays gyro-only.
- **Field steadiness.** The strength must stay within 20 % (std/mean) during the turn, otherwise steel or magnets are too close.
- **Vertical (z) offset.** It is only measured if the head also tilted; otherwise it is left at 0, which costs about 2° of error at 15° of tilt.
- The result is stored in the ESP32's flash (`!mag clear` forgets it).

## Hardware notes (not yet verified on a real board)

The register map is from the QMC5883P datasheet: I²C `0x2C`; chip id `0x80` at `0x00`; data X/Y/Z little-endian at `0x01`; status `0x09` (bit 0 = ready); control `0x0A` (continuous, 100 Hz, 8× oversampling) and `0x0B` (±8 G, 3750 LSB/G). Only ratios matter for the heading, so a wrong scale factor would not change the result. The older QMC5883L, HMC5883L and MPU9250 compasses are different chips and are **not** supported. The axis directions of the chip relative to the MPU6050 depend on how your boards are mounted: the calibration's direction check covers a mirror image, and `HTM_MAG_SWAP_XY` / `HTM_MAG_FLIP_X/Y/Z` cover the rest.

## Tested in the host simulator (`tools/hostsim`)

A synthetic QMC5883P sees Earth's field (0.40 G horizontal, 35° inclination) from the simulated head's true orientation, with hard iron (420, −310, 180 LSB), soft iron (1.08, 0.93), noise, and optional mirrored or swapped or sideways mounting and a magnetic disturbance.

| Test | Result |
|---|---|
| Calibration finishes by itself | after about one turn (12 s) |
| Yaw error with a slow gyro-bias ramp | ≤ 3.5° (rms 1.8°) with the compass; 44.7° without |
| Mirrored mounting | direction detected, ≤ 7.4° |
| X/Y swapped (also a mirror image) | handled the same way, ≤ 5.1° |
| Chip on its side | calibration refused, yaw left to the gyro |
| 0.6 G disturbance for 10 s | ≤ 4.1° during and after; state shows "ignored" |
| Fitted but not calibrated | yaw identical to gyro-only |
| Tremor / walking / all other outputs | identical with and without the compass |
