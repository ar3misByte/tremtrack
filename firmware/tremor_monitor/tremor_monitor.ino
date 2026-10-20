/*
 * Tremor Stream - ESP32 + MPU6050 -> USB serial -> web page
 * ---------------------------------------------------------------------
 * Wiring (one shared I2C bus): every board VCC->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22
 *   MPU6050 (0x68, AD0->GND) and MAX30102 (0x57). The QMC5883P is not used here.
 * Library: "SparkFun MAX3010x Pulse and Proximity Sensor Library" (Library Manager).
 * Serial: 115200 baud.
 * CLOSE the Arduino Serial Monitor/Plotter before using the web page:
 * only one program can own the USB port at a time.
 *
 * ORIENTATION
 *   Complementary filter (gyro + accelerometer) gives pitch and roll in degrees.
 *   Yaw is integrated from the gyro (no magnetometer) so it drifts slowly;
 *   the web page has a Recenter button.
 *
 * TREMOR DETECTION (per gyro axis, every 100 ms, on a 1.5 s window)
 *   An alert needs ALL of these:
 *     1. Band       : peak amplitude 3.5-8.5 Hz above a threshold, and most of
 *                     the signal's energy sits in that band (q).
 *     2. Steady     : the shaking fills the whole window, not just a part of it.
 *     3. Repeating  : the pattern must REPEAT. We count the cycles (zero
 *                     crossings) and require >= 4 of them with nearly equal
 *                     timing, and the signal must correlate with itself one,
 *                     two and three periods later (autocorrelation). A random
 *                     jerk, flick, turn or a burst of mixed frequencies fails.
 *     4. Not a step : see below.
 *
 * WALKING / BOBBING AWARENESS
 *   Walking makes the head bob at the step rate (1.2-3.4 steps/s), and the 2nd,
 *   3rd, 4th harmonics of that bob land inside 3.5-8.5 Hz. A separate detector
 *   looks for slow rhythmic motion (1.2-3.4 Hz) in the accelerometer and gyro
 *   ("walking or bobbing"). While it is active:
 *     - a tremor candidate whose frequency is a multiple of the step rate is
 *       treated as step bounce and ignored,
 *     - the amplitude needed to raise an alert is doubled.
 *   Limit: a real tremor at exactly a multiple of the step rate cannot be told
 *   apart from step bounce while you are walking.
 *
 * Axis convention: X = Pitch ("Yes-Yes"), Y = Roll (tilt), Z = Yaw ("No-No").
 * Tilting the board rolls the ball "downhill": roll -> horizontal, pitch -> vertical.
 *
 * OUTPUT (50 lines/s), one CSV line starting with '$':
 *   $,pitch,roll,yaw,fPitch,fRoll,fYaw,tremor,dir,ampP,ampR,ampY,freq,q,walking,stepHz,cycles,bpm,spo2,ppgState,pulse,axes,aMax,aMin
 *     pitch/roll/yaw     : degrees
 *     fPitch/fRoll/fYaw  : band-passed gyro (dps) for the waveform
 *     tremor             : 1 while a tremor is active
 *     dir                : 0 = pitch, 1 = roll, 2 = yaw (active axis, or strongest axis)
 *     amp*               : peak amplitude in the tremor band per axis (dps)
 *     freq, q            : frequency (Hz) and band-energy share (0..1) of that axis
 *     walking            : 1 while walking / rhythmic bobbing is detected
 *     stepHz             : step rate (steps per second) while walking
 *     cycles             : number of consistent cycles found on that axis in the window
 *     bpm, spo2          : heart rate (beats/min) and oxygen saturation (%), 0 = no valid reading yet
 *     ppgState           : 0 = MAX30102 not found, 1 = no finger, 2 = measuring, 3 = valid reading
 *     pulse              : filtered IR pulse wave (arbitrary units) for the page's pulse trace
 *     axes               : bit mask of the axes shaking right now (1 = pitch, 2 = roll, 4 = yaw); 0 when no tremor.
 *                          More than one bit = shaking on several axes at once (e.g. 5 = yes-yes + no-no).
 *     aMax, aMin         : largest and smallest |acceleration| (g) over the samples since the previous line
 *                          (impact / free-fall detection in the app). Appended fields: older pages ignore them.
 * Lines starting with '#' are status messages for humans.
 */

#include <Wire.h>
#include "MAX30105.h"      // SparkFun MAX3010x library (its MAX30105 class also drives the MAX30102)
#include "frame.h"
#include "mag.h"
#ifndef HTM_HOSTSIM
#include <Preferences.h>
#endif
#ifdef HTM_HOSTSIM
// The host simulator has no radio: the link layer is a stub that only lets the simulator see the frames.
inline void htmLinkBegin() {}
inline void htmLinkPush(const HtmFrame &f) { if (htmFrameHook) htmFrameHook(f); }
inline void htmLinkStatus(const char *fmt, ...) { char b[120]; va_list ap; va_start(ap, fmt); vsnprintf(b, sizeof b, fmt, ap); va_end(ap); Serial.print("# "); Serial.println(b); }
bool htmCoreCommand(const char *line);
inline void htmLinkCommand(const char *l) { htmCoreCommand(l); }
inline void htmLinkSensitivity(int) {}
#else
#include "link.h"          // Bluetooth LE, LAN WebSocket, AWS IoT MQTT (needs the libraries listed in firmware/README.md)
#endif

// ----------------------------- Hardware ---------------------------
#define SDA_PIN  21
#define SCL_PIN  22
#define MPU_ADDR 0x68
// MAX30102 heart-rate / SpO2 sensor sits on the same bus at 0x57

// ----------------------------- Streaming --------------------------
const uint32_t BAUD      = 115200;
const uint32_t STREAM_MS = 20;           // 50 lines per second

// ----------------------------- Sampling / filters -----------------
const float FS = 100.0f;                 // sample rate (Hz)
const uint32_t SAMPLE_US = 10000;        // 1e6 / FS
const float DT = 1.0f / FS;
const float GYRO_LSB_PER_DPS = 65.5f;    // +/-500 dps
const float ACC_LSB_PER_G    = 4096.0f;  // +/-8 g (was +/-2 g, which saturated in impacts)
const float RAD2DEG = 57.2957795f;
const float HP_FC = 2.5f;                // tremor high-pass (Hz)
const float LP_FC = 10.0f;               // tremor low-pass (Hz)

// ----------------------------- Orientation ------------------------
const float ALPHA = 0.98f;               // gyro weight in the complementary filter
const int   CAL_SAMPLES = 200;           // 2 s of stillness at start-up

