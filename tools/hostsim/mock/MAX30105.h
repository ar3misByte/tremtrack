// Mock of the SparkFun MAX3010x library surface the sketch uses.
// Samples come from hostsim::ppgSample(t) at 100 Hz of virtual time.
#pragma once
#include "Arduino.h"
#include "Wire.h"
#include <deque>

#ifndef I2C_SPEED_FAST
#define I2C_SPEED_FAST 400000
#endif

namespace hostsim {
extern bool ppgPresent;
void ppgSample(double tSec, float &red, float &ir);
}

class MAX30105 {
 public:
  bool begin(TwoWire &, uint32_t = I2C_SPEED_FAST, uint8_t = 0x57) { return hostsim::ppgPresent; }
  void setup(uint8_t = 0x1F, uint8_t = 4, uint8_t = 3, int = 400, int = 411, int = 4096) {
    nextUs_ = hostsim::nowUs;
  }
  uint16_t check() {
    uint16_t n = 0;
    while (nextUs_ + 10000ULL <= hostsim::nowUs) {      // 100 samples/s after 4x averaging
      nextUs_ += 10000ULL;
      float r, i;
      hostsim::ppgSample(nextUs_ * 1e-6, r, i);
      if (fifo_.size() < 32) fifo_.push_back({ (uint32_t)r, (uint32_t)i });
      n++;
    }
    return n;
  }
  bool available() { return !fifo_.empty(); }
  uint32_t getFIFORed() { return fifo_.empty() ? 0 : fifo_.front().red; }
  uint32_t getFIFOIR() { return fifo_.empty() ? 0 : fifo_.front().ir; }
  void nextSample() { if (!fifo_.empty()) fifo_.pop_front(); }

 private:
  struct S { uint32_t red, ir; };
  std::deque<S> fifo_;
  uint64_t nextUs_ = 0;
};
