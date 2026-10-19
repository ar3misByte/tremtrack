// Host-side simulator for the ESP32 tremor sketch.
//
// The real sketch (.ino) is compiled unchanged against mock Arduino / Wire / MAX30105 layers.
// A synthetic MPU6050 on the mock I2C bus serves head motion from a scenario (still, head turns,
// fidgeting, talking, walking, tremor, a fall), with sensor noise, gyro bias and the range set in
// the sketch's own register writes (so saturation and quantisation are realistic).
// A synthetic MAX30102 serves a pulse wave. The sketch's '$' lines are scored against the truth.
//
// Build:  g++ -O2 -std=c++17 -Imock -DSKETCH='"path/to/sketch.ino"' sim.cpp -o sim
// Run:    sim --scenario tremor_yes_5hz_6dps --seed 1 [--sens 2] [--csv out.csv] [--realtime]
//         sim --list
#include <Arduino.h>
#include <Wire.h>
#include "MAX30105.h"

#include <functional>
#include <random>
#include <vector>
#include <map>
#include <algorithm>
#include <chrono>
#include <thread>

namespace hostsim {
uint64_t nowUs = 0;
bool ppgPresent = true;
}
HardwareSerial Serial;
TwoWire Wire;

#ifndef SKETCH
#error "define SKETCH as the quoted path of the .ino to test"
#endif
#include SKETCH

// =====================================================================================
namespace hostsim {

const double WARM = 5.0;           // s of stillness before the scenario starts (boot + calibration + settle)
const double D2R = M_PI / 180.0;

double mj(double s) {              // minimum-jerk 0 -> 1 profile
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return s * s * s * (10 - 15 * s + 6 * s * s);
}
double taper(double t, double t0, double t1, double ramp) {   // cosine on/off envelope
  if (t <= t0 || t >= t1) return 0;
  double a = std::min(1.0, (t - t0) / ramp), b = std::min(1.0, (t1 - t) / ramp);
  double e = std::min(a, b);
  return 0.5 - 0.5 * cos(M_PI * e);
}

struct Tremor { int axis; double f, A, t0, t1; double ph = 0; };   // ph = phase offset (rad), for combined tremors     // A = peak angular rate (dps); times relative to scenario start
struct Step { double ts, dur; int axis; double delta; };
struct Burst { double tc, f, A, cycles; int axis; };
struct Sine { double f, a, ph; };

struct Scenario {
  std::string name, desc;
  double dur = 60;
  bool voluntary = false, turns = false, fidget = false, talk = false;
  double talkScale = 1.0;                    // 1.0 = moderate speech head motion, 4.0 = very animated (stress test)
  bool walk = false; double stepHz = 1.8, walkT0 = 0, walkT1 = 1e9;
  std::vector<Tremor> tremors;
  bool fall = false; double fallT = 0;
  bool coherent = false;           // all tremors share one frequency wobble / amplitude modulation (one oscillator, several axes)
  double crossTalk = 0;            // yaw rate leaking into the pitch gyro (board tilted on the head: sin(tilt))
  double fingerOff0 = -1, fingerOff1 = -1;   // finger removed in this window
  bool ppg = true;
  double bpm = 72;
};

// ---------- motion state, built from a seed ----------
struct Motion {
  Scenario sc;
  std::mt19937 rng;
  std::vector<Step> steps;
  std::vector<Burst> bursts;
  struct TalkBurst { double t0, t1; std::vector<Sine> s; };
  std::vector<TalkBurst> talk;
  double vph[6];
  double trPh[8];

  double U(double a, double b) { return std::uniform_real_distribution<double>(a, b)(rng); }

