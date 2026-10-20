// Cloud reporter: turns the 50 Hz frames into the cloud protocol v1 (docs/TELEMETRY_PROTOCOL.md section 3):
// a telemetry summary every `period` seconds, plus events (tremor start, episode, fall, sensitivity).
//
// Plain C++ with no Arduino dependency, so the host simulator compiles it and tests it against the
// TypeScript reference (app/src/logic/cloudSummary.ts, tracker.ts, fall.ts, severity.ts) -- see
// tools/hostsim/cloud-check.mjs. The constants below mirror app/src/config/thresholds.ts; that test
// fails when they drift apart.
//
// Known differences from the app (documented in docs/TELEMETRY_PROTOCOL.md):
//   - episodes on several axes report pattern "mixed" (the phase analysis stays in the app);
//   - posture (pf, pt) is null: the neutral pose lives in the app.
#pragma once
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "frame.h"

namespace htm {

namespace cfg {
// EPISODES
constexpr double EP_MERGE_GAP_S = 3.0, EP_MIN_S = 1.0, AXIS_MIN_SHARE = 0.3;
// SEVERITY v2 (episode score only; the daily score is computed in the cloud and in the app)
constexpr double THETA0 = 0.05, THETA_MAX = 5.0, D0 = 2.0, D_MAX = 300.0, W_I = 0.7, W_D = 0.3;
// POSTURE (stillness)
constexpr double STILL_MAX_DEG = 0.4, RESTLESS_MIN_DEG = 2.0;
// FALL
constexpr double FREEFALL_G = 0.5, FREEFALL_MIN_S = 0.1, IMPACT_G = 2.5, IMPACT_WINDOW_S = 1.0, IMPACT_ONLY_G = 4.0;
constexpr double SETTLE_S = 0.5, STILL_WINDOW_S = 2.0, STILL_MIN_G = 0.85, STILL_MAX_G = 1.15, STILL_MAX_SPREAD_DEG = 4.0, STILL_MIN_SHARE = 0.85;
constexpr double COOLDOWN_S = 15.0, CANCEL_COUNTDOWN_S = 30.0;
}  // namespace cfg

enum MsgKind { MSG_TELEMETRY = 0, MSG_EVENT = 1 };
typedef void (*EmitFn)(void *ctx, int kind, const char *json);

static inline double r1(double x) { return floor(x * 10.0 + 0.5) / 10.0; }
static inline double clamp01(double x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
static inline double logScale(double x, double x0, double xMax) { return clamp01(log1p((x > 0 ? x : 0) / x0) / log1p(xMax / x0)); }

/** Episode severity 0-10 (docs/SEVERITY.md). */
static inline double episodeScore(double ampDps, double freqHz, double durationS) {
  double theta = (ampDps > 0 && freqHz > 0) ? ampDps / (2.0 * M_PI * freqHz) : 0;
  double i = logScale(theta, cfg::THETA0, cfg::THETA_MAX);
  double d = logScale(durationS, cfg::D0, cfg::D_MAX);
  double s = 10.0 * (cfg::W_I * i + cfg::W_D * d) / (cfg::W_I + cfg::W_D);
  return s < 0 ? 0 : (s > 10 ? 10 : s);
}

class Reporter {
 public:
  void begin(uint64_t t0, EmitFn emit, void *ctx) {
    emit_ = emit; ctx_ = ctx; windowStart_ = t0;
    ep_.open = false; wasTremor_ = false; seq_ = 0; evSeq_ = 0;
    secT_ = -1; haveLast_ = false; histN_ = 0; histHead_ = 0;
    ffStart_ = -1; lastFFEnd_ = -1; pend_.on = false; cooldownUntil_ = 0; hr_ = sp_ = 0; rssi_ = 0; haveRssi_ = false;
    fallPending_ = false;
  }
  /** Telemetry period in seconds, 1..5 (1 while someone watches the live view). */
  void setPeriod(int s) { period_ = s < 1 ? 1 : (s > 5 ? 5 : s); }
  int period() const { return period_; }
  void setRssi(int dbm) { rssi_ = dbm; haveRssi_ = dbm < 0; }
  void setSensitivity(uint64_t t, int level) {
    char j[128];
    int n = head(j, sizeof j, t, "sensitivity");
    snprintf(j + n, sizeof j - n, ",\"level\":%d}", level);
    emit_(ctx_, MSG_EVENT, j);
  }
  void boot(uint64_t t, const char *fw, int tzMin) {
    char j[160];
    int n = head(j, sizeof j, t, "boot");
    snprintf(j + n, sizeof j - n, ",\"fw\":\"%s\",\"tzMin\":%d}", fw, tzMin);
    emit_(ctx_, MSG_EVENT, j);
  }
  bool fallWaiting() const { return fallPending_; }
  /** The answer to the fall countdown: "cancelled", "confirmed" or "no-response". */
  void fallOutcome(uint64_t t, const char *outcome) {
    if (!fallPending_) return;
    fallPending_ = false;
    emitFall(t, lastFall_, outcome);
  }

  void push(const HtmFrame &f, uint64_t t) {
    int axesNow = f.tremor ? (f.axes | (1 << f.dir)) : 0;
    if (f.ppgState == 3 && f.bpm > 0) { hr_ = f.bpm; if (f.spo2 > 0) sp_ = f.spo2; }
    if (f.ppgState != 3) { hr_ = 0; sp_ = 0; }
    if (f.tremor && !wasTremor_) {
      char j[160];
      int n = head(j, sizeof j, t, "tremor_start");
      snprintf(j + n, sizeof j - n, ",\"ax\":%d,\"f\":%.1f}", axesNow ? axesNow : (1 << f.dir), r1(f.freq));
      emit_(ctx_, MSG_EVENT, j);
    }
    wasTremor_ = f.tremor;

    seconds(f, t);
    bool fell = falls(f, t);
    if (fell) {
      emitFall(t, lastFall_, "pending");
      fallPending_ = true; fallAt_ = t;
    }
    episodes(f, t, axesNow);

    // a fall nobody answered: report it after the countdown plus a grace period for the phone
    if (fallPending_ && t - fallAt_ > (uint64_t)((cfg::CANCEL_COUNTDOWN_S + 10.0) * 1000.0)) fallOutcome(t, "no-response");

    last_ = f; haveLast_ = true;
    if (t - windowStart_ >= (uint64_t)period_ * 1000ULL) { telemetry(f, t, axesNow); windowStart_ = t; }
  }

 private:
  // ---------------- state ----------------
  EmitFn emit_ = nullptr; void *ctx_ = nullptr;
  int period_ = 5;
  uint32_t seq_ = 0, evSeq_ = 0;
  uint64_t windowStart_ = 0;
  bool wasTremor_ = false;
  HtmFrame last_{}; bool haveLast_ = false;
  int hr_ = 0, sp_ = 0, rssi_ = 0; bool haveRssi_ = false;

  struct Ep {
    bool open; uint64_t start, lastAlert; int n; int axisN[3]; double ampSum; int freqN; double freqSum; int bpmN; double bpmSum;
    int axActN[3]; double axAmpSum[3];
  } ep_{};

  // one-second statistics for the motion state
  int64_t secT_ = -1; int secN_ = 0; double sp_s_[3] = {0, 0, 0}, sp2_[3] = {0, 0, 0}; int secWalk_ = 0;
  double lastMotionDeg_ = 0, lastWalkFrac_ = 0;

  // fall detector
  struct Hist { uint64_t t; float p, r; };
  Hist hist_[160]; int histN_ = 0, histHead_ = 0;
  int64_t ffStart_ = -1, lastFFEnd_ = -1; double lastFFMs_ = 0;
  struct Pend { bool on; uint64_t t; double peak; bool ff; double ffMs; bool havePre; double preP, preR; int n, still; double sp, sp2, sr, sr2; } pend_{};
  uint64_t cooldownUntil_ = 0;
  struct FallInfo { uint64_t t; bool ff; double peak, ffMs, change; } lastFall_{};
  bool fallPending_ = false; uint64_t fallAt_ = 0;

  // ---------------- helpers ----------------
  int head(char *b, size_t n, uint64_t t, const char *type) {
    return snprintf(b, n, "{\"v\":1,\"seq\":%lu,\"ts\":%llu,\"type\":\"%s\"", (unsigned long)evSeq_++, (unsigned long long)t, type);
  }

  void emitFall(uint64_t t, const FallInfo &c, const char *outcome) {
    char j[320];
    int n = head(j, sizeof j, t, "fall");
    snprintf(j + n, sizeof j - n, ",\"fall\":{\"t\":%llu,\"path\":\"%s\",\"peakG\":%.1f,\"freeFallMs\":%.0f,\"orientationChangeDeg\":%.0f,\"outcome\":\"%s\"}}",
             (unsigned long long)c.t, c.ff ? "freefall+impact" : "impact", r1(c.peak), floor(c.ffMs + 0.5), floor(c.change + 0.5), outcome);
    emit_(ctx_, MSG_EVENT, j);
  }

  // ---------------- 1 Hz samples: stillness ----------------
  void seconds(const HtmFrame &f, uint64_t t) {
    int64_t sec = (int64_t)(t / 1000ULL);
    if (secT_ >= 0 && secT_ != sec) finishSecond();
    if (secT_ != sec) { secT_ = sec; secN_ = 0; secWalk_ = 0; for (int i = 0; i < 3; i++) sp_s_[i] = sp2_[i] = 0; }
    secN_++;
    const double v[3] = {f.pitch, f.roll, f.yaw};
    for (int i = 0; i < 3; i++) { sp_s_[i] += v[i]; sp2_[i] += v[i] * v[i]; }
    if (f.walking) secWalk_++;
  }
  void finishSecond() {
    double n = secN_ ? secN_ : 1, var = 0;
    for (int i = 0; i < 3; i++) { double m = sp_s_[i] / n, v = sp2_[i] / n - m * m; var += v > 0 ? v : 0; }
    lastMotionDeg_ = sqrt(var); lastWalkFrac_ = secWalk_ / n; haveSecond_ = true;
  }
  bool haveSecond_ = false;
  const char *state(const HtmFrame &f) const {
    if (f.walking) return "walking";
    if (!haveSecond_) return "normal";
    if (lastWalkFrac_ >= 0.5) return "walking";
    if (lastMotionDeg_ <= cfg::STILL_MAX_DEG) return "still";
    if (lastMotionDeg_ >= cfg::RESTLESS_MIN_DEG) return "restless";
    return "normal";
  }

  // ---------------- episodes ----------------
  void episodes(const HtmFrame &f, uint64_t t, int axesNow) {
    if (f.tremor) {
      if (!ep_.open) { memset(&ep_, 0, sizeof ep_); ep_.open = true; ep_.start = t; }
      const double amps[3] = {f.ampP, f.ampR, f.ampY};
      ep_.lastAlert = t; ep_.n++; ep_.axisN[f.dir]++; ep_.ampSum += amps[f.dir];
      if (f.freq > 0) { ep_.freqSum += f.freq; ep_.freqN++; }
      if (f.ppgState == 3 && f.bpm > 0) { ep_.bpmSum += f.bpm; ep_.bpmN++; }
      for (int i = 0; i < 3; i++) if ((axesNow >> i) & 1) { ep_.axActN[i]++; ep_.axAmpSum[i] += amps[i]; }
    } else if (ep_.open && (double)(t - ep_.lastAlert) > cfg::EP_MERGE_GAP_S * 1000.0) {
      finishEpisode(t);
    }
  }
  struct Built { int axes[3]; int nAxes; double amp, freq, dur, score, bpm; bool hasBpm; };
  Built build() const {
    Built b{};
    int axis = 0;
    for (int i = 1; i < 3; i++) if (ep_.axisN[i] > ep_.axisN[axis]) axis = i;
    double byAxis[3];
    for (int i = 0; i < 3; i++) {
      double frac = ep_.n ? (double)ep_.axActN[i] / ep_.n : 0;
      byAxis[i] = ep_.axActN[i] ? ep_.axAmpSum[i] / ep_.axActN[i] : 0;
      if (i == axis || frac >= cfg::AXIS_MIN_SHARE) b.axes[b.nAxes++] = i;
    }
    if (b.nAxes > 1) { double s = 0; for (int k = 0; k < b.nAxes; k++) s += byAxis[b.axes[k]] * byAxis[b.axes[k]]; b.amp = sqrt(s); }
    else b.amp = ep_.n ? ep_.ampSum / ep_.n : 0;
    b.freq = ep_.freqN ? ep_.freqSum / ep_.freqN : 0;
    double d = ((double)(ep_.lastAlert - ep_.start)) / 1000.0 + 0.02;
    b.dur = d > 0 ? d : 0;
    b.score = episodeScore(b.amp, b.freq, b.dur);
    b.hasBpm = ep_.bpmN > 0; b.bpm = ep_.bpmN ? ep_.bpmSum / ep_.bpmN : 0;
    return b;
  }
  void finishEpisode(uint64_t t) {
    Built b = build();
    ep_.open = false;
    if (b.dur < cfg::EP_MIN_S) return;
    char j[400];
    int n = head(j, sizeof j, t, "episode");
    n += snprintf(j + n, sizeof j - n, ",\"ep\":{\"start\":%llu,\"end\":%llu,\"durationS\":%.1f,\"axes\":[", (unsigned long long)ep_.start, (unsigned long long)ep_.lastAlert, r1(b.dur));
    for (int k = 0; k < b.nAxes; k++) n += snprintf(j + n, sizeof j - n, k ? ",%d" : "%d", b.axes[k]);
    n += snprintf(j + n, sizeof j - n, "],\"pattern\":\"%s\",\"ampDps\":%.1f,\"freqHz\":%.1f,\"score\":%.1f,\"bpm\":", b.nAxes > 1 ? "mixed" : "single", r1(b.amp), r1(b.freq), r1(b.score));
    if (b.hasBpm) n += snprintf(j + n, sizeof j - n, "%.0f}}", floor(b.bpm + 0.5)); else n += snprintf(j + n, sizeof j - n, "null}}");
    emit_(ctx_, MSG_EVENT, j);
  }

  // ---------------- falls (mirrors app/src/logic/fall.ts) ----------------
  bool falls(const HtmFrame &f, uint64_t t) {
    // history of orientation, 3 s
    hist_[histHead_] = {t, f.pitch, f.roll};
    histHead_ = (histHead_ + 1) % 160; if (histN_ < 160) histN_++;

    if (f.aMin < cfg::FREEFALL_G) { if (ffStart_ < 0) ffStart_ = (int64_t)t; }
    else if (ffStart_ >= 0) {
      double ms = (double)((int64_t)t - ffStart_);
      if (ms >= cfg::FREEFALL_MIN_S * 1000.0) { lastFFEnd_ = (int64_t)t; lastFFMs_ = ms; }
      ffStart_ = -1;
    }

    if (!pend_.on && t >= cooldownUntil_) {
      bool afterFF = lastFFEnd_ >= 0 && (double)((int64_t)t - lastFFEnd_) <= cfg::IMPACT_WINDOW_S * 1000.0 && f.aMax >= cfg::IMPACT_G;
      if (afterFF || f.aMax >= cfg::IMPACT_ONLY_G) {
        pend_ = Pend{}; pend_.on = true; pend_.t = t; pend_.peak = f.aMax; pend_.ff = afterFF; pend_.ffMs = afterFF ? lastFFMs_ : 0;
        double sp = 0, sr = 0; int n = 0;
        for (int k = 0; k < histN_; k++) {
          const Hist &h = hist_[(histHead_ - 1 - k + 160 * 2) % 160];
          if (h.t >= t - 2500 && h.t <= t - 1000) { sp += h.p; sr += h.r; n++; }
        }
        if (n) { pend_.havePre = true; pend_.preP = sp / n; pend_.preR = sr / n; }
        lastFFEnd_ = -1;
        return false;
      }
    }
    if (!pend_.on) return false;
    double dt = (double)(t - pend_.t);
    if (dt < cfg::SETTLE_S * 1000.0) { if (f.aMax > pend_.peak) pend_.peak = f.aMax; return false; }
    if (dt <= (cfg::SETTLE_S + cfg::STILL_WINDOW_S) * 1000.0) {
      pend_.n++;
      if (!f.walking && f.aMax <= cfg::STILL_MAX_G && f.aMin >= cfg::STILL_MIN_G) pend_.still++;
      pend_.sp += f.pitch; pend_.sp2 += (double)f.pitch * f.pitch; pend_.sr += f.roll; pend_.sr2 += (double)f.roll * f.roll;
      return false;
    }
    Pend p = pend_; pend_.on = false;
    double n = p.n ? p.n : 1;
    double stillShare = p.n ? (double)p.still / p.n : 0;
    double mp = p.sp / n, mr = p.sr / n;
    double vp = p.sp2 / n - mp * mp, vr = p.sr2 / n - mr * mr;
    double spread = sqrt((vp > 0 ? vp : 0) + (vr > 0 ? vr : 0));
    double change = p.havePre ? fmax(fabs(mp - p.preP), fabs(mr - p.preR)) : 0;
    if (!(stillShare >= cfg::STILL_MIN_SHARE && spread <= cfg::STILL_MAX_SPREAD_DEG)) return false;
    cooldownUntil_ = t + (uint64_t)(cfg::COOLDOWN_S * 1000.0);
    lastFall_ = FallInfo{p.t, p.ff, p.peak, p.ffMs, change};
    return true;
  }

  // ---------------- telemetry ----------------
  void telemetry(const HtmFrame &f, uint64_t t, int axesNow) {
    char j[480];
    double amp;
    int nax = __builtin_popcount(axesNow);
    if (nax > 1) { double s = 0; const double a[3] = {f.ampP, f.ampR, f.ampY}; for (int i = 0; i < 3; i++) if ((axesNow >> i) & 1) s += a[i] * a[i]; amp = sqrt(s); }
    else amp = fmax(f.ampP, fmax(f.ampR, f.ampY));
    double sev = ep_.open ? r1(build().score) : 0;
    double yaw = fmod((double)f.yaw + 540.0, 360.0) - 180.0;
    int n = snprintf(j, sizeof j,
      "{\"v\":1,\"seq\":%lu,\"ts\":%llu,\"per\":%d,\"p\":%.1f,\"r\":%.1f,\"y\":%.1f,\"tr\":%d,\"ax\":%d,\"dir\":%d,\"f\":%.1f,\"a\":%.1f,\"sev\":%.1f,\"wk\":%d,",
      (unsigned long)seq_++, (unsigned long long)t, period_, r1(f.pitch), r1(f.roll), r1(yaw), f.tremor ? 1 : 0, f.tremor ? (axesNow ? axesNow : (1 << f.dir)) : 0, (int)f.dir,
      r1(f.freq), r1(amp), sev, f.walking ? 1 : 0);
    if (hr_ > 0) n += snprintf(j + n, sizeof j - n, "\"hr\":%d,", hr_); else n += snprintf(j + n, sizeof j - n, "\"hr\":null,");
    if (sp_ > 0) n += snprintf(j + n, sizeof j - n, "\"sp\":%d,", sp_); else n += snprintf(j + n, sizeof j - n, "\"sp\":null,");
    n += snprintf(j + n, sizeof j - n, "\"ppg\":%d,\"pf\":null,\"pt\":null,\"st\":\"%s\",", f.ppgState < 0 ? 0 : f.ppgState, state(f));
    if (haveRssi_) n += snprintf(j + n, sizeof j - n, "\"rssi\":%d,", rssi_); else n += snprintf(j + n, sizeof j - n, "\"rssi\":null,");
    snprintf(j + n, sizeof j - n, "\"bat\":null}");
    emit_(ctx_, MSG_TELEMETRY, j);
  }
};

}  // namespace htm
