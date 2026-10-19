# 3D head model

**Source:** procedural, built in code at runtime in `app/src/components/headModel.ts`. No third-party model file is used, so no licence or attribution applies to the model itself. three.js (including `RoundedBoxGeometry` from its examples) is MIT-licensed.

**How it is built (v2, flush):**
- **One sculpted skull mesh:** a high-resolution sphere is displaced by a `sculpt()` function. Jaw taper, chin, cheekbones, brow ridge, eye sockets, nose (ridge, tip, alae), lips, philtrum, and an occiput that curves into the neck are all part of the same surface, so there are no seams.
- **Hair:** the same surface pushed outward where a soft hairline mask says hair grows (forehead, receding temples, down to the nape), thicker at the crown with a small front lift. Where there is no hair it sits just inside the skin, so the hairline is continuous.
- **Accessories fitted to the surface by ray-casting:** eyes set into the sockets (sclera, iris, pupil, a skin eyelid), brows along the brow ridge, bevelled C-shaped ears set flush into the sides, glasses with rounded rims and temples that follow the side of the head to the ears, and a headband that follows the hair surface, lower at the forehead, carrying the sensor pod.
- **Neck and shoulders:** smooth lathe profiles; the torso has a closed top, so no gap shows from any camera angle.

**Why procedural:** the brief asked for a simple, stylised head with neutral skin, hair, and visible glasses and headset. A CC0 or CC-BY glTF with all of these is unlikely to exist. Adding accessories to a downloaded head would still need procedural parts, and the licence would need checking. Building it in code costs about 0 KB of download, loads instantly on a phone, and every colour comes from the design tokens (`--skin`, `--hair`, `--headset`, `--headset-pod`).

**Rig:** the head rotates about a pivot at the top of the neck; the neck and shoulders stay still. The world-fixed rings around the head show the shaking axis during a tremor: pitch ring for nodding, roll ring for tilting, yaw ring for turning.

**Replacing it:** if you supply a GLB, load it in `Head3D.tsx` with `GLTFLoader` (Draco or meshopt compressed), parent it to `rig.pivot`, and record its licence here and on the About screen.
