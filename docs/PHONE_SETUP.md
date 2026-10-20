# Use it on your Android phone

Goal: the app installed on your phone like any other app, reading the headset (ESP32) directly over **Bluetooth**, with no router, no laptop and no account needed.

> **Honest status.** The Bluetooth, Wi-Fi and compass code in the firmware compiles for the ESP32, and the app's side is tested against a fake Bluetooth stack, the real firmware logic in a simulator, and a local mock of the cloud. **It has not yet been run on a real board with a real phone** (I have no hardware). Expect to fix small things on the first real run, and tell me what you see. Section 8 lists what to check first.

You need: an Android phone with **Chrome**, the ESP32 headset (MPU6050 + MAX30102, optionally a QMC5883P compass), a USB cable and the Arduino IDE on your computer.

---

## 1. Put the new firmware on the board (once)

1. **Arduino IDE → Boards Manager:** install **esp32 by Espressif** (3.x).
2. **Library Manager:** install
   - *SparkFun MAX3010x Pulse and Proximity Sensor Library*
   - *NimBLE-Arduino* (Bluetooth)
   - *WebSockets* by Markus Sattler (Wi-Fi streaming)
3. **Wiring** (one shared I²C bus, 3.3 V): `SDA → GPIO21`, `SCL → GPIO22`, `VCC → 3V3`, `GND → GND`.
   - MPU6050 at 0x68 (AD0 → GND), MAX30102 at 0x57.
   - **Optional compass:** QMC5883P at 0x2C on the same two wires. Without it everything works; the yaw (turning left and right) just drifts slowly.
4. Open `firmware/tremor_monitor/tremor_monitor.ino`.
5. **Tools → Board: ESP32 Dev Module.** Leave *Partition Scheme* as it is, **unless you add the cloud** (section 7), which needs *Huge APP (3MB No OTA/1MB SPIFFS)*.
6. Upload. Open the Serial Monitor at 115200 baud and check the start-up lines:
   ```
   # MPU6050 OK (WHO_AM_I = 0x68)
   # MAX30102 OK: place a fingertip on it for heart rate and SpO2
   # QMC5883P compass OK (not calibrated: ...)        (or "not found": fine)
   # Calibrating: keep the board still for 2 seconds...
   # LINK Bluetooth "HeadTremor-A1B2", WebSocket port 81, Wi-Fi not set (send !wifi), cloud off
   # Streaming
   ```
   Note the Bluetooth name (`HeadTremor-A1B2`). **Close the Serial Monitor** before using USB from the app.

## 2. Get the app onto the phone

An installable app (a "PWA") has to be served from an **https** address, and Bluetooth only works from https. Pick one:

### A. GitHub Pages (free, recommended)
1. Put this folder in a GitHub repository. GitHub Pages on a free account needs a **public** repository (a private one needs a paid plan). Nothing secret is in the repository: certificates, keys, `.env` and `device_config.h` are git-ignored. Check `git status` before pushing.
2. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`. The workflow *Publish app (GitHub Pages)* builds and publishes. When it is green, the address is `https://<your-name>.github.io/<repository>/`.
4. On the phone, open that address in **Chrome**.

### B. Any other static host
`npm install`, then `npm run build -w app`, and upload the **`app/dist`** folder to Netlify (drag and drop), Cloudflare Pages, Firebase Hosting or your own server. If it is served from a sub-folder, build with `VITE_BASE=/that-folder/`.

### C. Just to try it: your laptop on the same Wi-Fi
`npm run serve:lan` prints addresses like `http://192.168.1.20:4173`. Open one on the phone. This is plain **http**, so Chrome will **not** offer Bluetooth or "Install"; it is for the **Wi-Fi** connection (section 4) and for demo mode.

### Install it
In Chrome on the phone: **⋮ menu → Install app** (or *Add to Home screen*). It now opens full-screen from its own icon and works offline (all the history lives on the phone).

## 3. Connect over Bluetooth

1. Switch the headset on. The blue LED on some boards, or the serial line above, tells you it is running.
2. Open the app → tap the connection button at the top (*Not connected*) → **Bluetooth (phone)**.
3. Chrome asks to allow nearby devices (on Android 11 or older it also asks for *Location*; that is how Android classifies Bluetooth scanning, the app does not use your location). Pick **HeadTremor-…**.
4. Within a second or two the live view moves. The button shows **Bluetooth · 50/s**. If the link drops (you walk away), the app reconnects by itself.

