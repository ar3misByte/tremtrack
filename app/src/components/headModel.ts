// Procedural, stylised but human head: one sculpted skull mesh (jaw, chin, cheekbones, brow, eye
// sockets, nose and lips are shaped into the surface), a hair shell that grows out of the scalp with
// a soft hairline, eyes with lids, and accessories (ears, brows, glasses, headband with the sensor
// pod) fitted to the actual surface by ray-casting so everything sits flush.
// No model file, no licence obligations. See docs/HEAD_MODEL.md.
//
// Model space: Y up, the face looks down +Z, head centre at the origin, head height ~2.
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

export const RING_RADIUS = 1.42;
const NECK_PIVOT = new THREE.Vector3(0, -0.85, -0.1);

// ---------- sculpting helpers ----------
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const bump = (u: number, v: number) => Math.exp(-(u * u + v * v));

/** Maps a unit direction to a point on the sculpted head surface. */
function sculpt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  let px = x * 0.79, pz = z * 0.9;
  const py = y * 1.0;
  const below = clamp(-y, 0, 1);
  px *= 1 - 0.24 * below * below;                      // jaw narrower than the cranium
  pz *= 1 - 0.06 * below * below;
  if (z < 0) pz *= 1.08 - 0.5 * smooth(-0.05, -0.9, y); // occipital fullness, curving in towards the neck below
  if (pz > 0.55) pz = 0.55 + (pz - 0.55) * 0.78;       // flatter face plane
  px *= 1 + 0.04 * bump(y / 0.35, (z - 0.2) / 0.5);    // slightly wider at the temples

  const front = smooth(0.25, 0.75, z);                 // facial features only on the front
  const ax = Math.abs(x);
  let f = 0;
  // brow ridge and eye sockets
  f += 0.035 * Math.exp(-(((y - 0.2) / 0.07) ** 2)) * Math.exp(-(((ax - 0.22) / 0.22) ** 2));
  f -= 0.055 * bump((ax - 0.27) / 0.12, (y - 0.05) / 0.085);
  // cheekbones
  f += 0.04 * bump((ax - 0.42) / 0.15, (y + 0.13) / 0.13);
  // nose: ridge growing to the tip, then the base with the alae
  const ridgeWin = smooth(0.17, 0.07, y) * smooth(-0.33, -0.22, y);
  const ridgeH = 0.035 + 0.15 * smooth(0.1, -0.2, y);
  const ridgeW = 0.06 + 0.045 * smooth(0.0, -0.24, y);
  f += ridgeH * ridgeWin * Math.exp(-((x / ridgeW) ** 2));
  f += 0.045 * bump((ax - 0.075) / 0.05, (y + 0.24) / 0.05);
  // lips, mouth line, chin
  f += 0.032 * bump(x / 0.13, (y + 0.415) / 0.035);
  f += 0.038 * bump(x / 0.11, (y + 0.5) / 0.04);
  f -= 0.022 * bump(x / 0.14, (y + 0.457) / 0.012);
  f += 0.06 * bump(x / 0.22, (y + 0.72) / 0.11);
  // philtrum
  f -= 0.012 * bump(x / 0.025, (y + 0.36) / 0.04);
  pz += f * front;
  return out.set(px, py, pz);
}