  void build(const Scenario &s, unsigned seed) {
    sc = s;
    rng.seed(seed * 7919u + 17u);
    for (double &p : vph) p = U(0, 2 * M_PI);
    for (double &p : trPh) p = U(0, 2 * M_PI);
    if (sc.turns) {
      double t = U(1, 3);
      while (t < sc.dur) {
        int kind = (int)U(0, 3);                        // 0 turn (yaw), 1 nod (pitch), 2 tilt (roll)
        int axis = kind == 0 ? 2 : (kind == 1 ? 0 : 1);
        double amp = kind == 0 ? U(25, 60) : (kind == 1 ? U(12, 25) : U(8, 18));
        if (U(0, 1) < 0.5) amp = -amp;
        double dur = U(0.35, 0.8), hold = U(0.6, 2.0);
        steps.push_back({ t, dur, axis, amp });
        steps.push_back({ t + dur + hold, U(0.4, 0.9), axis, -amp });
        t += dur + hold + U(2.0, 5.0);
      }
    }
    if (sc.fidget) {
      double t = U(1, 3);
      while (t < sc.dur) {
        bursts.push_back({ t, U(3, 9), U(3, 18), U(1.0, 3.0), (int)U(0, 3) });
        t += U(1.5, 4.5);
      }
    }
    if (sc.talk) {
      // each speech burst gets its own random mix of 1.5-7 Hz components (amplitude ~ 1/f), so the
      // motion is irregular from burst to burst, as in real speech
      double t = U(0, 1);
      while (t < sc.dur) {
        double on = U(1.5, 4.5);
        TalkBurst b{ t, t + on, {} };
        for (int k = 0; k < 12; k++) { double f = U(1.5, 7.0); b.s.push_back({ f, U(0.03, 0.08) / f, U(0, 2 * M_PI) }); }
        talk.push_back(b);
        t += on + U(0.5, 1.5);
      }
    }
  }

  // Euler angles (deg) at absolute sim time t. Linear vertical accel (g) out in 'vert'.
  void angles(double ta, double ang[3], double &vert, double &gScale) {
    ang[0] = ang[1] = ang[2] = 0; vert = 0; gScale = 1;
    double t = ta - WARM;
    // always: tiny breathing sway
    ang[0] += 0.3 * sin(2 * M_PI * 0.25 * ta + vph[0]);
    if (t < 0) return;

    if (sc.voluntary) {
      double e = taper(t, 0, 1e9, 2.0);                  // fade in, no step at the start
      ang[0] += e * 8 * sin(2 * M_PI * 0.13 * t + vph[1]) + e * 4 * sin(2 * M_PI * 0.31 * t + vph[2]);
      ang[1] += e * 3 * sin(2 * M_PI * 0.19 * t + vph[3]);
      ang[2] += e * 15 * sin(2 * M_PI * 0.08 * t + vph[4]) + e * 6 * sin(2 * M_PI * 0.27 * t + vph[5]);
    }
    for (auto &s : steps) ang[s.axis] += s.delta * mj((t - s.ts) / s.dur);
    for (auto &b : bursts) {
      double sig = b.cycles / (2 * b.f), x = (t - b.tc) / sig;
      if (fabs(x) < 4) ang[b.axis] += b.A / (2 * M_PI * b.f) * sin(2 * M_PI * b.f * (t - b.tc)) * exp(-x * x);
    }
    if (sc.talk) {
      for (auto &b : talk) {
        double on = taper(t, b.t0, b.t1, 0.25);
        if (on <= 0) continue;
        double s = 0;
        for (auto &k : b.s) s += k.a * sin(2 * M_PI * k.f * t + k.ph) * (0.6 + 0.4 * sin(2 * M_PI * 0.9 * t + k.ph));
        ang[0] += on * s * 2.5 * sc.talkScale;           // ~1.5 dps rms in 3.5-8.5 Hz at talkScale 1 (estimate, not validated)
        ang[2] += on * s * 1.0 * sc.talkScale;
      }
    }
    if (sc.walk && t >= sc.walkT0 && t < sc.walkT1) {
      double e = taper(t, sc.walkT0, sc.walkT1, 1.0);
      double wob = 0.03 / (2 * M_PI * 0.05);
      double ph = 2 * M_PI * sc.stepHz * (t - wob * cos(2 * M_PI * 0.05 * t));
      ang[0] += e * (1.6 * sin(ph) + 0.45 * sin(2 * ph + 0.7) + 0.15 * sin(3 * ph + 1.9));
      ang[1] += e * (1.2 * sin(ph / 2) + 0.25 * sin(1.5 * ph + 0.4));
      ang[2] += e * (2.2 * sin(ph / 2 + 1.0) + 0.4 * sin(ph + 0.3) + 0.2 * sin(1.5 * ph + 2.0));
      vert += e * (0.20 * sin(ph) + 0.07 * sin(2 * ph + 0.5) + 0.03 * sin(3 * ph + 1.1));
    }
    for (size_t i = 0; i < sc.tremors.size(); i++) {
      const Tremor &tr = sc.tremors[i];
      double env = taper(t, tr.t0, tr.t1, 0.5);
      if (env <= 0) continue;
      size_t wi = sc.coherent ? 0 : i;
      double wob = 0.03 * tr.f / (2 * M_PI * 0.2);
      double ph = 2 * M_PI * (tr.f * t - wob * cos(2 * M_PI * 0.2 * t + trPh[wi])) + tr.ph;
      double am = 1 + 0.15 * sin(2 * M_PI * 0.7 * t + trPh[wi + 1]);
      ang[tr.axis] += env * am * tr.A / (2 * M_PI * tr.f) * sin(ph);
    }
    if (sc.fall) {
      double tf = sc.fallT, ff = 0.35;
      if (t >= tf) ang[0] += 85 * mj((t - tf) / ff);
      if (t >= tf && t < tf + ff) gScale = 0.05;           // free fall: almost no specific force
      if (t >= tf + ff && t < tf + ff + 0.04) {             // impact: 40 ms half-sine, ~9 g peak
        vert += 8.0 * sin(M_PI * (t - tf - ff) / 0.04);
      }
    }
  }

