// QMC5883P magnetometer: tilt-compensated heading, one-time calibration, and a slow correction of the
// gyro-integrated yaw (the gyro drifts; Earth's magnetic field does not).
//
// How the correction works (docs/ORIENTATION.md):
//   * The gyro gives yaw changes that are fast and smooth but drift a little (bias, temperature).
//   * The compass gives an absolute direction that is noisy and can be disturbed by steel or magnets.
//   * Every compass sample nudges the yaw towards the compass with a time constant of 5 s, so slow drift is
//     removed and a 5 Hz tremor (which averages out) is untouched.
//   * Samples are ignored while the field strength is not what it was during calibration (a magnet or
//     a steel object is close) or when the head is tilted more than 60 degrees.
//   * Nothing depends on the compass for the tremor detector: it only touches `yawDeg`.
//
// Calibration (`!mag start`, about 20 seconds): turn the headset slowly about the vertical axis for one full
// turn (two is better), level. That gives the hard-iron offset (x, y) and soft-iron scale (x, y). The z offset needs the
// head to nod and tilt: it is estimated from whatever tilt happened and otherwise left at 0 (small error for
// small tilts). The direction of the compass relative to the gyro is detected during the same turns, so a
// board mounted mirrored still works; a board whose axes are swapped fails with a clear message
// (set HTM_MAG_SWAP_XY / HTM_MAG_FLIP_* below).
//
// Hardware notes (QMC5883P datasheet register map; NOT yet verified on a real board by the author):
//   I2C 0x2C, chip id 0x80 at register 0x00, data X/Y/Z little-endian at 0x01..0x06, status 0x09 (bit 0 = ready),
//   CONTROL1 0x0A (mode, rate, oversampling), CONTROL2 0x0B (range). Range +/-8 G = 3750 LSB/G.
#pragma once
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef HTM_MAG_ADDR
#define HTM_MAG_ADDR 0x2C
#endif
#ifndef HTM_MAG_SWAP_XY
#define HTM_MAG_SWAP_XY 0       // 1 if the compass chip's X/Y are swapped relative to the MPU6050
#endif
#ifndef HTM_MAG_FLIP_X
#define HTM_MAG_FLIP_X 0
#endif
#ifndef HTM_MAG_FLIP_Y
#define HTM_MAG_FLIP_Y 0
#endif
#ifndef HTM_MAG_FLIP_Z
#define HTM_MAG_FLIP_Z 0
#endif

namespace htm {

static inline float wrap180(float a) { a = fmodf(a + 180.0f, 360.0f); if (a < 0) a += 360.0f; return a - 180.0f; }
static inline float wrap360(float a) { a = fmodf(a, 360.0f); if (a < 0) a += 360.0f; return a; }

namespace magcfg {
constexpr float TAU_S = 5.0f;               // correction time constant
constexpr float RATIO_MIN = 0.80f, RATIO_MAX = 1.20f;   // accepted |B| / calibrated |B|
constexpr float MAX_TILT_DEG = 60.0f;
constexpr int   SECTORS = 12;               // 30 degrees each
constexpr int   SECTORS_NEEDED = 12;     // every 30-degree sector must be visited,
constexpr int   SECTOR_MIN_SAMPLES = 5;   // with at least this many compass samples (0.1 s), or a field peak can be missed
constexpr float MIN_SPAN_FRACTION = 0.5f;   // x/y span must be at least this share of the larger one (a flat circle)
constexpr float MIN_CORR = 0.85f;           // |correlation| between compass yaw changes and gyro yaw changes
constexpr float MAX_RADIUS_SPREAD = 0.20f;  // std / mean of |B| after calibration
constexpr float TIMEOUT_S = 180.0f;
constexpr int   MAX_SAMPLES = 700;          // stored for the direction check (every 4th compass sample)
}  // namespace magcfg

struct MagCal { float off[3]; float scale[3]; float radius; int sign; };

class Compass {
 public:
  bool present = false;
  int quality = 0;                          // 0 not fitted, 1 not calibrated, 2 calibrated but ignored right now, 3 correcting yaw
  bool calibrated = false;
  MagCal cal{ { 0, 0, 0 }, { 1, 1, 1 }, 0, 1 };
  bool calibrating = false;
  int progress = 0;                         // percent, while calibrating

  /** Result text of the last calibration attempt ("" while running), for the status line. */
  const char *message() const { return msg_; }
  bool finishedFlag() { bool f = finished_; finished_ = false; return f; }