// ----------------------------- Tremor window ----------------------
const int   WIN = 150;                   // 1.5 s analysis window
const float GRID_MIN = 1.0f;             // Goertzel grid for the tremor spectrum
const float GRID_STEP = 0.5f;
const int   NF = 39;                     // 1.0 .. 20.0 Hz
const float TREMOR_LO = 3.5f;
const float TREMOR_HI = 8.5f;
const float RATIO_PAD = 1.0f;

// ----------------------------- Thresholds (TUNE THESE) ------------
// These are set from the sensitivity level (1 = strict ... 5 = very sensitive), see setSensitivity().
// Send the character 1-5 over serial (or use the page's Sensitivity box) to change it while running.
float AMP_ON_DPS, AMP_OFF_DPS;           // peak band amplitude to start / keep an alert (dps)
float Q_ON, Q_OFF;                       // share of energy inside the band
float STEADY_ON, STEADY_OFF;             // weakest third / strongest third of the window
float REP_RHO1_ON, REP_RHO1_OFF;         // self-similarity one period later
float REP_RHO2_ON, REP_RHO2_OFF;         // ... and two periods later
float CV_MAX_ON, CV_MAX_OFF;             // spread of cycle length (std/mean)
int   CYC_MIN_ON, CYC_MIN_OFF;           // consistent cycles needed to start / keep
float CYC_FRAC_MIN;                      // share of all cycles that must be consistent
const int   LAG_MIN = 11;                // autocorrelation search: 9.1 Hz ..
const int   LAG_MAX = 29;                //                          .. 3.4 Hz
const float CYC_TOL      = 0.30f;        // a cycle counts if its length is within +/-30% of the median
const int   ON_TICKS    = 2;             // consecutive 100 ms ticks to trigger
const int   OFF_TICKS   = 5;             // consecutive misses to clear
const float NOISE_MULT  = 3.0f;          // alert amplitude is never below this x the board's own noise (measured at start-up)
// Several axes at once: while an alert is on, another axis is reported as shaking too when it passes ALL the
// same tests on its own AND its amplitude is at least this share of the alerting axis. The share keeps
// cross-talk from a tilted board (a pure "no-no" leaking ~25 % into pitch at 15 degrees) from counting.
// This only adds the 'axes' output; it does not change when an alert starts or stops.
const float CO_AXIS_MIN_FRAC = 0.30f;
int sensLevel = 2;
float noiseFloor[3] = { 0, 0, 0 };       // dps, measured during calibration

//                          amp_on amp_off  q_on q_off  st_on st_off  r1_on r1_off r2_on r2_off  cv_on cv_off cyc_on cyc_off frac
const float SENS[5][15] = {
  /* 1 strict    */ { 3.0f, 2.0f, 0.55f, 0.40f, 0.25f, 0.12f, 0.50f, 0.35f, 0.35f, 0.20f, 0.20f, 0.30f, 4, 3, 0.70f },
  /* 2 default   */ { 2.4f, 1.6f, 0.50f, 0.36f, 0.21f, 0.10f, 0.50f, 0.35f, 0.35f, 0.20f, 0.20f, 0.30f, 4, 3, 0.70f },
  /* 3           */ { 1.8f, 1.2f, 0.45f, 0.32f, 0.17f, 0.08f, 0.47f, 0.32f, 0.32f, 0.18f, 0.22f, 0.32f, 4, 3, 0.68f },
  /* 4           */ { 1.4f, 0.9f, 0.40f, 0.28f, 0.14f, 0.06f, 0.44f, 0.29f, 0.29f, 0.16f, 0.24f, 0.34f, 4, 3, 0.66f },
  /* 5 sensitive */ { 1.0f, 0.7f, 0.35f, 0.25f, 0.11f, 0.05f, 0.40f, 0.26f, 0.25f, 0.14f, 0.26f, 0.36f, 4, 3, 0.62f },
};
void setSensitivity(int lvl) {
  if (lvl < 1) lvl = 1;
  if (lvl > 5) lvl = 5;
  sensLevel = lvl;
  const float *v = SENS[lvl - 1];
  AMP_ON_DPS = v[0]; AMP_OFF_DPS = v[1]; Q_ON = v[2]; Q_OFF = v[3]; STEADY_ON = v[4]; STEADY_OFF = v[5];
  REP_RHO1_ON = v[6]; REP_RHO1_OFF = v[7]; REP_RHO2_ON = v[8]; REP_RHO2_OFF = v[9];
  CV_MAX_ON = v[10]; CV_MAX_OFF = v[11]; CYC_MIN_ON = (int)v[12]; CYC_MIN_OFF = (int)v[13]; CYC_FRAC_MIN = v[14];
}
// Commands from any channel (USB, Bluetooth, WebSocket, cloud). They only set flags: the sampling loop applies them,
// because the network task and the loop run on different cores.
volatile int  cmdSens = 0;
volatile bool cmdRecenter = false;
volatile int cmdMag = 0;               // 1 start compass calibration, 2 cancel, 3 forget it
bool htmCoreCommand(const char *line) {
  if (line[0] >= '1' && line[0] <= '5' && (line[1] == 0 || line[1] == '\n' || line[1] == '\r')) { cmdSens = line[0] - '0'; return true; }
  if (!strncmp(line, "!sens ", 6) && line[6] >= '1' && line[6] <= '5') { cmdSens = line[6] - '0'; return true; }
  if (!strcmp(line, "!recenter")) { cmdRecenter = true; return true; }
  if (!strcmp(line, "!mag start")) { cmdMag = 1; return true; }
  if (!strcmp(line, "!mag stop")) { cmdMag = 2; return true; }
  if (!strcmp(line, "!mag clear")) { cmdMag = 3; return true; }
  return false;
}
const uint32_t ANALYSIS_MS = 100;
const uint32_t SETTLE_MS   = 1500;       // after calibration

// ----------------------------- Walking / bobbing ------------------
const int   GWIN = 200;                  // 2 s window
const float GAIT_MIN_HZ = 1.2f;          // step rates we look for
const float GAIT_MAX_HZ = 3.4f;
const float GAIT_GRID_MIN = 1.0f;
const float GAIT_GRID_STEP = 0.25f;
const int   GNF = 37;                    // 1.0 .. 10.0 Hz
const float GAIT_MIN_RMS_G   = 0.035f;   // accelerometer activity needed (g)
const float GAIT_MIN_RMS_DPS = 6.0f;     // or gyro activity (dps)
const float GAIT_RHO_MIN  = 0.40f;       // repeats at the step period
const float GAIT_RHO2_MIN = 0.25f;       // ... and at two step periods
const float GAIT_STEADY_MIN = 0.20f;
const int   GAIT_ON_TICKS = 3;
const uint32_t GAIT_HOLD_MS = 3000;      // stay in "walking" through a head turn or a pause
const float WALK_AMP_FACTOR = 2.0f;      // alerts need this many times more amplitude while walking