  int tremorTruth(double ta) const {                        // axis of an active simulated tremor, or -1
    double t = ta - WARM;
    for (auto &tr : sc.tremors) if (t >= tr.t0 && t < tr.t1) return tr.axis;
    return -1;
  }
  int truthMask(double ta) const {                          // bit mask of axes with an active simulated tremor
    double t = ta - WARM;
    int m = 0;
    for (auto &tr : sc.tremors) if (t >= tr.t0 && t < tr.t1) m |= 1 << tr.axis;
    return m;
  }
  bool nearTremor(double ta, double after) const {          // inside a tremor window or just after it
    double t = ta - WARM;
    for (auto &tr : sc.tremors) if (t >= tr.t0 && t < tr.t1 + after) return true;
    return false;
  }
  bool finger(double ta) const {
    double t = ta - WARM;
    return !(t >= sc.fingerOff0 && t < sc.fingerOff1);
  }
};

Motion M;

// ---------- synthetic MPU6050 ----------
struct Mpu6050 : I2CDevice {
  uint8_t regs[128] = {};
  uint8_t ptr = 0;
  std::mt19937 rng{ 12345 };
  std::normal_distribution<double> nd{ 0.0, 1.0 };
  double bias[3] = { 0.8, -1.1, 0.4 };   // dps
  long reads = 0, satAcc = 0, satGyr = 0;
  double maxAccDemand = 0, maxAccServed = 0;