  void setCalibration(const MagCal &c) { cal = c; calibrated = true; refSet_ = false; if (present) quality = 2; }
  void clear() { calibrated = false; refSet_ = false; cal = MagCal{ { 0, 0, 0 }, { 1, 1, 1 }, 0, 1 }; if (present) quality = 1; }
  /** The yaw was reset (recentre): re-anchor the compass reference at the next sample. */
  void reanchor() { refSet_ = false; }

  void startCalibration(float yawNow, uint32_t nowMs) {
    calibrating = true; n_ = 0; memset(sectorN_, 0, sizeof sectorN_); progress = 0; startMs_ = nowMs; yaw0_ = yawNow; ticks_ = 0; msg_[0] = 0; finished_ = false;
    for (int k = 0; k < 3; k++) { mn_[k] = 1e9f; mx_[k] = -1e9f; }
  }
  void cancelCalibration() { calibrating = false; strcpy(msg_, "calibration cancelled"); finished_ = true; }

  /**
   * One compass sample (already mapped to the board axes, LSB units), with the filter's current pitch / roll and
   * the gyro-integrated yaw. May move `yaw` a little towards the compass. `dt` = seconds since the last sample.
   */
  void feed(const float b[3], float pitchDeg, float rollDeg, float &yaw, float dt, uint32_t nowMs) {
    if (!present) return;
    if (calibrating) { collect(b, pitchDeg, rollDeg, yaw, nowMs); return; }
    if (!calibrated) { quality = 1; return; }
    float bc[3];
    correct(b, bc);
    float mag = sqrtf(bc[0] * bc[0] + bc[1] * bc[1] + bc[2] * bc[2]);
    float ratio = cal.radius > 0 ? mag / cal.radius : 0;
    float tilt = fmaxf(fabsf(pitchDeg), fabsf(rollDeg));
    float hm;
    float ym = headingYaw(bc, pitchDeg, rollDeg, &hm);
    bool ok = ratio >= magcfg::RATIO_MIN && ratio <= magcfg::RATIO_MAX && tilt < magcfg::MAX_TILT_DEG && hm > 0.2f * cal.radius;
    if (!ok) { quality = 2; return; }
    float yawMag = ym * (float)cal.sign;
    if (!refSet_) { ref_ = yawMag - yaw; refSet_ = true; }
    float e = wrap180(yawMag - ref_ - yaw);
    yaw += (1.0f - expf(-dt / magcfg::TAU_S)) * e;
    quality = 3;
  }

  /** Heading of the board's x axis in the "compass yaw" convention (counter-clockwise positive, like the gyro). */
  static float headingYaw(const float bc[3], float pitchDeg, float rollDeg, float *horizMagnitude = nullptr) {
    const float p = pitchDeg * (float)(M_PI / 180.0), r = rollDeg * (float)(M_PI / 180.0);
    const float u[3] = { -sinf(r), sinf(p) * cosf(r), cosf(p) * cosf(r) };   // "up" in the board frame (from the accelerometer angles)
    const float dotB = bc[0] * u[0] + bc[1] * u[1] + bc[2] * u[2];
    const float bh[3] = { bc[0] - dotB * u[0], bc[1] - dotB * u[1], bc[2] - dotB * u[2] };
    float xh[3] = { 1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2] };           // board x axis projected on the horizontal plane
    float n = sqrtf(xh[0] * xh[0] + xh[1] * xh[1] + xh[2] * xh[2]);
    if (n < 1e-3f) { if (horizMagnitude) *horizMagnitude = 0; return 0; }
    for (int k = 0; k < 3; k++) xh[k] /= n;
    const float yh[3] = { u[1] * xh[2] - u[2] * xh[1], u[2] * xh[0] - u[0] * xh[2], u[0] * xh[1] - u[1] * xh[0] };   // up x xh
    const float bx = bh[0] * xh[0] + bh[1] * xh[1] + bh[2] * xh[2];
    const float by = bh[0] * yh[0] + bh[1] * yh[1] + bh[2] * yh[2];
    if (horizMagnitude) *horizMagnitude = sqrtf(bx * bx + by * by);
    return atan2f(-by, bx) * (float)(180.0 / M_PI);
  }

 private:
  bool refSet_ = false; float ref_ = 0;
  // calibration state
  float mn_[3], mx_[3];
  uint32_t startMs_ = 0, ticks_ = 0; float yaw0_ = 0; int sectorN_[magcfg::SECTORS] = {};
  struct S { float b[3]; float p, r, yaw; };
  S s_[magcfg::MAX_SAMPLES]; int n_ = 0;
  char msg_[160] = ""; bool finished_ = false;

  void correct(const float b[3], float out[3]) const { for (int k = 0; k < 3; k++) out[k] = (b[k] - cal.off[k]) * cal.scale[k]; }

