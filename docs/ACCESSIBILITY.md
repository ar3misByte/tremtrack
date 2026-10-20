# Accessibility

The app is meant to be used by people who may have a tremor, so large targets and plain language matter more than usual. This page says what was done, what is checked automatically, and what has **not** been checked.

## What is built in

| Area | How |
|---|---|
| Colour contrast | Every text colour on every surface is a design token (`app/src/theme/tokens.css`) chosen for at least 4.5:1 (secondary text 6.2:1, accent text 5.3:1). Chart series never rely on colour alone: legend, direct labels, and a **Show as table** view |
| State is never colour only | Tremor, walking, steady, online, offline, calibrating all carry words (and an icon where there is room), not just a colour |
| Touch targets | At least 44 px on touch screens (buttons, check boxes, inputs, tab bar); the fall buttons are 56 px |
| Large text | Settings → Larger text raises the base size everywhere |
| Focus | One visible focus ring on every control; dialogs move focus in, keep Tab inside (tested), return it afterwards, and close on Escape. The fall alert focuses "I'm OK" and cannot be dismissed by accident |
| Screen readers | Landmarks and headings per screen; live regions announce "Tremor detected: …" and "Tremor ended"; the 3D head and charts have text alternatives; progress bars are named; the fall countdown is an alert dialog |
| Motion | `prefers-reduced-motion` stops pulsing and smooths transitions; nothing flashes. The 3D view can be switched to a flat 2D circle |
| Language | Plain words; no jargon without an explanation next to it; numbers always have units |
| Input | Everything works from the keyboard; the only shortcut (`C` = recentre) is ignored while typing |

## Checked automatically

`node scripts/a11y.mjs` (axe-core, WCAG 2.0/2.1 A and AA rules plus axe best practices) on every screen, at phone width, in normal and large text, plus the connect sheet: **no violations**. `e2e:device` and `e2e:cloud` run axe again on the screens that need a headset or an account (Settings with the Headset and Compass cards while calibrating, the signed-in Cloud screen). The audit found and fixed one real issue: the compass progress bar had no accessible name.

## Not checked (be honest about it)

- **TalkBack (Android's screen reader) has not been used** with this app. Axe cannot tell whether the reading order or the wording makes sense when spoken. This is the most valuable manual test left: swipe through Live, Settings → Headset and the fall dialog.
- **Switch access, voice access and a real tremor.** Targets are large, but nobody with a tremor has tried it. The controls most likely to be hard to hit while shaking are the small chips in the Insights screen; if that matters, make them larger.
- **Windows high-contrast / forced colours** and iOS (Web Bluetooth does not exist in Safari anyway).
- Colour-blindness simulation of the 3D head's axis rings (they are also named in the text).

## A manual checklist (10 minutes, on the phone)

1. Turn on TalkBack. From *Live*, swipe through everything once: the headline, the head description, the three metrics, the vitals, the tab bar. Does each thing say what it is?
2. Trigger *Simulate a fall* (demo mode): is the alert announced, is "I'm OK" focused, can you answer with TalkBack?
3. Settings → Larger text, and Android's own font size at maximum: does anything overlap or disappear?
4. Cloud → Sign in with a keyboard only (Bluetooth keyboard or the emulator): can you reach every control?
5. Bright sunlight: is the secondary text still readable?