Everything the USB cable gave you works the same: live 3D head, tremor alert, heart rate, falls, posture, history.

## 4. Wi-Fi (optional)

Wi-Fi is for the **cloud** (section 7) and for streaming to a laptop. Bluetooth does not need it.

1. Connect over Bluetooth first. Open **Settings → Headset**.
2. Enter your network (2.4 GHz only) and password → **Send to headset**.
3. After a few seconds the card shows *Wi-Fi: connected, 192.168.x.x*. The headset remembers it.
4. **Use its Wi-Fi address** stores `ws://192.168.x.x:81`. Then, from a page opened over **http** (section 2C), choose *Wi-Fi or simulator*.

Security note: the password travels once over Bluetooth without encryption (a few metres range). The headset accepts Wi-Fi setup over Bluetooth or Wi-Fi only in the **first 10 minutes after power-up** (power-cycle to open it again), and always over USB. `!forget` over USB deletes it.

## 5. Calibrate the compass (once, if you fitted one)

**Settings → Headset → Compass → Calibrate compass.** Hold the headset flat, away from steel and phones, and turn it slowly about the vertical axis for **one full circle** (about 15 seconds). It finishes by itself and remembers the result. The result line tells you if it needs another go. After this, the 3D head's left-right direction stays put instead of slowly drifting.

## 6. Things you can do from the phone

| | |
|---|---|
| **Recentre** | the head icon on the Live screen |
| **Sensitivity** | Settings → Sensitivity; sent to the headset |
| **Falls** | a 30 s "I'm OK / Get help" countdown appears; the headset's BOOT button also means "I'm OK" |
| **Report for a doctor** | Report tab → PDF |

## 7. The cloud (optional)

Live view from anywhere, history in your own AWS account, caregiver alerts by email. Follow `AWS_SETUP.md`. In short: deploy, `node tools/aws/provision-device.mjs`, re-flash with the generated `device_config.h` (**Partition Scheme: Huge APP**), `node tools/aws/app-link.mjs`, open the link it prints on the phone, **Cloud → Sign in → Watch live**. Costs are in `COSTS.md` (typically well under US$1 a month).

## 8. If something does not work

| Symptom | What to try |
|---|---|
| No *Bluetooth* option / greyed out | Use **Chrome** on Android, from an **https** address (not `http://`, not a desktop-served copy). |
| Headset not in the list | Is the serial line `# LINK Bluetooth "HeadTremor-…"` printed? Phone Bluetooth and Location on? Reset the board. Only one phone can be connected at a time; close the app on other devices. |
| Connects, then *Waiting for data* | Keep the board still for 2 s after reset (calibration). If the serial monitor shows lines but the phone shows none, tell me the exact text under the connection button. |
| Choppy or slow | Bluetooth with a small packet size is slow; the headset automatically sends fewer lines (10 per second) and still reports tremor and falls correctly. Moving closer helps. |
| Wi-Fi never connects | The network must be **2.4 GHz** (the ESP32 has no 5 GHz). Check the *Messages from the headset* list in Settings → Headset. |
| The page will not install | It must be https, and not in a private tab. Chrome: ⋮ → *Install app*. |
| Compass says *Not fitted* | Check the wiring (0x2C). The QMC5883P is a different chip from the older QMC5883L / HMC5883L; those use other addresses and are not supported. |
| Compass calibration is refused | Read the message: *turn about the vertical axis* (flat, not tilted), *field strength varied* (steel nearby), or *axes do not match* (the board is mounted on its side, see `docs/ORIENTATION.md`). |
| Yaw seems mirrored after calibrating | Fine: it is detected automatically. Otherwise set `HTM_MAG_FLIP_*` in `mag.h` and re-flash. |

**First real-hardware checks worth doing, in this order:** USB serial still streams as before; Bluetooth connects; Settings → Headset shows the name and firmware; the tremor alert fires when you shake the headset at about 5 Hz; Wi-Fi setup; compass calibration. If a step fails, the serial monitor lines and the app's *Messages from the headset* are the first things to send me.
