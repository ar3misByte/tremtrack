// One output frame of the detector (50 per second) and its text form, the '$' line.
// The text form is the protocol in docs/TELEMETRY_PROTOCOL.md section 1; the struct is what the
// network task and the cloud reporter consume, so nothing has to parse text on the device.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

struct HtmFrame {
  float pitch, roll, yaw;              // degrees
  float fP, fR, fY;                    // band-passed gyro (dps)
  uint8_t tremor, dir;                 // alert flag, active / strongest axis (0 pitch, 1 roll, 2 yaw)
  float ampP, ampR, ampY;              // band amplitude per axis (dps)
  float freq, q;
  uint8_t walking;
  float stepHz;
  int cycles;
  int bpm, spo2, ppgState;
  float pulse;
  int axes;                            // bit mask of shaking axes
  float aMax, aMin;                    // |a| extremes (g) since the previous frame
  int magq;                            // compass: 0 not fitted, 1 not calibrated, 2 calibrated but ignored now, 3 correcting yaw, 4 calibrating
};

/** Values are rounded to the precision they are printed with, so the reporter sees exactly what a
 *  receiver of the text line sees (the host-simulator differential test relies on it). */
static inline float htmRound(float x, float scale) { return roundf(x * scale) / scale; }

static inline int htmFormatFrame(char *buf, size_t n, const HtmFrame &f) {
  return snprintf(buf, n, "$,%.1f,%.1f,%.1f,%.2f,%.2f,%.2f,%d,%d,%.1f,%.1f,%.1f,%.1f,%.2f,%d,%.2f,%d,%d,%d,%d,%.1f,%d,%.2f,%.2f,%d\n",
                  f.pitch, f.roll, f.yaw, f.fP, f.fR, f.fY, f.tremor ? 1 : 0, (int)f.dir,
                  f.ampP, f.ampR, f.ampY, f.freq, f.q, f.walking ? 1 : 0, f.stepHz, f.cycles,
                  f.bpm, f.spo2, f.ppgState, f.pulse, f.axes, f.aMax, f.aMin, f.magq);
}

#ifdef HTM_HOSTSIM
// The host simulator sets this to observe every frame (cloud-reporter differential test).
#define HTM_HAVE_FRAME_HOOK 1
inline void (*htmFrameHook)(const HtmFrame &) = nullptr;
#endif