// ----------------------------- Types ------------------------------
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
  void setHighpass(float fc, float fs, float Q) {
    float w0 = 2.0f * PI * fc / fs;
    float c = cosf(w0);
    float al = sinf(w0) / (2.0f * Q);
    float a0 = 1.0f + al;
    b0 = ((1.0f + c) / 2.0f) / a0;
    b1 = (-(1.0f + c)) / a0;
    b2 = b0;
    a1 = (-2.0f * c) / a0;
    a2 = (1.0f - al) / a0;
  }
  void setLowpass(float fc, float fs, float Q) {
    float w0 = 2.0f * PI * fc / fs;
    float c = cosf(w0);
    float al = sinf(w0) / (2.0f * Q);
    float a0 = 1.0f + al;
    b0 = ((1.0f - c) / 2.0f) / a0;
    b1 = (1.0f - c) / a0;
    b2 = b0;
    a1 = (-2.0f * c) / a0;
    a2 = (1.0f - al) / a0;
  }
  float process(float x) {
    float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};

struct Axis {
  Biquad hp1, hp2, lp;                   // 4th-order 2.5 Hz high-pass + 2nd-order 10 Hz low-pass
  float buf[WIN];
  float filt = 0;
  float amp = 0, freq = 0, q = 0, steady = 0;
  float rho1 = 0, rho2 = 0, cv = 1;
  int   cycles = 0;
  float cycFrac = 0;
  bool  repeats = false;
};

struct GaitCh {                          // one input signal for the walking detector
  Biquad hp;                             // 0.7 Hz high-pass
  float buf[GWIN];
  float rms = 0, f0 = 0, rho = 0;
  bool cand = false;
};

// Explicit prototypes: the Arduino IDE would otherwise generate them ABOVE the struct definitions and fail to compile.
void analyze(Axis &a, bool hold);
void gaitAnalyze(GaitCh &c, float minRms);

// ----------------------------- Globals ----------------------------
Axis axs[3];                             // 0 = X/pitch, 1 = Y/roll, 2 = Z/yaw
float hannW[WIN];
float sumW = 0;
float coeffs[NF];
int head = 0, filled = 0;

GaitCh gch[4];                           // 0 = |accel| - 1 g, 1..3 = gyro X, Y, Z
float ghann[GWIN];
float gcoef[GNF];
int ghead = 0, gfilled = 0;
bool walking = false;
float stepHz = 0;
int jumpTicks = 0;
int gaitHits = 0;
uint32_t lastGaitMs = 0;

float angP = 0, angR = 0, yawDeg = 0;    // orientation (deg)
float gyroBias[3] = { 0, 0, 0 };

bool tremor = false;
int dirAxis = 0;
int onCount = 0, offCount = 0;
bool axActive[3] = { false, false, false };   // per-axis shaking state (same on/off tick counts as the alert)
int axOn[3] = { 0, 0, 0 }, axOff[3] = { 0, 0, 0 };
float lineAMax = 0, lineAMin = 99;             // |a| extremes since the last output line

uint32_t nextUs = 0, bootMs = 0;
uint32_t lastAnalysis = 0, lastStream = 0;

// ----------------------------- MPU6050 ----------------------------
void writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

int readReg(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

// One burst read: accel (g) and gyro (dps)
bool readMPU(float a[3], float g[3]) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);                                  // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)14) != 14) return false;
  int16_t v[7];
  for (int i = 0; i < 7; i++) {
    uint8_t hi = Wire.read();
    uint8_t lo = Wire.read();
    v[i] = (int16_t)((hi << 8) | lo);
  }
  for (int i = 0; i < 3; i++) {
    a[i] = v[i] / ACC_LSB_PER_G;                     // v[3] is temperature, skipped
    g[i] = v[4 + i] / GYRO_LSB_PER_DPS;
  }
  return true;
}

// ----------------------------- DSP helpers ------------------------
void initDSP() {
  for (int n = 0; n < WIN; n++) {
    hannW[n] = 0.5f * (1.0f - cosf(2.0f * PI * n / (WIN - 1)));
    sumW += hannW[n];
  }
  for (int k = 0; k < NF; k++) {
    float f = GRID_MIN + k * GRID_STEP;
    coeffs[k] = 2.0f * cosf(2.0f * PI * f / FS);
  }
  for (int i = 0; i < 3; i++) {
    axs[i].hp1.setHighpass(HP_FC, FS, 0.5412f);      // Butterworth 4th-order Q values
    axs[i].hp2.setHighpass(HP_FC, FS, 1.3066f);
    axs[i].lp.setLowpass(LP_FC, FS, 0.7071f);
    for (int n = 0; n < WIN; n++) axs[i].buf[n] = 0;
  }
  for (int n = 0; n < GWIN; n++) ghann[n] = 0.5f * (1.0f - cosf(2.0f * PI * n / (GWIN - 1)));
  for (int k = 0; k < GNF; k++) gcoef[k] = 2.0f * cosf(2.0f * PI * (GAIT_GRID_MIN + k * GAIT_GRID_STEP) / FS);
  for (int c = 0; c < 4; c++) {
    gch[c].hp.setHighpass(0.7f, FS, 0.7071f);
    for (int n = 0; n < GWIN; n++) gch[c].buf[n] = 0;
  }
}

// Normalised autocorrelation of x[0..N-1] at 'lag'. pre[] = running sum of x^2 (pre[0] = 0).
float acorr(const float *x, const float *pre, int N, int lag) {
  if (lag < 1) return 0;
  int m = N - lag;
  if (m < 30) return 0;
  float s = 0;
  for (int i = 0; i < m; i++) s += x[i] * x[i + lag];
  float den = sqrtf(pre[m] * (pre[N] - pre[lag]));
  return den > 1e-6f ? s / den : 0;
}

