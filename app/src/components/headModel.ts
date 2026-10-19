// Procedural, stylised head: neutral skin, short hair, glasses, and a headband carrying the
// sensor pod (where the ESP32 + MPU6050 board sits). Built from three.js primitives at runtime:
// no model file, no licence obligations, ~0 KB download. See docs/HEAD_MODEL.md.
//
// Model space: Y up, face looks down +Z, head centre at the origin, radius ~1.
// `pivot` sits at the top of the neck so nodding and tilting rotate about a natural point.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface HeadColors {
  skin: string; hair: string; headset: string; pod: string;
  accent: string; ok: string; pitch: string; roll: string; yaw: string; clothing: string;
}

export interface HeadRig {
  root: THREE.Group;
  pivot: THREE.Group;
  led: THREE.MeshStandardMaterial;
  rings: [THREE.Mesh, THREE.Mesh, THREE.Mesh];          // pitch, roll, yaw axis indicators (do not rotate with the head)
  ringDots: [THREE.Mesh, THREE.Mesh, THREE.Mesh];
  dispose(): void;
}

const NECK_PIVOT = new THREE.Vector3(0, -0.85, -0.08);

function shapeSkull(g: THREE.BufferGeometry, grow = 1) {
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const y = v.y;
    let x = v.x, z = v.z;
    x *= 0.8; z *= 0.92;
    const t = Math.min(1, Math.max(0, -y));             // jaw taper below the equator
    x *= 1 - 0.3 * t * t;
    z *= 1 - 0.1 * t * t;
    if (z < 0) z *= 1.05;                                // fuller back of the head
    if (z > 0.6) z = 0.6 + (z - 0.6) * 0.85;             // flatter face
    p.setXYZ(i, x * grow, y * grow, z * grow);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

export function buildHead(c: HeadColors): HeadRig {
  const disposables: { dispose(): void }[] = [];
  const mat = (color: string, opts: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0, ...opts });
    disposables.push(m);
    return m;
  };
  const geo = <G extends THREE.BufferGeometry>(g: G) => { disposables.push(g); return g; };
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, pos?: [number, number, number]) => {
    const o = new THREE.Mesh(g, m);
    if (pos) o.position.set(...pos);
    return o;
  };

  const skin = mat(c.skin, { roughness: 0.55 });
  const hair = mat(c.hair, { roughness: 0.85 });
  const frame = mat(c.headset, { roughness: 0.35 });
  const band = mat(c.headset, { roughness: 0.7 });
  const pod = mat(c.pod, { roughness: 0.4 });
  const dark = mat('#2a2522', { roughness: 0.3 });
  const lip = mat('#a8655c', { roughness: 0.6 });
  const cloth = mat(c.clothing, { roughness: 0.9 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, clearcoat: 1 });
  disposables.push(glass);
  const led = mat(c.ok, { emissive: new THREE.Color(c.ok), emissiveIntensity: 0.8, roughness: 0.2 });

  const root = new THREE.Group();

  // ----- static body: neck and shoulders -----
  root.add(mesh(geo(new THREE.CylinderGeometry(0.35, 0.43, 0.8, 40)), skin, [0, -1.12, -0.1]));
  const shoulders = mesh(geo(new THREE.SphereGeometry(1, 48, 24)), cloth, [0, -1.88, -0.12]);
  shoulders.scale.set(1.6, 0.55, 0.78);
  root.add(shoulders);

  // ----- head on a neck pivot -----
  const pivot = new THREE.Group();
  pivot.position.copy(NECK_PIVOT);
  root.add(pivot);
  const head = new THREE.Group();
  head.position.copy(NECK_PIVOT).negate();
  pivot.add(head);

  head.add(mesh(shapeSkull(geo(new THREE.SphereGeometry(1, 72, 54))), skin));

  for (const s of [-1, 1]) {
    const ear = mesh(geo(new THREE.SphereGeometry(1, 24, 16)), skin, [s * 0.78, -0.12, -0.04]);
    ear.scale.set(0.09, 0.19, 0.13);
    head.add(ear);
    head.add(mesh(geo(new THREE.SphereGeometry(0.052, 20, 14)), dark, [s * 0.28, 0.06, 0.79]));
    const brow = mesh(geo(new THREE.CapsuleGeometry(0.022, 0.15, 4, 10)), hair, [s * 0.28, 0.27, 0.79]);
    brow.rotation.set(-0.15, 0, Math.PI / 2 + s * 0.08);
    head.add(brow);
  }
  const nose = mesh(geo(new THREE.SphereGeometry(1, 24, 16)), skin, [0, -0.13, 0.86]);
  nose.scale.set(0.1, 0.16, 0.12);
  nose.rotation.x = -0.2;
  head.add(nose);
  const arc = Math.PI * 0.7;
  const mouth = mesh(geo(new THREE.TorusGeometry(0.12, 0.016, 8, 24, arc)), lip, [0, -0.38, 0.8]);
  mouth.rotation.set(-0.2, 0, Math.PI + (Math.PI - arc) / 2);
  head.add(mouth);

  // hair: a cap tilted back over the crown, plus volume at the back of the head
  const cap = shapeSkull(geo(new THREE.SphereGeometry(1, 72, 30, 0, Math.PI * 2, 0, Math.PI * 0.52)), 1.06);
  const capMesh = mesh(cap, hair, [0, 0.05, -0.02]);
  capMesh.rotation.x = -0.38;
  head.add(capMesh);
  const back = mesh(geo(new THREE.SphereGeometry(1, 40, 24)), hair, [0, -0.08, -0.36]);
  back.scale.set(0.8, 0.72, 0.62);
  head.add(back);

  // glasses
  for (const s of [-1, 1]) {
    const rim = mesh(geo(new THREE.TorusGeometry(0.165, 0.02, 10, 40)), frame, [s * 0.29, 0.06, 0.9]);
    rim.rotation.y = s * 0.14;
    head.add(rim);
    const lens = mesh(geo(new THREE.CircleGeometry(0.16, 32)), glass, [s * 0.29, 0.06, 0.9]);
    lens.rotation.y = s * 0.14;
    head.add(lens);
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.455, 0.09, 0.87), new THREE.Vector3(s * 0.68, 0.1, 0.64),
      new THREE.Vector3(s * 0.8, 0.1, 0.3), new THREE.Vector3(s * 0.82, 0.09, 0.0), new THREE.Vector3(s * 0.8, 0.0, -0.14),
    ]);
    head.add(mesh(geo(new THREE.TubeGeometry(path, 24, 0.016, 8, false)), frame));
  }
  const bridge = mesh(geo(new THREE.TorusGeometry(0.065, 0.016, 8, 16, Math.PI)), frame, [0, 0.09, 0.93]);
  head.add(bridge);

  // headband with the sensor pod on the forehead
  const bandGeo = geo(new THREE.TorusGeometry(1, 0.05, 14, 96));
  bandGeo.rotateX(Math.PI / 2);
  const bandMesh = mesh(bandGeo, band, [0, 0.47, -0.04]);
  bandMesh.scale.set(0.8, 1, 0.92);
  head.add(bandMesh);
  const podMesh = mesh(geo(new RoundedBoxGeometry(0.4, 0.22, 0.11, 4, 0.045)), pod, [0, 0.48, 0.86]);
  podMesh.rotation.x = -0.2;
  head.add(podMesh);
  const ledMesh = mesh(geo(new THREE.SphereGeometry(0.026, 16, 12)), led, [0.12, 0.49, 0.925]);
  head.add(ledMesh);

  // ----- axis indicator rings (world-fixed, shown for the shaking axis) -----
  const ringMat = (color: string) => { const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }); disposables.push(m); return m; };
  const R = 1.42;
  const mkRing = (color: string, rot: [number, number, number]) => {
    const r = mesh(geo(new THREE.TorusGeometry(R, 0.014, 8, 120)), ringMat(color), [0, 0.05, 0]);
    r.rotation.set(...rot);
    r.visible = false;
    root.add(r);
    const dot = mesh(geo(new THREE.SphereGeometry(0.06, 16, 12)), r.material as THREE.Material);
    r.add(dot);
    return [r, dot] as const;
  };
  const [pRing, pDot] = mkRing(c.pitch, [0, Math.PI / 2, 0]);     // YZ plane: nodding
  const [rRing, rDot] = mkRing(c.roll, [0, 0, 0]);                // XY plane: tilting
  const [yRing, yDot] = mkRing(c.yaw, [Math.PI / 2, 0, 0]);       // XZ plane: turning

  return {
    root, pivot, led,
    rings: [pRing, rRing, yRing],
    ringDots: [pDot, rDot, yDot],
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

export const RING_RADIUS = 1.42;
