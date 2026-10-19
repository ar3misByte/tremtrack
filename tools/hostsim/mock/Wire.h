// I2C bus mock. Devices register at an address; a write's first byte is the register pointer,
// further bytes are register writes with auto-increment (MPU6050 / QMC5883P / MAX30102 style).
#pragma once
#include "Arduino.h"
#include <vector>

struct I2CDevice {
  virtual ~I2CDevice() {}
  virtual void write(const uint8_t *data, int n) = 0;   // one complete transmission
  virtual int read(uint8_t *out, int n) = 0;            // returns bytes provided
};

class TwoWire {
 public:
  I2CDevice *devices[128] = {};

  bool begin(int = -1, int = -1, uint32_t = 0) { return true; }
  void setClock(uint32_t) {}
  void beginTransmission(int addr) { addr_ = (uint8_t)addr; tx_.clear(); }
  size_t write(uint8_t b) { tx_.push_back(b); return 1; }
  uint8_t endTransmission(bool = true) {
    I2CDevice *d = devices[addr_ & 0x7F];
    if (!d) return 2;                                   // NACK on address
    if (!tx_.empty()) d->write(tx_.data(), (int)tx_.size());
    return 0;
  }
  uint8_t requestFrom(int addr, int n, int = 1) {
    I2CDevice *d = devices[addr & 0x7F];
    rpos_ = rlen_ = 0;
    if (!d || n <= 0) return 0;
    rx_.assign((size_t)n, 0);
    rlen_ = d->read(rx_.data(), n);
    return (uint8_t)rlen_;
  }
  int available() { return rlen_ - rpos_; }
  int read() { return rpos_ < rlen_ ? rx_[(size_t)rpos_++] : -1; }

 private:
  uint8_t addr_ = 0;
  std::vector<uint8_t> tx_, rx_;
  int rpos_ = 0, rlen_ = 0;
};

extern TwoWire Wire;