// ----------------------------- Tremor analysis --------------------
// 'hold' = a tremor alert is already active (use the relaxed thresholds).
void analyze(Axis &a, bool hold) {
  static float xr[WIN], xw[WIN], pre[WIN + 1];
  float mean = 0;
  for (int n = 0; n < WIN; n++) {                    // head = oldest sample
    xr[n] = a.buf[(head + n) % WIN];
    mean += xr[n];
  }
  mean /= WIN;
  float seg[3] = { 0, 0, 0 };                        // energy in each third of the window
  pre[0] = 0;
  for (int n = 0; n < WIN; n++) {
    float d = xr[n] - mean;
    xr[n] = d;
    seg[(n * 3) / WIN] += d * d;
    pre[n + 1] = pre[n] + d * d;
    xw[n] = d * hannW[n];
  }
  float sMax = fmaxf(seg[0], fmaxf(seg[1], seg[2]));
  float sMin = fminf(seg[0], fminf(seg[1], seg[2]));
  a.steady = (sMax > 0) ? sMin / sMax : 0;
  float rms = sqrtf(pre[WIN] / WIN);

  // --- 1. spectrum (Goertzel): peak amplitude in the band, and band energy share ---
  float pTotal = 0, pBand = 0, pPeak = 0, fPeak = 0;
  for (int k = 0; k < NF; k++) {
    float c = coeffs[k], s1 = 0, s2 = 0;
    for (int n = 0; n < WIN; n++) {
      float s0 = xw[n] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    float p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p < 0) p = 0;
    float f = GRID_MIN + k * GRID_STEP;
    pTotal += p;
    if (f >= TREMOR_LO - RATIO_PAD && f <= TREMOR_HI + RATIO_PAD) pBand += p;
    if (f >= TREMOR_LO && f <= TREMOR_HI && p > pPeak) { pPeak = p; fPeak = f; }
  }
  a.amp = 2.0f * sqrtf(pPeak) / sumW;
  a.q   = (pTotal > 0) ? pBand / pTotal : 0;

  // --- 2. autocorrelation: does the signal repeat itself 1, 2 periods later? ---
  float rho[LAG_MAX + 2];
  float rmax = -1;
  for (int L = LAG_MIN - 1; L <= LAG_MAX + 1; L++) {
    rho[L] = acorr(xr, pre, WIN, L);
    if (L >= LAG_MIN && L <= LAG_MAX && rho[L] > rmax) rmax = rho[L];
  }
  int T0 = 0;
  for (int L = LAG_MIN; L <= LAG_MAX; L++) {         // shortest strong peak (not a multiple of the period)
    if (rho[L] >= 0.9f * rmax && rho[L] >= rho[L - 1] && rho[L] >= rho[L + 1]) { T0 = L; break; }
  }
  if (T0 == 0) T0 = LAG_MIN;
  a.rho1 = rho[T0];
  float r2 = -1;
  for (int L = 2 * T0 - 1; L <= 2 * T0 + 1; L++) r2 = fmaxf(r2, acorr(xr, pre, WIN, L));
  a.rho2 = r2;

  // --- 3. cycle counting: rising zero-crossings with hysteresis, then how even are the cycles? ---
  float tc[40];
  int nc = 0;
  float h = 0.25f * rms;
  int st = (xr[0] > h) ? 1 : ((xr[0] < -h) ? -1 : 0);
  for (int n = 1; n < WIN; n++) {
    int ns = st;
    if (xr[n] > h) ns = 1; else if (xr[n] < -h) ns = -1;
    if (st == -1 && ns == 1 && nc < 40) {
      int j = n;
      while (j > 0 && xr[j] > 0) j--;                // last sample <= 0 before the rise
      float den = xr[j + 1] - xr[j];
      tc[nc++] = j + ((den > 1e-9f) ? (-xr[j]) / den : 0.5f);
    }
    st = ns;
  }
  a.cycles = 0; a.cycFrac = 0; a.cv = 1;
  float fz = 0;
  int m = nc - 1;                                    // number of cycle lengths
  if (m >= 2) {
    float iv[40], srt[40];
    for (int i = 0; i < m; i++) { iv[i] = tc[i + 1] - tc[i]; srt[i] = iv[i]; }
    for (int i = 1; i < m; i++) {                    // insertion sort for the median
      float v = srt[i]; int j = i - 1;
      while (j >= 0 && srt[j] > v) { srt[j + 1] = srt[j]; j--; }
      srt[j + 1] = v;
    }
    float med = srt[m / 2];
    int good = 0;
    float sum = 0, sum2 = 0;
    for (int i = 0; i < m; i++) {
      if (fabsf(iv[i] - med) <= CYC_TOL * med) { good++; sum += iv[i]; sum2 += iv[i] * iv[i]; }
    }
    if (good >= 1) {
      float mu = sum / good;
      float var = sum2 / good - mu * mu;
      a.cycles = good;
      a.cycFrac = (float)good / m;
      a.cv = (var > 0 && mu > 0) ? sqrtf(var) / mu : 0;
      fz = FS / mu;
    }
  }
  a.freq = (a.cycles >= 3) ? fz : fPeak;

  // --- repetition verdict ---
  int   cycMin = hold ? CYC_MIN_OFF : CYC_MIN_ON;
  float cvMax  = hold ? CV_MAX_OFF  : CV_MAX_ON;
  float r1Min  = hold ? REP_RHO1_OFF : REP_RHO1_ON;
  float r2Min  = hold ? REP_RHO2_OFF : REP_RHO2_ON;
  a.repeats = a.cycles >= cycMin && a.cycFrac >= CYC_FRAC_MIN && a.cv <= cvMax &&
              a.rho1 >= r1Min && a.rho2 >= r2Min &&
              fz >= TREMOR_LO - 0.5f && fz <= TREMOR_HI + 0.5f;
}

// Is f a harmonic of the walking rhythm? (step bounce, not tremor)
// Up/down bobbing (pitch) repeats once per step, so its harmonics are multiples of the step rate.
// Side-to-side sway (roll, yaw) repeats once per stride (two steps), so its harmonics are multiples of half the step rate.
bool stepHarmonic(float f, int axis) {
  if (!walking || stepHz <= 0 || f <= 0) return false;
  float base = (axis == 0) ? stepHz : 0.5f * stepHz;
  int k = (int)lroundf(f / base);
  if (k < 1) return false;
  float tol = 0.05f * f + 0.12f;
  return fabsf(f - k * base) <= tol;
}

