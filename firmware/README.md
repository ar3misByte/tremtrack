# Firmware

`tremor_monitor/tremor_monitor.ino` = the legacy detector (thresholds unchanged) plus, since milestone 3:
- **±8 g accelerometer range** (was ±2 g, which saturated in impacts);
- appended output fields **`axes`** (bit mask of every shaking axis, so "yes-yes" and "no-no" together are both reported), **`aMax`** and **`aMin`** (|a| extremes since the previous line, for fall detection).

The host simulator shows the alert logic and walking detection are identical to the legacy sketch at all 5 sensitivity levels (see `tools/hostsim/README.md`). The legacy page still works with this firmware (it ignores the extra fields). Next: milestone 7 (Wi-Fi, BLE, MQTT) and milestone 8 (magnetometer).

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
