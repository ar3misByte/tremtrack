# Firmware

`tremor_monitor/` is the ESP32 sketch (Arduino IDE).

| File | What |
|---|---|
| `tremor_monitor.ino` | sampling at 100 Hz, orientation, the tremor and walking detectors (thresholds unchanged from the legacy sketch), pulse oximeter, output line, commands |
| `frame.h` | one output frame as a struct, and its text form (the `$` line) |
| `reporter.h` | cloud reporter: 50 Hz frames → telemetry summaries and events (episodes, falls). Plain C++, tested against the TypeScript reference |
| `mag.h` | QMC5883P compass: calibration, tilt-compensated heading, slow yaw correction. Plain C++ |
| `link.h` | Bluetooth LE, LAN WebSocket, Wi-Fi, NTP, AWS IoT MQTT. ESP32 only, runs in its own task on core 0 |
| `device_config.example.h` | shape of the generated `device_config.h` (git-ignored, holds the device key) |

## Where the data goes

- **USB serial**, 115200 baud, always: the `$` lines of `docs/TELEMETRY_PROTOCOL.md` and `#` status lines.
- **Bluetooth LE** (always on): Nordic-UART-style service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; the phone app reads the same lines and writes the commands below. Name `HeadTremor-XXXX`.
- **WebSocket** `ws://<ip>:81` once Wi-Fi is up: same lines and commands.
- **AWS IoT Core** only if `device_config.h` exists (made by `tools/aws/provision-device.mjs`): a summary every 5 s (1 s while someone watches) and events.

The sampling loop only copies a frame into a queue; a separate task does all the networking, so a slow phone or a bad Wi-Fi link cannot disturb the 100 Hz detector.

## Flash (Arduino IDE)

1. Board: **ESP32 Dev Module** (Espressif `esp32` core 3.x). **Partition Scheme: default** without the cloud (94 % full), **Huge APP (3MB No OTA/1MB SPIFFS)** with it (43 %).
2. Library Manager: **SparkFun MAX3010x Pulse and Proximity Sensor Library**, **NimBLE-Arduino**, **WebSockets** (Markus Sattler).
3. Wiring, one shared I²C bus at 3.3 V: SDA → GPIO21, SCL → GPIO22. MPU6050 at 0x68 (AD0 → GND), MAX30102 at 0x57, optional QMC5883P compass at 0x2C.
4. Upload `tremor_monitor/tremor_monitor.ino`. Close the Serial Monitor before connecting from the app over USB.
5. Keep the board still for 2 s after reset (calibration).

Step by step with a phone: `docs/PHONE_SETUP.md`.

## Commands

One line each, over Bluetooth, WebSocket or USB. The single digits `1`–`5` (sensitivity) still work as before.

| Command | Effect |
|---|---|
| `!sens N` | sensitivity 1–5 |
| `!wifi SSID<TAB>PASSWORD` | store Wi-Fi credentials in flash and connect. Over Bluetooth / WebSocket only within 10 minutes of power-up (or while none are stored); over USB always |
| `!forget` | delete the stored Wi-Fi credentials |
| `!tz MINUTES` | time zone offset east of UTC (330 = India); the app sends it on connect |
| `!fall cancelled\|confirmed\|no-response` | the phone's answer to a fall countdown. The BOOT button also means "I'm OK". With no answer within 40 s the headset reports "no-response" itself |
| `!recenter` | yaw = 0 |
| `!orient +x +z -y` | how the board sits on the head: head X (right), Y (forward), Z (up) are read from these board axes. Must be a rotation (the app offers the 24 valid ones). Stored in flash, re-calibrates for 2 s |
| `!zupt on\|off` | learn the gyro bias while the head is still (on by default; off only for tests) |
| `!mag start\|stop\|clear` | compass calibration (see `docs/ORIENTATION.md`) |
| `!info` | prints `# INFO fw=… name=… wifi=… ip=… rssi=… cloud=… time=… tz=… ble=… ws=… mag=… orient=…` |
| `!reboot` | restart |

## Output line

`$,pitch,roll,yaw,fPitch,fRoll,fYaw,tremor,dir,ampP,ampR,ampY,freq,q,walking,stepHz,cycles,bpm,spo2,ppgState,pulse,axes,aMax,aMin,magq`: fields and history in `docs/TELEMETRY_PROTOCOL.md`. Only ever appended to, so older pages and apps keep working.

## Testing without hardware

`npm run hostsim` compiles the real sketch on your computer with a mock Arduino, a synthetic MPU6050, MAX30102 and QMC5883P, and runs about 100 scenarios.

| Check | Command |
|---|---|
| Detector output unchanged against the legacy baseline (all 5 sensitivity levels) | `node tools/hostsim/run.mjs --check` |
| Cloud reporter (C++) identical to the TypeScript reference on 13 scenarios | `npm run hostsim:cloud` |
| Compass: calibration, drift, mirrored mounting, disturbance, detector unaffected | `node tools/hostsim/compass-check.mjs` |
| Board mounting (`!orient`, four mountings) and drift while still (`!zupt`) | `node tools/hostsim/orient-check.mjs` |
| The sketch compiles for the ESP32 with and without the cloud | CI (`arduino-cli compile`) |

**Not covered, because it needs a real board:** BLE and Wi-Fi radio behaviour (range, throughput, reconnects), the MQTT/TLS connection to AWS IoT Core, the QMC5883P's real register behaviour and axis directions. Everything above those layers is tested.

## Arduino IDE prototype rule

The IDE generates function prototypes above the type definitions. Functions that take custom struct references therefore need hand-written prototypes after the types (see `analyze` / `gaitAnalyze`).
