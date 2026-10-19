# Firmware

`tremor_monitor/tremor_monitor.ino` is currently **byte-identical** to `legacy/tremor_stream.ino`. Changes start in milestone 3 (±8 g accelerometer range and impact detection), then milestone 7 (Wi-Fi, BLE, MQTT) and milestone 8 (magnetometer).

## Flash (Arduino IDE)
1. Board: **ESP32 Dev Module** (Espressif `esp32` core).
2. Library Manager: **SparkFun MAX3010x Pulse and Proximity Sensor Library**.
3. Wiring, one shared I2C bus:
   - MPU6050 at 0x68 (AD0 → GND), MAX30102 at 0x57.
   - SDA → GPIO21, SCL → GPIO22, VCC → 3V3, GND → GND.
4. Open `tremor_monitor/tremor_monitor.ino`, upload, and **close the Serial Monitor** before connecting from the app (only one program can own the port).
5. Keep the board still for 2 s after reset (calibration).

## Testing without hardware
`npm run hostsim` compiles this sketch on your computer and runs about 100 simulated scenario combinations (see `tools/hostsim/README.md`). Every firmware change must pass `node tools/hostsim/run.mjs --check`.

## Arduino IDE prototype rule
The IDE generates function prototypes above the type definitions. Functions that take custom struct references therefore need hand-written prototypes after the types (see `analyze` / `gaitAnalyze`). New code will use `.h` tabs where it can.
