// Minimal Arduino core mock for compiling the ESP32 sketch on the host.
// Time is virtual: hostsim::nowUs only moves when the driver (sim.cpp) or delay() moves it.
#pragma once
#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif
#include <cstdint>
#include <cstddef>
#include <cmath>
#include <math.h>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <string>
#include <deque>
#define HTM_HOSTSIM 1

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef PI
#define PI 3.14159265358979323846f
#endif

namespace hostsim {
extern uint64_t nowUs;
}

inline uint32_t millis() { return (uint32_t)(hostsim::nowUs / 1000ULL); }
inline uint32_t micros() { return (uint32_t)hostsim::nowUs; }
inline void delay(uint32_t ms) { hostsim::nowUs += (uint64_t)ms * 1000ULL; }
inline void delayMicroseconds(uint32_t us) { hostsim::nowUs += us; }
inline void yield() {}

class HardwareSerial {
 public:
  std::string out;             // everything the sketch printed, drained by the driver
  std::deque<char> rx;         // bytes "typed" into the serial port by the driver

  void setTxBufferSize(size_t) {}
  void begin(uint32_t) {}
  size_t printf(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n > 0) out.append(buf, (size_t)(n < (int)sizeof buf ? n : (int)sizeof buf - 1));
    return n > 0 ? (size_t)n : 0;
  }
  size_t print(const char *s) { out += s; return strlen(s); }
  size_t print(const std::string &s) { out += s; return s.size(); }
  size_t println(const char *s = "") { out += s; out += '\n'; return strlen(s) + 1; }
  size_t println(const std::string &s) { return println(s.c_str()); }
  size_t write(uint8_t c) { out += (char)c; return 1; }
  int available() { return (int)rx.size(); }
  int read() {
    if (rx.empty()) return -1;
    int c = (unsigned char)rx.front();
    rx.pop_front();
    return c;
  }
  void flush() {}
};

extern HardwareSerial Serial;