function sculptedSphere(wSeg: number, hSeg: number, displace?: (dir: THREE.Vector3, p: THREE.Vector3) => void) {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const d = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    sculpt(d.x, d.y, d.z, p);
    displace?.(d, p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Where the hair grows (0..1) for a unit direction, with a soft hairline. */
function hairMask(d: THREE.Vector3): number {
  const yLine = d.z > 0
    ? 0.06 + (0.42 - 0.1 * Math.abs(d.x)) * smooth(0.15, 0.75, d.z)   // forehead hairline, receding at the temples
    : 0.06 - 0.56 * smooth(0.0, -0.75, d.z);                           // down to the nape at the back
  return smooth(yLine - 0.01, yLine + 0.09, d.y);
}

export function buildHead(c: HeadColors): HeadRig {
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const std = (color: string, o: THREE.MeshStandardMaterialParameters = {}) => keep(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o }));
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => new THREE.Mesh(keep(g), m);

  const skin = keep(new THREE.MeshPhysicalMaterial({ color: c.skin, roughness: 0.52, metalness: 0, sheen: 0.4, sheenColor: new THREE.Color('#ffd9c4'), sheenRoughness: 0.6 }));
  const hair = keep(new THREE.MeshPhysicalMaterial({ color: c.hair, roughness: 0.78, metalness: 0, sheen: 0.6, sheenColor: new THREE.Color('#7a5a48'), sheenRoughness: 0.5 }));
  const frame = std(c.headset, { roughness: 0.3 });
  const band = std(c.headset, { roughness: 0.75 });
  const pod = std(c.pod, { roughness: 0.35 });
  const sclera = std('#f6f3ef', { roughness: 0.25 });
  const iris = std('#4a3426', { roughness: 0.3 });
  const pupil = std('#141110', { roughness: 0.2 });
  const brow = std(c.hair, { roughness: 0.9 });
  const lipMat = keep(new THREE.MeshPhysicalMaterial({ color: '#b7766a', roughness: 0.45, sheen: 0.3 }));
  const cloth = std(c.clothing, { roughness: 0.92 });
  const glass = keep(new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.14, roughness: 0.05, clearcoat: 1, depthWrite: false }));
  const led = std(c.ok, { emissive: new THREE.Color(c.ok), emissiveIntensity: 0.8, roughness: 0.2 });

  const root = new THREE.Group();

  // ----- static body: neck and shoulders (smooth lathe profiles) -----
  const neckPts = [[0.0, -0.3], [0.32, -0.36], [0.37, -0.62], [0.375, -0.95], [0.4, -1.15], [0.47, -1.3], [0.56, -1.4]].map(([r, y]) => new THREE.Vector2(r, y));
  const neck = mesh(new THREE.LatheGeometry(neckPts, 64), skin);
  neck.position.set(0, 0, -0.12);
  neck.scale.set(1, 1, 0.92);
  root.add(neck);
  const torsoPts = [[0.0, -1.28], [0.4, -1.31], [0.66, -1.38], [0.98, -1.49], [1.34, -1.64], [1.56, -1.86], [1.68, -2.2], [1.72, -3.6]].map(([r, y]) => new THREE.Vector2(r, y));
  const torso = mesh(new THREE.LatheGeometry(torsoPts, 96), cloth);
  torso.position.set(0, 0, -0.12);
  torso.scale.set(1, 1, 0.62);   // closed top: the neck sits in it, no gap from any angle
  root.add(torso);

  // ----- head on a neck pivot -----
  const pivot = new THREE.Group();
  pivot.position.copy(NECK_PIVOT);
  root.add(pivot);
  const head = new THREE.Group();
  head.position.copy(NECK_PIVOT).negate();
  pivot.add(head);

  const skull = mesh(sculptedSphere(176, 132), skin);
  head.add(skull);
  // hair: same surface pushed out along the radial direction where hair grows, hidden just inside elsewhere
  const hairGeo = sculptedSphere(192, 144, (d, p) => {
    const m = hairMask(d);
    const crown = smooth(0.1, 0.95, d.y);
    const fringe = 0.03 * bump(d.x / 0.5, (d.y - 0.55) / 0.15) * smooth(0.3, 0.8, d.z);   // a little lift at the front
    const th = 0.03 + 0.1 * crown + 0.03 * smooth(0.0, -0.6, d.z) + fringe;
    const r = p.length();
    p.multiplyScalar((r + th * m - 0.015 * (1 - m)) / r);        // continuous: just inside the skin where m = 0
  });
  const hairMesh = mesh(hairGeo, hair);
  head.add(hairMesh);
  skull.updateMatrixWorld(true);
  hairMesh.updateMatrixWorld(true);

  // ----- surface queries for fitting the accessories -----
  const rc = new THREE.Raycaster();
  const hitFront = (x: number, y: number, target: THREE.Object3D = skull) => {
    rc.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
    const h = rc.intersectObject(target, false)[0];
    return h ? h.point.clone() : new THREE.Vector3(x, y, 0.8);
  };
  /** Point on the surface in the horizontal direction `ang` (0 = front, +pi/2 = +x side) at height y. */
  const hitAround = (ang: number, y: number, target: THREE.Object3D) => {
    const dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
    rc.set(new THREE.Vector3(0, y, 0).addScaledVector(dir, 5), dir.clone().negate());
    const h = rc.intersectObject(target, false)[0];
    return h ? h.point.clone() : new THREE.Vector3(0, y, 0).addScaledVector(dir, 0.8);
  };

  // ----- eyes: sclera set into the socket, iris + pupil, an upper lid of skin -----
  for (const s of [-1, 1]) {
    const surf = hitFront(s * 0.27, 0.05);
    const ctr = surf.clone().add(new THREE.Vector3(0, 0, -0.035));
    const ball = mesh(new THREE.SphereGeometry(0.072, 32, 24), sclera);
    ball.position.copy(ctr);
    head.add(ball);
    const ir = mesh(new THREE.CircleGeometry(0.045, 32), iris);
    ir.position.copy(ctr).add(new THREE.Vector3(0, -0.006, 0.0725));
    head.add(ir);
    const pu = mesh(new THREE.CircleGeometry(0.02, 24), pupil);
    pu.position.copy(ctr).add(new THREE.Vector3(0, -0.006, 0.0735));
    head.add(pu);
    const lid = mesh(new THREE.SphereGeometry(0.077, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.4), skin);
    lid.position.copy(ctr);
    lid.rotation.x = 0.55;                              // covers the top of the eye, tilted forward
    head.add(lid);
    // brow following the brow ridge
    const pts = [0.13, 0.22, 0.31, 0.39].map((ax, i) => hitFront(s * ax, 0.215 + [0.0, 0.02, 0.02, -0.005][i]).add(new THREE.Vector3(0, 0, 0.012)));
    head.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.017, 8, false), brow));
  }

  // ----- lips tint (a thin line along the mouth, flush with the sculpt) -----
  {
    const pts = [-0.12, -0.06, 0, 0.06, 0.12].map((x) => hitFront(x, -0.457 - 0.012 * (1 - (x / 0.12) ** 2)).add(new THREE.Vector3(0, 0, 0.004)));
    head.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.014, 8, false), lipMat));
  }

  // ----- ears: a bevelled C-shaped outline, set flush into the side of the head -----
  {
    const sh = new THREE.Shape();
    sh.moveTo(0, -0.16);
    sh.bezierCurveTo(0.1, -0.17, 0.13, -0.02, 0.12, 0.07);
    sh.bezierCurveTo(0.11, 0.17, 0.02, 0.2, -0.04, 0.16);
    sh.bezierCurveTo(-0.07, 0.12, -0.05, -0.02, -0.03, -0.08);
    sh.bezierCurveTo(-0.025, -0.13, -0.02, -0.16, 0, -0.16);
    const earGeo = keep(new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.022, bevelSegments: 5, curveSegments: 24 }));
    for (const s of [-1, 1]) {
      const p = hitAround(s * Math.PI / 2 + s * 0.08, -0.08, skull);
      const ear = new THREE.Mesh(earGeo, skin);
      ear.position.copy(p).add(new THREE.Vector3(-s * 0.03, 0, 0));
      ear.rotation.set(0, s * (Math.PI / 2 - 0.35), 0);
      if (s < 0) ear.scale.x = -1;
      head.add(ear);
    }
  }

  // ----- glasses: rounded-rectangle rims in front of the eyes, bridge over the nose, temples along the head -----
  {
    const rimPath = (cx: number, cy: number, cz: number, w: number, h: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const ex = 3.2;                                 // superellipse: soft rounded rectangle
        pts.push(new THREE.Vector3(cx + (w / 2) * Math.sign(ca) * Math.abs(ca) ** (2 / ex), cy + (h / 2) * Math.sign(sa) * Math.abs(sa) ** (2 / ex), cz - 0.02 * ca * ca));
      }
      return new THREE.CatmullRomCurve3(pts, true);
    };
    const eyeZ = hitFront(0.27, 0.05).z;
    const bridgeZ = hitFront(0, 0.07).z;
    const z = Math.max(eyeZ + 0.085, bridgeZ + 0.01);
    for (const s of [-1, 1]) {
      const cx = s * 0.27, cy = 0.045;
      const rim = mesh(new THREE.TubeGeometry(rimPath(cx, cy, z, 0.3, 0.21), 96, 0.014, 8, true), frame);
      rim.rotation.y = s * 0.06;
      head.add(rim);
      const lensShape = new THREE.Shape();
      rimPath(0, 0, 0, 0.29, 0.2).getPoints(48).forEach((p, i) => (i ? lensShape.lineTo(p.x, p.y) : lensShape.moveTo(p.x, p.y)));
      const lens = mesh(new THREE.ShapeGeometry(lensShape), glass);
      lens.position.set(cx, cy, z - 0.005);
      lens.rotation.y = s * 0.06;
      head.add(lens);
      // temple: from the outer edge of the rim, along the side of the head, over the ear
      const pts = [new THREE.Vector3(s * 0.42, 0.09, z - 0.02)];
      for (const ang of [0.95, 1.2, 1.42, 1.62]) pts.push(hitAround(s * ang, 0.09 - (ang - 0.95) * 0.05, skull).multiplyScalar(1.025));
      pts.push(hitAround(s * 1.8, -0.02, skull).multiplyScalar(1.02));
      head.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.012, 8, false), frame));
    }
    const bridge = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.12, 0.08, z - 0.01), new THREE.Vector3(0, 0.105, Math.max(z - 0.005, bridgeZ + 0.025)), new THREE.Vector3(0.12, 0.08, z - 0.01)]);
    head.add(mesh(new THREE.TubeGeometry(bridge, 16, 0.012, 8, false), frame));
  }

  // ----- headband over the hair, lower at the forehead, with the sensor pod on the front -----
  {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) {
      const ang = (i / 64) * Math.PI * 2;
      const y = 0.5 + 0.1 * (1 - Math.cos(ang)) / 2;    // 0.5 at the forehead, 0.6 at the back
      const p = hitAround(ang, y, hairMesh);
      const outward = new THREE.Vector3(p.x, 0, p.z).normalize();
      pts.push(p.addScaledVector(outward, 0.022));
    }
    head.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 160, 0.04, 12, true), band));
    const front = pts[0];
    const podMesh = mesh(new RoundedBoxGeometry(0.36, 0.2, 0.09, 4, 0.04), pod);
    podMesh.position.copy(front).add(new THREE.Vector3(0, 0.005, 0.045));
    podMesh.rotation.x = -0.28;
    head.add(podMesh);
    const ledMesh = mesh(new THREE.SphereGeometry(0.022, 16, 12), led);
    ledMesh.position.copy(podMesh.position).add(new THREE.Vector3(0.11, 0.01, 0.045));
    head.add(ledMesh);
  }

  // ----- axis indicator rings (world-fixed, shown for each shaking axis) -----
  const ringMat = (color: string) => keep(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
  const mkRing = (color: string, rot: [number, number, number]) => {
    const m = ringMat(color);
    const r = mesh(new THREE.TorusGeometry(RING_RADIUS, 0.014, 8, 120), m);
    r.position.set(0, 0.05, 0);
    r.rotation.set(...rot);
    r.visible = false;
    root.add(r);
    const dot = mesh(new THREE.SphereGeometry(0.06, 16, 12), m);
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