  void collect(const float b[3], float p, float r, float yaw, uint32_t nowMs) {
    for (int k = 0; k < 3; k++) { if (b[k] < mn_[k]) mn_[k] = b[k]; if (b[k] > mx_[k]) mx_[k] = b[k]; }
    int sec = (int)(wrap360(yaw - yaw0_) / (360.0f / magcfg::SECTORS)) % magcfg::SECTORS;
    sectorN_[sec]++;
    int have = 0;
    for (int i = 0; i < magcfg::SECTORS; i++) if (sectorN_[i] >= magcfg::SECTOR_MIN_SAMPLES) have++;
    progress = have * 100 / magcfg::SECTORS_NEEDED; if (progress > 100) progress = 100;
    if ((ticks_++ % 4) == 0 && n_ < magcfg::MAX_SAMPLES) { S &s = s_[n_++]; s.b[0] = b[0]; s.b[1] = b[1]; s.b[2] = b[2]; s.p = p; s.r = r; s.yaw = yaw; }
    float elapsed = (float)(nowMs - startMs_) / 1000.0f;
    if (have >= magcfg::SECTORS_NEEDED && n_ > 40) { finish(); return; }
    if (elapsed > magcfg::TIMEOUT_S) fail("calibration timed out: turn the headset slowly through one or two full circles, level");
  }

  void fail(const char *why) { calibrating = false; strncpy(msg_, why, sizeof msg_ - 1); msg_[sizeof msg_ - 1] = 0; finished_ = true; }

  void finish() {
    MagCal c{ { 0, 0, 0 }, { 1, 1, 1 }, 0, 1 };
    float half[3];
    for (int k = 0; k < 3; k++) { c.off[k] = 0.5f * (mx_[k] + mn_[k]); half[k] = 0.5f * (mx_[k] - mn_[k]); }
    if (half[0] < 1 || half[1] < 1) { fail("compass reads no change while turning: check the wiring"); return; }
    float big = fmaxf(half[0], half[1]), small = fminf(half[0], half[1]);
    if (small < magcfg::MIN_SPAN_FRACTION * big) { fail("turn about the vertical axis, level, not just left and right"); return; }
    float avg = 0.5f * (half[0] + half[1]);
    c.scale[0] = avg / half[0]; c.scale[1] = avg / half[1];
    // z: only trust the offset if the head tilted enough for the field to vary on that axis
    if (half[2] > 0.25f * avg) c.scale[2] = avg / half[2]; else c.off[2] = 0.0f;
    // direction of the compass versus the gyro, and consistency of |B|
    float sxy = 0, sxx = 0, syy = 0, prevM = 0, prevG = 0, m = 0, m2 = 0; bool first = true; int nr = 0;
    float unwrapM = 0, unwrapG = 0;
    for (int i = 0; i < n_; i++) {
      float bc[3]; for (int k = 0; k < 3; k++) bc[k] = (s_[i].b[k] - c.off[k]) * c.scale[k];
      float mag = sqrtf(bc[0] * bc[0] + bc[1] * bc[1] + bc[2] * bc[2]);
      m += mag; m2 += mag * mag; nr++;
      float ym = headingYaw(bc, s_[i].p, s_[i].r), g = s_[i].yaw;
      if (!first) { float dm = wrap180(ym - prevM), dg = g - prevG; unwrapM += dm; unwrapG += dg; sxy += dm * dg; sxx += dm * dm; syy += dg * dg; }
      prevM = ym; prevG = g; first = false;
    }
    float mean = m / (nr ? nr : 1), var = m2 / (nr ? nr : 1) - mean * mean;
    c.radius = mean;
    float spread = mean > 0 ? sqrtf(var > 0 ? var : 0) / mean : 1;
    float corr = (sxx > 0 && syy > 0) ? sxy / sqrtf(sxx * syy) : 0;
    if (fabsf(corr) < magcfg::MIN_CORR) { fail("compass axes do not match the gyro: see HTM_MAG_SWAP_XY in mag.h"); return; }
    if (spread > magcfg::MAX_RADIUS_SPREAD) { fail("field strength varied too much: move away from steel or magnets and try again"); return; }
    c.sign = corr > 0 ? 1 : -1;
    cal = c; calibrated = true; calibrating = false; refSet_ = false; quality = 2;
    snprintf(msg_, sizeof msg_, "calibrated: %s, field %.0f%% steady, direction %s%s", spread < 0.08f ? "good" : "fair", (1.0f - spread) * 100.0f, c.sign > 0 ? "same as gyro" : "mirrored",
             half[2] > 0.25f * avg ? ", z offset measured" : ", z offset unknown (tilt the head too for a better fit)");
    finished_ = true;
  }
};

}  // namespace htm
