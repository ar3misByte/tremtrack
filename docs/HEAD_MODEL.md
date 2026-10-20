# 3D head model

**Source:** procedural, built in code at runtime in `app/src/components/headModel.ts` from three.js primitives (spheres, tori, tubes, a rounded box). No third-party model file is used, so no licence or attribution applies to the model itself. three.js (including `RoundedBoxGeometry` from its examples) is MIT-licensed.

**Why procedural:** the brief asked for a simple, stylised head with neutral skin, hair, and visible glasses and headset. A CC0 or CC-BY glTF with all of these is unlikely to exist. Adding accessories to a downloaded head would still need procedural parts, and the licence would need checking. Building it in code costs about 0 KB of download, loads instantly on a phone, and every colour comes from the design tokens (`--skin`, `--hair`, `--headset`, `--headset-pod`).

**Rig:** the head rotates about a pivot at the top of the neck; the neck and shoulders stay still. The world-fixed rings around the head show the shaking axis during a tremor: pitch ring for nodding, roll ring for tilting, yaw ring for turning.

**Replacing it:** if you supply a GLB, load it in `Head3D.tsx` with `GLTFLoader` (Draco or meshopt compressed), parent it to `rig.pivot`, and record its licence here and on the About screen.

**History:** a more realistic, sculpted v2 was tried after milestone 3 and reverted at the owner's request. The stylised v1 head is the chosen look.
