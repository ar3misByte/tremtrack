# Stage demo script (about 6 minutes)

Written for presenting on an Android phone, with the headset on your head or on a table. Every step has a fallback that is one tap away, so the demo never depends on one radio link.

> **Say it first, once:** "This is a prototype that tracks head motion. It is not a medical device, it does not diagnose anything, and it has not been clinically validated."

## The day before (15 minutes)

| Do | Why |
|---|---|
| Flash the latest `firmware/tremor_monitor`, check the serial lines (`docs/PHONE_SETUP.md` §1) | the version on the board is the one you test |
| Install the app from your https address and open it once online | it then works with no network at all |
| Phone: Bluetooth and Location on, battery above 60 %, Do Not Disturb on | a notification over the 3D head is distracting |
| **Settings → Headset → Calibrate compass** (flat, one slow turn) | the head then stays facing front instead of slowly turning |
| **Settings → Load 4 weeks of sample history** | Trends, Insights and the Report need data; it is labelled as sample data and removable |
| **Live → Calibrate neutral position** (posture, 3 s still) | posture prompts make sense |
| Settings → Larger text (if the room is big) | readable from the back |
| Cloud (optional): sign in, check *Online* | the live remote view is the best 30 seconds of the demo |
| Rehearse the **fall** step with *Simulate a fall* in demo mode, not by dropping the headset | a real drop is a real risk to the board |

Have a laptop open with the same app at the same address and the headset's USB cable in your pocket.

## The script

| Time | Say / do | What the audience sees | If it fails |
|---|---|---|---|
| 0:00 | The disclaimer above. One sentence on who it is for: self-tracking and talking to a doctor. | Live screen, *Not connected* | |
| 0:30 | Tap the connection button → **Bluetooth** → `HeadTremor-…`. | the 3D head starts following your head; pill shows *Bluetooth · 50/s* | Tap again; or **USB cable** on the laptop; or **Demo mode** (say "this is simulated, the real thing is the same screen") |
| 1:00 | Turn your head slowly; nod; tilt. Tap the recentre icon. | the head mirrors you; the compass keeps *straight ahead* steady | |
| 1:30 | Shake your head "no" at about 5 times a second for 3 seconds. | **Tremor detected**, *Turning ("no-no")*, frequency about 5 Hz, amplitude; the circle view shows the pattern | Use **Demo mode → Manual → Turn** |
| 2:15 | Shake "yes" and "no" together. | *Nodding + Turning* combined, with the pattern (diagonal / circular / two rhythms) | Demo mode → Manual → Turn + Nod |
| 2:45 | Walk a few steps with the headset on. | *Walking*: step bounce is ignored, as the text explains | Demo mode (scripted showcase includes walking) |
| 3:15 | Put a finger on the pulse sensor. | heart rate and an SpO₂ *estimate*. Say "uncalibrated, hobby sensor" | Skip; the showcase replay shows it |
| 3:45 | **Fall**: Settings is not needed. In demo mode tap *Simulate a fall*; show the 30 s countdown; tap **I'm OK**. | the alert, the countdown, the result saved in Trends. Say what a fall alert is and is not (a heuristic; misses slow slumps; a dropped headset looks like a fall) | |
| 4:15 | **Trends** → days, score, the week summary. **Insights** → tag and medication comparisons with effect sizes and "not enough data" where it applies. | honest statistics: intervals, no causes | |
| 5:00 | **Report** → *Make the PDF*. | a one-page-per-section summary for a doctor, with the disclaimer | |
| 5:30 | **Cloud** → *Watch live* on a second phone or the laptop while you shake your head. | the remote view updates every second; optionally the caregiver email arrives after an unanswered fall | skip, or show the 30-day chart |
| 6:00 | Close with the limits (About screen): simulated tests only so far, optional cloud, no diagnosis. | | |

## What not to say

- "It detects Parkinson's / essential tremor / any disease." It reports a rhythmic head shake between 3.5 and 8.5 Hz and a score. The *pattern hints* say "consistent with…" and are flagged as not clinically reviewed.
- "SpO₂ is accurate." It is an uncalibrated estimate.
- "Falls are always detected." They are not.
- "The score is a clinical scale." It is an engineering score for self-tracking.
- "It has been tested on patients." It has been tested on simulated motion, in simulators.

## Fallback ladder (all one tap)

1. Bluetooth drops → the app reconnects by itself (watch the pill); if not, tap it and choose the headset again.
2. Bluetooth will not connect → **USB cable** from the laptop (close the Arduino Serial Monitor first).
3. Headset dead → **Replay a recording → Showcase, 2 min**: real firmware output replayed in real time (still, "no-no", walking, "yes-yes", finger off), or **Demo mode** for manual control.
4. No network → everything above works offline; only *Cloud* needs a connection.