// ----------------------------- Walking / bobbing detector ---------
void gaitAnalyze(GaitCh &c, float minRms) {
  static float x[GWIN], xw[GWIN], pre[GWIN + 1], P[GNF];
  float mean = 0;
  for (int n = 0; n < GWIN; n++) { x[n] = c.buf[(ghead + n) % GWIN]; mean += x[n]; }
  mean /= GWIN;
  float seg[3] = { 0, 0, 0 };
  pre[0] = 0;
  for (int n = 0; n < GWIN; n++) {
    float d = x[n] - mean;
    x[n] = d;
    pre[n + 1] = pre[n] + d * d;
    seg[(n * 3) / GWIN] += d * d;
    xw[n] = d * ghann[n];
  }
  c.rms = sqrtf(pre[GWIN] / GWIN);
  c.cand = false; c.f0 = 0; c.rho = 0;
  if (c.rms < minRms) return;
  float sMax = fmaxf(seg[0], fmaxf(seg[1], seg[2]));
  float sMin = fminf(seg[0], fminf(seg[1], seg[2]));
  if (sMax <= 0 || sMin / sMax < GAIT_STEADY_MIN) return;      // must be sustained

  float Pmax = 0;
  int kmax = 0;
  for (int k = 0; k < GNF; k++) {
    float cf = gcoef[k], s1 = 0, s2 = 0;
    for (int n = 0; n < GWIN; n++) {
      float s0 = xw[n] + cf * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    float p = s1 * s1 + s2 * s2 - cf * s1 * s2;
    P[k] = (p > 0) ? p : 0;
    if (P[k] > Pmax) { Pmax = P[k]; kmax = k; }
  }
  if (Pmax <= 0) return;

  // The strongest peak is the step rate or one of its harmonics. A tremor on its own has no
  // energy at half or a third of its frequency, so it can never pass as a step rate.
  float fpk = GAIT_GRID_MIN + kmax * GAIT_GRID_STEP;
  float f0 = 0;
  for (int div = 3; div >= 1; div--) {
    float f = fpk / div;
    if (f < GAIT_MIN_HZ - 0.25f || f > GAIT_MAX_HZ + 0.25f) continue;
    int kk = (int)lroundf((f - GAIT_GRID_MIN) / GAIT_GRID_STEP);
    int kp = -1;                                     // need a real spectral peak here, not leakage from a neighbour
    for (int d = -2; d <= 2; d++) {
      int k = kk + d;
      if (k < 1 || k > GNF - 2) continue;
      if (P[k] > 0 && P[k] >= P[k - 1] && P[k] >= P[k + 1] && (kp < 0 || P[k] > P[kp])) kp = k;
    }
    if (kp < 0) continue;
    if (div > 1 && P[kp] < 0.35f * Pmax) continue;
    float pd = P[kp - 1] - 2 * P[kp] + P[kp + 1];
    float sh = (pd < -1e-6f * Pmax) ? 0.5f * (P[kp - 1] - P[kp + 1]) / pd : 0.0f;
    sh = fminf(0.5f, fmaxf(-0.5f, sh));
    float fc = GAIT_GRID_MIN + (kp + sh) * GAIT_GRID_STEP;
    if (fc < GAIT_MIN_HZ || fc > GAIT_MAX_HZ) continue;
    f0 = fc;
    break;
  }
  if (f0 <= 0) return;

  // refine the step period with the autocorrelation, then check it repeats
  int lag0 = (int)lroundf(FS / f0);
  int lo = lag0 - 4, hi = lag0 + 4;
  int minLag = (int)(FS / GAIT_MAX_HZ) - 2, maxLag = (int)(FS / GAIT_MIN_HZ) + 3;
  if (lo < minLag) lo = minLag;
  if (hi > maxLag) hi = maxLag;
  float rr[40];
  float best = -2; int bl = lo;
  for (int L = lo - 1; L <= hi + 1; L++) {
    rr[L - lo + 1] = acorr(x, pre, GWIN, L);
    if (L >= lo && L <= hi && rr[L - lo + 1] > best) { best = rr[L - lo + 1]; bl = L; }
  }
  float rm = rr[bl - lo], rb = rr[bl - lo + 1], rp = rr[bl - lo + 2];
  float den = rm - 2 * rb + rp;
  float shift = (den < -1e-6f) ? 0.5f * (rm - rp) / den : 0.0f;   // parabolic peak refinement
  shift = fminf(1.0f, fmaxf(-1.0f, shift));                        // never more than one sample
  float lagf = bl + shift;
  float r2 = -1;
  int l2 = (int)lroundf(2 * lagf);
  for (int L = l2 - 1; L <= l2 + 1; L++) r2 = fmaxf(r2, acorr(x, pre, GWIN, L));
  c.rho = rb;
  c.f0 = FS / lagf;
  c.cand = (rb >= GAIT_RHO_MIN && r2 >= GAIT_RHO2_MIN);
}

void updateGait(uint32_t nowMs) {
  if (gfilled < GWIN) return;
  gaitAnalyze(gch[0], GAIT_MIN_RMS_G);
  for (int k = 1; k < 4; k++) gaitAnalyze(gch[k], GAIT_MIN_RMS_DPS);
  // Which input gives the step rate? Vertical head acceleration is the cleanest, then nodding (pitch).
  // Side-to-side gyro axes mostly show the stride (two steps), so they only count as a last resort.
  int best = -1;
  if (gch[0].cand) best = 0;
  else if (gch[1].cand) best = 1;
  else {
    float br = 0;
    for (int k = 2; k < 4; k++) if (gch[k].cand && gch[k].rho > br) { br = gch[k].rho; best = k; }
  }
  if (best >= 0) {
    gaitHits++;
    lastGaitMs = nowMs;
    float f0 = gch[best].f0;
    bool close = (stepHz > 0) && fabsf(f0 - stepHz) < 0.2f * stepHz;
    if (!walking) { stepHz = f0; jumpTicks = 0; }
    else if (close) { stepHz = 0.7f * stepHz + 0.3f * f0; jumpTicks = 0; }
    else if (++jumpTicks >= 15) { stepHz = f0; jumpTicks = 0; }   // a real change of pace needs ~1.5 s of agreement; a tremor spike doesn't
  } else {
    gaitHits = 0;
  }
  if (!walking && gaitHits >= GAIT_ON_TICKS) walking = true;
  if (walking && nowMs - lastGaitMs > GAIT_HOLD_MS) { walking = false; stepHz = 0; }
}

// ----------------------------- Alert logic ------------------------
void runAnalysis(uint32_t nowMs) {
  for (int i = 0; i < 3; i++) analyze(axs[i], tremor);
  updateGait(nowMs);

  bool settled = (nowMs - bootMs) > SETTLE_MS;
  float ampBase = (tremor ? AMP_OFF_DPS : AMP_ON_DPS) * (walking ? WALK_AMP_FACTOR : 1.0f);
  float qThr   = tremor ? Q_OFF : Q_ON;
  float stThr  = tremor ? STEADY_OFF : STEADY_ON;

  int best = -1;
  float bestAmp = 0;
  bool ok[3];
  for (int i = 0; i < 3; i++) {
    float ampThr = fmaxf(ampBase, NOISE_MULT * noiseFloor[i]);
    ok[i] = settled && axs[i].amp >= ampThr && axs[i].q >= qThr && axs[i].steady >= stThr &&
            axs[i].repeats && !stepHarmonic(axs[i].freq, i);
    if (ok[i] && axs[i].amp > bestAmp) { best = i; bestAmp = axs[i].amp; }
  }

  if (best >= 0) { onCount++; offCount = 0; dirAxis = best; }
  else           { offCount++; onCount = 0; }

  if (!tremor && onCount >= ON_TICKS)  tremor = true;
  if (tremor && offCount >= OFF_TICKS) tremor = false;

  // which axes are shaking (reporting only, see CO_AXIS_MIN_FRAC)
  for (int i = 0; i < 3; i++) {
    bool co = ok[i] && best >= 0 && axs[i].amp >= CO_AXIS_MIN_FRAC * bestAmp;
    if (co) { axOn[i]++; axOff[i] = 0; } else { axOff[i]++; axOn[i] = 0; }
    if (!axActive[i] && axOn[i] >= ON_TICKS) axActive[i] = true;
    if (axActive[i] && axOff[i] >= OFF_TICKS) axActive[i] = false;
  }
}

int axesMask() {
  if (!tremor) return 0;
  int m = 1 << dirAxis;                              // the alerting axis is always included
  for (int i = 0; i < 3; i++) if (axActive[i]) m |= 1 << i;
  return m;
}

// ----------------------------- Heart rate and SpO2 (MAX30102) -----
// Samples arrive at 100 per second (400 sps, 4x averaging). Red and IR are high-passed (0.5 Hz) and
// low-passed (about 4 Hz). Beats are peaks of the filtered IR; BPM is the median of the last 5 beat
// intervals. SpO2 comes from the ratio of ratios, R = (ACred/DCred) / (ACir/DCir), over the last 4 s,
// with the common empirical curve SpO2 = -45.06 R^2 + 30.354 R + 94.845.
// It is a demo-grade estimate: not calibrated, not a medical measurement.
MAX30105 ppg;
bool ppgOk = false;
const float FINGER_ON_IR  = 30000.0f;
const float FINGER_OFF_IR = 20000.0f;

struct PpgChan {
  float dc = 0, hp = 0, lp1 = 0, lp2 = 0;
  float process(float x) {                            // returns the pulsatile part
    if (dc == 0) dc = x;
    dc += 0.031f * (x - dc);                          // ~0.5 Hz high-pass (subtract slow baseline)
    float a = x - dc;
    lp1 += 0.22f * (a - lp1);                         // ~4 Hz two-pole low-pass
    lp2 += 0.22f * (lp1 - lp2);
    return lp2;
  }
};
PpgChan pIr, pRed;
bool  finger = false;
uint32_t fingerSince = 0;
long  ppgSamples = 0;                                 // samples since the finger arrived
float envPk = 0;                                      // decaying peak of the pulse, sets the beat threshold
float pPrev1 = 0, pPrev2 = 0;
uint32_t lastBeatMs = 0, ppgNowMs = 0;
float ivs[5]; int nIv = 0, ivHead = 0;
float bpmVal = 0;
float spo2Val = 0;
float pulseOut = 0;                                   // for the waveform on the page
struct Blk { double dIr = 0, dRed = 0, aIr2 = 0, aRed2 = 0; int n = 0; };
Blk blk[4]; int blkHead = 0;
uint32_t lastBlkMs = 0;
int ppgState = 0;                                     // 0 = no sensor, 1 = no finger, 2 = measuring, 3 = valid

void ppgReset() {
  pIr = PpgChan(); pRed = PpgChan();
  ppgSamples = 0; envPk = 0; pPrev1 = pPrev2 = 0;
  nIv = 0; ivHead = 0; bpmVal = 0; spo2Val = 0; lastBeatMs = 0;
  for (int i = 0; i < 4; i++) blk[i] = Blk();
  blkHead = 0; lastBlkMs = ppgNowMs;
}

float medianIv() {
  float t[5]; int n = nIv;
  for (int i = 0; i < n; i++) t[i] = ivs[i];
  for (int i = 1; i < n; i++) { float v = t[i]; int j = i - 1; while (j >= 0 && t[j] > v) { t[j + 1] = t[j]; j--; } t[j + 1] = v; }
  return t[n / 2];
}

void ppgSample(float red, float ir) {
  if (!finger && ir > FINGER_ON_IR)  { finger = true;  fingerSince = ppgNowMs; ppgReset(); }
  if (finger  && ir < FINGER_OFF_IR) { finger = false; ppgReset(); }
  if (!finger) { pulseOut = 0; return; }

  float fi = pIr.process(ir), fr = pRed.process(red);
  ppgSamples++;
  float s = -fi;                                      // reflected light drops while blood volume rises: flip so beats point up
  pulseOut = s;
  if (ppgSamples < 150) { pPrev2 = pPrev1; pPrev1 = s; return; }   // 1.5 s for the filters to settle

  envPk = fmaxf(envPk * 0.9985f, fabsf(s));           // decays over ~5 s
  float thr = 0.35f * envPk;

  // beat = local maximum of s, above the threshold, at least 300 ms after the previous beat
  if (pPrev1 > pPrev2 && pPrev1 >= s && pPrev1 > thr && thr > 2.0f && ppgNowMs - lastBeatMs > 300) {
    uint32_t tb = ppgNowMs - 10;
    if (lastBeatMs != 0) {
      float iv = (float)(tb - lastBeatMs);
      bool plausible = iv >= 300 && iv <= 1500;
      if (plausible && nIv >= 3) { float md = medianIv(); plausible = fabsf(iv - md) < 0.35f * md; }
      if (plausible) {
        ivs[ivHead] = iv; ivHead = (ivHead + 1) % 5; if (nIv < 5) nIv++;
        if (nIv >= 3) bpmVal = 60000.0f / medianIv();
        lastBeatMs = tb;
      } else if (iv > 1500) {
        lastBeatMs = tb;                              // lost the rhythm, start again
        nIv = 0; ivHead = 0;
      }                                               // else: implausible short interval, ignore this peak
    } else {
      lastBeatMs = tb;
    }
  }
  pPrev2 = pPrev1; pPrev1 = s;
  if (lastBeatMs != 0 && ppgNowMs - lastBeatMs > 3000) { bpmVal = 0; nIv = 0; }

  // SpO2 accumulators (1 s blocks)
  Blk &b = blk[blkHead];
  b.dIr += ir; b.dRed += red; b.aIr2 += fi * fi; b.aRed2 += fr * fr; b.n++;
  if (ppgNowMs - lastBlkMs >= 1000) {
    lastBlkMs = ppgNowMs;
    blkHead = (blkHead + 1) % 4;
    blk[blkHead] = Blk();
    double dI = 0, dR = 0, aI = 0, aR = 0; long n = 0;
    for (int i = 0; i < 4; i++) { dI += blk[i].dIr; dR += blk[i].dRed; aI += blk[i].aIr2; aR += blk[i].aRed2; n += blk[i].n; }
    if (n >= 300) {
      double mI = dI / n, mR = dR / n, rI = sqrt(aI / n), rR = sqrt(aR / n);
      if (mI > 1000 && mR > 1000 && rI / mI > 0.0008 && rR > 0) {
        float R = (float)((rR / mR) / (rI / mI));
        if (R > 0.3f && R < 2.2f) {
          float sp = -45.06f * R * R + 30.354f * R + 94.845f;
          if (sp > 100) sp = 100;
          if (sp < 70) sp = 70;
          spo2Val = (spo2Val == 0) ? sp : 0.7f * spo2Val + 0.3f * sp;
        }
      }
    }
  }
}

void ppgPoll(uint32_t nowMs) {
  if (!ppgOk) return;
  ppgNowMs = nowMs;
  ppg.check();                                        // pull whatever the sensor has buffered
  while (ppg.available()) {
    float red = (float)ppg.getFIFORed();
    float ir  = (float)ppg.getFIFOIR();
    ppg.nextSample();
    ppgSample(red, ir);
  }
  if (!finger) ppgState = 1;
  else if (bpmVal > 0 && spo2Val > 0 && ppgNowMs - fingerSince > 5000) ppgState = 3;
  else ppgState = 2;
}

// ----------------------------- Start-up calibration ---------------
// Averages the gyro (bias) and starts the orientation from the accelerometer.
// Also feeds the filters so their start-up transients are gone.
void calibrate() {
  float gs[3] = { 0, 0, 0 }, as[3] = { 0, 0, 0 }, nsq[3] = { 0, 0, 0 };
  int n = 0;
  for (int i = 0; i < CAL_SAMPLES; i++) {
    float a[3], g[3];
    if (readMPU(a, g)) {
      for (int k = 0; k < 3; k++) {
        gs[k] += g[k];
        as[k] += a[k];
        float fv = axs[k].lp.process(axs[k].hp2.process(axs[k].hp1.process(g[k])));
        gch[k + 1].hp.process(g[k]);
        if (i >= 50) nsq[k] += fv * fv;                    // skip the filters' start-up, then measure the board's own noise
      }
      gch[0].hp.process(sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) - 1.0f);
      n++;
    }
    delay(10);
  }
  if (n > 0) {
    for (int k = 0; k < 3; k++) { gyroBias[k] = gs[k] / n; as[k] /= n; }
    angP = atan2f(as[1], as[2]) * RAD2DEG;
    angR = atan2f(-as[0], sqrtf(as[1] * as[1] + as[2] * as[2])) * RAD2DEG;
  }
  for (int k = 0; k < 3; k++) {
    float rms = sqrtf(nsq[k] / (CAL_SAMPLES - 50));
    noiseFloor[k] = fminf(rms, 0.5f);                  // if you shook the board during start-up, don't let it desensitise itself
  }
  yawDeg = 0;
}