  Mpu6050() { regs[0x75] = 0x68; }
  void write(const uint8_t *d, int n) override {
    ptr = d[0] & 0x7F;
    for (int i = 1; i < n; i++) regs[ptr++ & 0x7F] = d[i];
  }
  static int16_t q(double v, double lsb, long &sat) {
    double x = std::round(v * lsb);
    if (x > 32767) { x = 32767; sat++; }
    if (x < -32768) { x = -32768; sat++; }
    return (int16_t)x;
  }
  int read(uint8_t *out, int n) override {
    if (ptr == 0x3B && n == 14) {
      reads++;
      double t = nowUs * 1e-6, h = 1e-4;
      double a0[3], a1[3], ac[3], v0, v1, vc, g0, g1, gc;
      M.angles(t - h, a0, v0, g0);
      M.angles(t + h, a1, v1, g1);
      M.angles(t, ac, vc, gc);
      double gyro[3], acc[3];
      double rate[3];
      for (int k = 0; k < 3; k++) rate[k] = (a1[k] - a0[k]) / (2 * h);
      rate[0] += M.sc.crossTalk * rate[2];
      for (int k = 0; k < 3; k++) gyro[k] = rate[k] + bias[k] + 0.05 * nd(rng);
      double p = ac[0] * D2R, r = ac[1] * D2R;
      double gv[3] = { -sin(r), sin(p) * cos(r), cos(p) * cos(r) };
      for (int k = 0; k < 3; k++) acc[k] = gv[k] * (gc + vc) + 0.003 * nd(rng);
      double mag = sqrt(acc[0] * acc[0] + acc[1] * acc[1] + acc[2] * acc[2]);
      maxAccDemand = std::max(maxAccDemand, mag);
      static const double ALSB[4] = { 16384, 8192, 4096, 2048 }, GLSB[4] = { 131, 65.5, 32.8, 16.4 };
      double alsb = ALSB[(regs[0x1C] >> 3) & 3], glsb = GLSB[(regs[0x1B] >> 3) & 3];
      int16_t v[7];
      for (int k = 0; k < 3; k++) v[k] = q(acc[k], alsb, satAcc);
      v[3] = 0;
      for (int k = 0; k < 3; k++) v[4 + k] = q(gyro[k], glsb, satGyr);
      double s = 0;
      for (int k = 0; k < 3; k++) s += (v[k] / alsb) * (v[k] / alsb);
      maxAccServed = std::max(maxAccServed, sqrt(s));
      for (int k = 0; k < 7; k++) { out[2 * k] = (uint8_t)((uint16_t)v[k] >> 8); out[2 * k + 1] = (uint8_t)(v[k] & 0xFF); }
      return 14;
    }
    for (int i = 0; i < n; i++) out[i] = regs[(ptr + i) & 0x7F];
    return n;
  }
};

// ---------- synthetic MAX30102 (through the MAX30105 mock) ----------
std::mt19937 prng{ 999 };
std::normal_distribution<double> pnd{ 0.0, 1.0 };
double beatPhase = 0, lastPpgT = -1;
void ppgSample(double t, float &red, float &ir) {
  double dt = lastPpgT < 0 ? 0.01 : t - lastPpgT;
  lastPpgT = t;
  double bpm = M.sc.bpm + 2 * sin(2 * M_PI * 0.1 * t);
  beatPhase = fmod(beatPhase + dt * bpm / 60.0, 1.0);
  if (!M.finger(t)) { ir = (float)(3000 + 30 * pnd(prng)); red = (float)(2000 + 30 * pnd(prng)); return; }
  double ph = beatPhase;
  double vol = exp(-pow((ph - 0.15) / 0.08, 2)) + 0.35 * exp(-pow((ph - 0.45) / 0.10, 2));
  const double IRDC = 90000, REDDC = 60000, PERF = 0.010, R = 0.593;   // R = 0.593 -> ~97 % on the sketch's curve
  ir = (float)(IRDC * (1 - PERF * vol) + 20 * pnd(prng));
  red = (float)(REDDC * (1 - PERF * R * vol) + 15 * pnd(prng));
}

// ---------- scenarios ----------
std::vector<Scenario> scenarios() {
  std::vector<Scenario> v;
  auto add = [&](Scenario s) { v.push_back(s); };
  { Scenario s; s.name = "still"; s.desc = "Sitting still (breathing sway only)"; s.dur = 60; add(s); }
  { Scenario s; s.name = "voluntary_turns"; s.desc = "Slow looking around plus quick head turns, nods and tilts"; s.dur = 90; s.voluntary = s.turns = true; add(s); }
  { Scenario s; s.name = "fidget"; s.desc = "Short jerks and flicks (1-3 cycles, 3-9 Hz) over slow movement"; s.dur = 90; s.voluntary = s.fidget = true; add(s); }
  { Scenario s; s.name = "talking"; s.desc = "Irregular 1.5-7 Hz head motion in speech bursts (moderate)"; s.dur = 90; s.voluntary = s.talk = true; add(s); }
  { Scenario s; s.name = "talking_animated"; s.desc = "Very animated speech, 4x the motion (stress test)"; s.dur = 90; s.voluntary = s.talk = true; s.talkScale = 4.0; add(s); }
  { Scenario s; s.name = "walk_1.8"; s.desc = "Walking, 1.8 steps/s"; s.dur = 60; s.walk = true; s.stepHz = 1.8; add(s); }
  { Scenario s; s.name = "walk_2.2"; s.desc = "Walking, 2.2 steps/s"; s.dur = 60; s.walk = true; s.stepHz = 2.2; add(s); }
  { Scenario s; s.name = "walk_2.8"; s.desc = "Brisk walk / jog, 2.8 steps/s"; s.dur = 60; s.walk = true; s.stepHz = 2.8; add(s); }
  for (double A : { 3.0, 6.0, 15.0 }) {
    char n[64];
    snprintf(n, sizeof n, "tremor_yes_5hz_%gdps", A);
    Scenario s; s.name = n; s.desc = "Still, then 'yes-yes' (pitch) tremor 5 Hz"; s.dur = 50; s.tremors = { { 0, 5.0, A, 10, 40 } }; add(s);
    snprintf(n, sizeof n, "tremor_no_4.5hz_%gdps", A);
    Scenario s2; s2.name = n; s2.desc = "Still, then 'no-no' (yaw) tremor 4.5 Hz"; s2.dur = 50; s2.tremors = { { 2, 4.5, A, 10, 40 } }; add(s2);
  }
  { Scenario s; s.name = "tremor_tilt_6hz_8dps"; s.desc = "Still, then roll tremor 6 Hz"; s.dur = 50; s.tremors = { { 1, 6.0, 8, 10, 40 } }; add(s); }
  { Scenario s; s.name = "tremor_no_with_turns"; s.desc = "'No-no' 5.5 Hz 10 dps during looking around and head turns"; s.dur = 70; s.voluntary = s.turns = true; s.tremors = { { 2, 5.5, 10, 15, 55 } }; add(s); }
  { Scenario s; s.name = "tremor_walk_nonharmonic"; s.desc = "Walking 1.8 steps/s with 'no-no' 5.0 Hz 12 dps (not a step harmonic)"; s.dur = 60; s.walk = true; s.stepHz = 1.8; s.tremors = { { 2, 5.0, 12, 15, 45 } }; add(s); }
  { Scenario s; s.name = "tremor_walk_harmonic"; s.desc = "Walking 2.0 steps/s with 'yes-yes' 6.0 Hz 12 dps (3x step rate: known limit)"; s.dur = 60; s.walk = true; s.stepHz = 2.0; s.tremors = { { 0, 6.0, 12, 15, 45 } }; add(s); }
  { Scenario s; s.name = "combo_yes_no_diag"; s.desc = "Yes-yes + no-no together, 5 Hz, in step (diagonal), 10 dps each"; s.dur = 50; s.coherent = true; s.tremors = { { 0, 5.0, 10, 10, 40 }, { 2, 5.0, 10, 10, 40 } }; add(s); }
  { Scenario s; s.name = "combo_yes_no_circ"; s.desc = "Yes-yes + no-no together, 5 Hz, quarter cycle apart (circular), 10 dps each"; s.dur = 50; s.coherent = true; s.tremors = { { 0, 5.0, 10, 10, 40 }, { 2, 5.0, 10, 10, 40, M_PI / 2 } }; add(s); }
  { Scenario s; s.name = "combo_two_freq"; s.desc = "Two independent tremors: yes-yes 4.4 Hz 8 dps + no-no 5.6 Hz 10 dps"; s.dur = 50; s.tremors = { { 0, 4.4, 8, 10, 40 }, { 2, 5.6, 10, 10, 40 } }; add(s); }
  { Scenario s; s.name = "combo_partial"; s.desc = "No-no 5 Hz 12 dps for 30 s; yes-yes joins for the middle 10 s"; s.dur = 50; s.coherent = true; s.tremors = { { 2, 5.0, 12, 10, 40 }, { 0, 5.0, 9, 20, 30 } }; add(s); }
  { Scenario s; s.name = "crosstalk_no_15deg"; s.desc = "Pure no-no 5 Hz 12 dps, board tilted 15 deg (26 % leaks into pitch): must stay single-axis"; s.dur = 50; s.crossTalk = 0.26; s.tremors = { { 2, 5.0, 12, 10, 40 } }; add(s); }
  { Scenario s; s.name = "fall"; s.desc = "Still, free fall 0.35 s, ~9 g impact, lying still"; s.dur = 30; s.fall = true; s.fallT = 10; add(s); }
  { Scenario s; s.name = "showcase"; s.desc = "Demo recording: still, no-no tremor, walking, yes-yes tremor, finger off (120 s)"; s.dur = 120;
    s.walk = true; s.stepHz = 1.9; s.walkT0 = 36; s.walkT1 = 56;
    s.tremors = { { 2, 5.2, 12, 10, 28 }, { 0, 4.6, 9, 62, 76 } }; s.fingerOff0 = 92; s.fingerOff1 = 106; add(s); }
  { Scenario s; s.name = "no_finger"; s.desc = "Still; finger off the PPG sensor from 10 s to 30 s"; s.dur = 50; s.fingerOff0 = 10; s.fingerOff1 = 30; add(s); }
  return v;
}

// ---------- scoring ----------
struct Frame { double t; std::vector<double> f; };

}  // namespace hostsim

// =====================================================================================
int main(int argc, char **argv) {
  using namespace hostsim;
  std::string name, csvPath;
  unsigned seed = 1;
  int sens = 2;
  bool realtime = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
    if (a == "--scenario") name = next();
    else if (a == "--seed") seed = (unsigned)std::stoul(next());
    else if (a == "--sens") sens = std::stoi(next());
    else if (a == "--csv") csvPath = next();
    else if (a == "--realtime") realtime = true;
    else if (a == "--list") {
      for (auto &s : scenarios()) printf("%s\t%g\t%s\n", s.name.c_str(), s.dur, s.desc.c_str());
      return 0;
    }
  }
  Scenario sc;
  bool found = false;
  for (auto &s : scenarios()) if (s.name == name) { sc = s; found = true; }
  if (!found) { fprintf(stderr, "unknown scenario '%s' (use --list)\n", name.c_str()); return 2; }

  M.build(sc, seed);
  ppgPresent = sc.ppg;
  Mpu6050 mpu;
  mpu.rng.seed(seed * 31u + 7u);
  prng.seed(seed * 131u + 3u);
  Wire.devices[0x68] = &mpu;

  FILE *csv = csvPath.empty() ? nullptr : fopen(csvPath.c_str(), "w");
  setup();
  if (sens != 2) { Serial.rx.push_back((char)('0' + sens)); }

  const double END = WARM + sc.dur;
  std::vector<Frame> frames;
  std::string pending;
  auto wall0 = std::chrono::steady_clock::now();
  double simT0 = nowUs * 1e-6;
  while (nowUs * 1e-6 < END) {
    loop();
    nowUs += 250;
    if (!Serial.out.empty()) {
      pending += Serial.out;
      Serial.out.clear();
      size_t p;
      while ((p = pending.find('\n')) != std::string::npos) {
        std::string line = pending.substr(0, p);
        pending.erase(0, p + 1);
        if (realtime) {
          double ahead = nowUs * 1e-6 - simT0 - std::chrono::duration<double>(std::chrono::steady_clock::now() - wall0).count();
          if (ahead > 0.002) std::this_thread::sleep_for(std::chrono::duration<double>(ahead));
          fputs(line.c_str(), stdout); fputc('\n', stdout); fflush(stdout);
        }
        if (csv) fprintf(csv, "%.3f,%s\n", nowUs * 1e-6, line.c_str());
        if (line.empty() || line[0] != '$') continue;
        Frame fr; fr.t = nowUs * 1e-6;
        size_t s = 2;
        while (s <= line.size()) {
          size_t e = line.find(',', s);
          if (e == std::string::npos) e = line.size();
          fr.f.push_back(atof(line.substr(s, e - s).c_str()));
          s = e + 1;
        }
        frames.push_back(fr);
      }
    }
  }
  if (csv) fclose(csv);
  if (realtime) return 0;

  // fields (0-based after '$'): 6 tremor, 7 dir, 11 freq, 13 walking, 16 bpm, 17 spo2, 18 ppgState
  const double MEASURE_FROM = WARM + 1.0, ONSET_GRACE = 2.5, OFF_GRACE = 2.5;
  long nNeg = 0, nNegAlert = 0, nPos = 0, nPosHit = 0, nPosAxis = 0, falseEp = 0, nWalkFrames = 0, nWalk = 0;
  long nMask = 0, nMaskExact = 0, nCombo = 0, nComboBoth = 0, nSingle = 0, nSingleExtra = 0;
  double aMaxReported = 0;
  double freqErrSum = 0; long freqN = 0;
  double latency = -1;
  int prev = 0;
  double firstTremorT0 = sc.tremors.empty() ? -1 : WARM + sc.tremors[0].t0;
  double firstValidPpg = -1, bpmSum = 0; long bpmN = 0;
  for (auto &fr : frames) {
    if (fr.f.size() < 13) continue;
    double t = fr.t;
    int tr = (int)fr.f[6], dir = (int)fr.f[7];
    if (t >= MEASURE_FROM) {
      int truth = M.tremorTruth(t);
      bool grace = M.nearTremor(t, OFF_GRACE) && truth < 0;
      if (truth < 0 && !grace) {
        nNeg++;
        if (tr) nNegAlert++;
        if (tr && !prev) falseEp++;
      }
      if (truth >= 0) {
        if (latency < 0 && tr && firstTremorT0 >= 0 && t >= firstTremorT0) latency = t - firstTremorT0;
        double rel = t - WARM;
        bool settled = false;
        for (auto &trm : sc.tremors) if (rel >= trm.t0 + ONSET_GRACE && rel < trm.t1) settled = true;
        if (settled) {
          nPos++;
          if (tr) {
            nPosHit++;
            int tm = M.truthMask(t);
            if ((tm >> dir) & 1) nPosAxis++;
            for (auto &trm : sc.tremors) if (rel >= trm.t0 && rel < trm.t1 && trm.axis == dir) { freqErrSum += fabs(fr.f[11] - trm.f); freqN++; }
            if (fr.f.size() > 20) {
              int mk = (int)fr.f[20];
              // judge the mask only once each axis has been on for the onset grace
              int settledMask = 0;
              for (auto &trm : sc.tremors) if (rel >= trm.t0 + ONSET_GRACE && rel < trm.t1) settledMask |= 1 << trm.axis;
              if (settledMask == tm) {
                nMask++;
                if (mk == tm) nMaskExact++;
                if (__builtin_popcount(tm) >= 2) { nCombo++; if ((mk & tm) == tm) nComboBoth++; }
                else { nSingle++; if (__builtin_popcount(mk) > 1) nSingleExtra++; }
              }
            }
          }
        }
      }
      if (sc.walk && fr.f.size() > 13) { nWalkFrames++; if (fr.f[13] > 0) nWalk++; }
    }
    prev = tr;
    if (fr.f.size() > 21) aMaxReported = std::max(aMaxReported, fr.f[21]);
    if (fr.f.size() > 18 && fr.f[18] == 3) {
      if (firstValidPpg < 0) firstValidPpg = t;
      if (t > WARM + 10 && M.finger(t)) { bpmSum += fr.f[16]; bpmN++; }
    }
  }
  printf("{\"scenario\":\"%s\",\"seed\":%u,\"sens\":%d,\"frames\":%zu,"
         "\"falseAlertFrac\":%.4f,\"falseEpisodes\":%ld,\"recall\":%s,\"axisCorrect\":%s,\"latencyS\":%s,"
         "\"freqErrHz\":%s,\"walkDetectedFrac\":%s,\"accSaturated\":%ld,\"gyroSaturated\":%ld,"
         "\"maxAccDemandG\":%.2f,\"maxAccServedG\":%.2f,\"ppgFirstValidS\":%s,\"bpmMean\":%s,"
         "\"maskExact\":%s,\"comboBoth\":%s,\"singleExtra\":%s,\"aMaxReportedG\":%.2f}\n",
         sc.name.c_str(), seed, sens, frames.size(),
         nNeg ? (double)nNegAlert / nNeg : 0.0, falseEp,
         nPos ? std::to_string((double)nPosHit / nPos).c_str() : "null",
         nPosHit ? std::to_string((double)nPosAxis / nPosHit).c_str() : "null",
         latency >= 0 ? std::to_string(latency).c_str() : "null",
         freqN ? std::to_string(freqErrSum / freqN).c_str() : "null",
         nWalkFrames ? std::to_string((double)nWalk / nWalkFrames).c_str() : "null",
         mpu.satAcc, mpu.satGyr, mpu.maxAccDemand, mpu.maxAccServed,
         firstValidPpg >= 0 ? std::to_string(firstValidPpg - WARM).c_str() : "null",
         bpmN ? std::to_string(bpmSum / bpmN).c_str() : "null",
         nMask ? std::to_string((double)nMaskExact / nMask).c_str() : "null",
         nCombo ? std::to_string((double)nComboBoth / nCombo).c_str() : "null",
         nSingle ? std::to_string((double)nSingleExtra / nSingle).c_str() : "null",
         aMaxReported);
  return 0;
}