// ----------------------------- Compass (QMC5883P) -----------------------------
htm::Compass compass;
uint32_t lastMagMs = 0;
void writeRegAt(uint8_t addr, uint8_t reg, uint8_t val) { Wire.beginTransmission(addr); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
int readRegAt(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom((int)addr, 1) != 1) return -1;
  return Wire.read();
}

bool magBegin() {
  Wire.beginTransmission(HTM_MAG_ADDR);
  if (Wire.endTransmission() != 0) return false;
  if (readRegAt(HTM_MAG_ADDR, 0x00) != 0x80) return false;       // chip id
  writeRegAt(HTM_MAG_ADDR, 0x0B, 0x08);                          // +/-8 G, set/reset on
  writeRegAt(HTM_MAG_ADDR, 0x0A, 0x0B);                          // continuous mode, 100 Hz, 8x oversampling
  return true;
}
/** One sample in LSB, mapped to the MPU6050 axes. false = nothing new. */
bool magRead(float b[3]) {
  if (!(readRegAt(HTM_MAG_ADDR, 0x09) & 1)) return false;        // data ready
  Wire.beginTransmission(HTM_MAG_ADDR); Wire.write(0x01); Wire.endTransmission(false);
  if (Wire.requestFrom((int)HTM_MAG_ADDR, 6) != 6) return false;
  int16_t v[3];
  for (int k = 0; k < 3; k++) { uint8_t lo = Wire.read(), hi = Wire.read(); v[k] = (int16_t)((hi << 8) | lo); }
  float x = v[0], y = v[1], z = v[2];
#if HTM_MAG_SWAP_XY
  { float t = x; x = y; y = t; }
#endif
  b[0] = HTM_MAG_FLIP_X ? -x : x; b[1] = HTM_MAG_FLIP_Y ? -y : y; b[2] = HTM_MAG_FLIP_Z ? -z : z;
  return true;
}
#ifndef HTM_HOSTSIM
void magSave() { Preferences p; p.begin("htmmag", false); p.putBytes("cal", &compass.cal, sizeof compass.cal); p.end(); }
void magForget() { Preferences p; p.begin("htmmag", false); p.clear(); p.end(); }
void magLoad() { Preferences p; p.begin("htmmag", true); if (p.getBytesLength("cal") == sizeof(htm::MagCal)) { htm::MagCal c; p.getBytes("cal", &c, sizeof c); compass.setCalibration(c); } p.end(); }
#else
void magSave() {}
void magForget() {}
void magLoad() {}
#endif
int htmMagState() { return compass.calibrating ? 4 : compass.quality; }

// ----------------------------- Output -----------------------------
void sendFrame() {
  bool ready = (filled == WIN) && (millis() - bootMs > SETTLE_MS);
  int dom = 0;                                       // strongest axis
  for (int i = 1; i < 3; i++) if (axs[i].amp > axs[dom].amp) dom = i;
  int d = tremor ? dirAxis : dom;

  HtmFrame f;                                        // values rounded to the precision they are printed with
  f.pitch = htmRound(angP, 10); f.roll = htmRound(angR, 10); f.yaw = htmRound(yawDeg, 10);
  f.fP = htmRound(axs[0].filt, 100); f.fR = htmRound(axs[1].filt, 100); f.fY = htmRound(axs[2].filt, 100);
  f.tremor = tremor ? 1 : 0; f.dir = (uint8_t)d;
  f.ampP = ready ? htmRound(axs[0].amp, 10) : 0.0f;
  f.ampR = ready ? htmRound(axs[1].amp, 10) : 0.0f;
  f.ampY = ready ? htmRound(axs[2].amp, 10) : 0.0f;
  f.freq = ready ? htmRound(axs[d].freq, 10) : 0.0f;
  f.q = ready ? htmRound(axs[d].q, 100) : 0.0f;
  f.walking = walking ? 1 : 0; f.stepHz = walking ? htmRound(stepHz, 100) : 0.0f;
  f.cycles = ready ? axs[d].cycles : 0;
  f.bpm = (ppgState == 3) ? (int)lroundf(bpmVal) : 0; f.spo2 = (ppgState == 3) ? (int)lroundf(spo2Val) : 0;
  f.ppgState = ppgState; f.pulse = htmRound(pulseOut, 10);
  f.axes = axesMask();
  f.aMax = htmRound(lineAMax, 100); f.aMin = htmRound(lineAMin > 50 ? 0.0f : lineAMin, 100);
  f.magq = htmMagState();
  lineAMax = 0; lineAMin = 99;

  char line[200];
  htmFormatFrame(line, sizeof line, f);
  Serial.print(line);
  htmLinkPush(f);
}

// ----------------------------- Setup ------------------------------
void setup() {
  Serial.setTxBufferSize(2048);                      // printing never stalls sampling
  Serial.begin(BAUD);
  delay(1000);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);

  Serial.println("# Tremor Stream starting");

  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) {
    while (true) {
      Serial.println("# ERROR: MPU6050 not found at 0x68. Check VCC->3V3, GND, SDA->21, SCL->22, AD0->GND.");
      delay(1000);
    }
  }

  writeReg(0x6B, 0x01);        // wake, clock = gyro PLL
  delay(100);
  writeReg(0x1A, 0x04);        // hardware low-pass ~20 Hz
  writeReg(0x1B, 0x08);        // gyro +/-500 dps
  writeReg(0x1C, 0x10);        // accel +/-8 g (fall / impact detection needs the headroom)
  Serial.printf("# MPU6050 OK (WHO_AM_I = 0x%02X)\n", readReg(0x75));

  setSensitivity(sensLevel);
  if (ppg.begin(Wire, I2C_SPEED_FAST)) {
    ppg.setup(0x1F, 4, 2, 400, 411, 4096);           // LED power, avg 4, red+IR, 400 sps (=100 after averaging), 411 us, 4096 nA range
    ppgOk = true; ppgState = 1;
    Serial.println("# MAX30102 OK: place a fingertip on it for heart rate and SpO2");
  } else {
    Serial.println("# MAX30102 not found at 0x57: heart rate and SpO2 disabled");
  }
  compass.present = magBegin();
  compass.quality = compass.present ? 1 : 0;
  if (compass.present) { magLoad(); Serial.printf("# QMC5883P compass OK (%s)\n", compass.calibrated ? "calibrated" : "not calibrated: send !mag start, see docs/ORIENTATION.md"); }
  else Serial.println("# QMC5883P compass not found at 0x2C: yaw comes from the gyro only (it drifts slowly)");
  initDSP();
  Serial.println("# Calibrating: keep the board still for 2 seconds...");
  calibrate();
  Serial.printf("# Board noise (dps): %.2f %.2f %.2f   sensitivity %d (send 1-5 to change)\n", noiseFloor[0], noiseFloor[1], noiseFloor[2], sensLevel);
  Serial.println("# Streaming");
  htmLinkBegin();

  bootMs = millis();
  nextUs = micros();
}

// ----------------------------- Loop -------------------------------
void loop() {
  uint32_t now = micros();
  if ((int32_t)(now - nextUs) < 0) return;           // wait for the next 10 ms slot
  nextUs += SAMPLE_US;
  if ((int32_t)(now - nextUs) > (int32_t)(5 * SAMPLE_US)) nextUs = now + SAMPLE_US;  // resync after a stall

  float a[3], g[3];
  if (readMPU(a, g)) {
    // --- orientation: complementary filter ---
    float accP = atan2f(a[1], a[2]) * RAD2DEG;
    float accR = atan2f(-a[0], sqrtf(a[1] * a[1] + a[2] * a[2])) * RAD2DEG;
    float mag  = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (mag > lineAMax) lineAMax = mag;
    if (mag < lineAMin) lineAMin = mag;
    float corr = (fabsf(mag - 1.0f) < 0.25f) ? (1.0f - ALPHA) : 0.0f;   // trust accel only when ~1 g
    angP = (angP + (g[0] - gyroBias[0]) * DT) * (1.0f - corr) + accP * corr;
    angR = (angR + (g[1] - gyroBias[1]) * DT) * (1.0f - corr) + accR * corr;
    yawDeg += (g[2] - gyroBias[2]) * DT;

    // --- tremor band-pass ---
    for (int i = 0; i < 3; i++) {
      axs[i].filt = axs[i].lp.process(axs[i].hp2.process(axs[i].hp1.process(g[i])));
      axs[i].buf[head] = axs[i].filt;
    }
    head = (head + 1) % WIN;
    if (filled < WIN) filled++;

    // --- walking / bobbing inputs ---
    gch[0].buf[ghead] = gch[0].hp.process(mag - 1.0f);
    for (int i = 0; i < 3; i++) gch[i + 1].buf[ghead] = gch[i + 1].hp.process(g[i] - gyroBias[i]);
    ghead = (ghead + 1) % GWIN;
    if (gfilled < GWIN) gfilled++;
  }

  uint32_t ms = millis();
  if (compass.present && ms - lastMagMs >= 20) {
    float dt = (ms - lastMagMs) * 0.001f;
    lastMagMs = ms;
    float b[3];
    if (magRead(b)) compass.feed(b, angP, angR, yawDeg, dt > 0.2f ? 0.2f : dt, ms);
  }
  ppgPoll(ms);
  static char cmdBuf[160]; static size_t cmdN = 0;
  while (Serial.available()) {
    int c = Serial.read();
    if (cmdN == 0 && c >= '1' && c <= '5') { cmdSens = c - '0'; continue; }
    if (cmdN == 0 && c != '!') continue;             // line commands start with '!'
    if (c == '\n' || c == '\r') { if (cmdN) { cmdBuf[cmdN] = 0; htmLinkCommand(cmdBuf); } cmdN = 0; }
    else if (cmdN < sizeof cmdBuf - 1) cmdBuf[cmdN++] = (char)c;
  }
  if (cmdSens) {
    int lvl = cmdSens; cmdSens = 0;
    setSensitivity(lvl);
    htmLinkStatus("Sensitivity %d", sensLevel);
    htmLinkSensitivity(sensLevel);
  }
  if (cmdRecenter) { cmdRecenter = false; yawDeg = 0; compass.reanchor(); htmLinkStatus("Yaw recentred"); }
  if (cmdMag) {
    int c = cmdMag; cmdMag = 0;
    if (!compass.present) htmLinkStatus("MAG not fitted");
    else if (c == 1) { compass.startCalibration(yawDeg, ms); htmLinkStatus("MAG calibrating: turn the headset slowly, level, through one or two full circles"); }
    else if (c == 2) { compass.cancelCalibration(); }
    else if (c == 3) { compass.clear(); magForget(); htmLinkStatus("MAG calibration deleted"); }
  }
  if (compass.calibrating) {
    static int lastShown = -1;
    if (compass.progress / 10 != lastShown) { lastShown = compass.progress / 10; htmLinkStatus("MAG progress %d%%", compass.progress); }
  }
  if (compass.finishedFlag()) {
    htmLinkStatus("MAG %s", compass.message());
    if (compass.calibrated) magSave();
  }

  if (filled == WIN && ms - lastAnalysis >= ANALYSIS_MS) {
    lastAnalysis = ms;
    runAnalysis(ms);
  }

  if (ms - lastStream >= STREAM_MS) {
    lastStream = ms;
    sendFrame();
  }
}
