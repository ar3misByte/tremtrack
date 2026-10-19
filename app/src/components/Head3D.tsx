import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { live } from '../device/live';
import { headQuaternion, slerp, smoothingFactor, type Quat } from '../logic/orientation';
import { useSettings, type CameraView } from '../state/settings';
import { buildHead, type HeadColors } from './headModel';
import { useReducedMotion } from './hooks';

const CAMERAS: Record<CameraView, [number, number, number]> = {
  'three-quarter': [2.7, 0.6, 7.1],
  front: [0, 0.4, 7.5],
  side: [7.5, 0.4, 0.2],
};
const TARGET = new THREE.Vector3(0, -0.3, 0);
const SMOOTH_TAU = 0.035;                    // s: light smoothing, keeps a 5 Hz tremor visible

function readColors(): HeadColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    skin: v('--skin', '#d9ab8c'), hair: v('--hair', '#3a2b24'), headset: v('--headset', '#2b2e33'), pod: v('--headset-pod', '#f4f3f0'),
    accent: v('--accent', '#d9602f'), ok: v('--ok', '#5f8b6b'), pitch: v('--axis-pitch', '#3f7d8c'), roll: v('--axis-roll', '#a7843c'),
    yaw: v('--axis-yaw', '#6a6fb0'), clothing: v('--surface-sunk', '#ebe9e4'),
  };
}

function Rig() {
  const rig = useMemo(() => buildHead(readColors()), []);
  useEffect(() => () => rig.dispose(), [rig]);
  const q = useRef<Quat>([0, 0, 0, 1]);
  const camView = useSettings((s) => s.cameraView);
  const reduced = useReducedMotion();
  const { camera } = useThree();
  const camGoal = useMemo(() => new THREE.Vector3(...CAMERAS[camView]), [camView]);
  const colors = useMemo(() => readColors(), []);
  const okCol = useMemo(() => new THREE.Color(colors.ok), [colors]);
  const alertCol = useMemo(() => new THREE.Color(colors.accent), [colors]);
  const idleCol = useMemo(() => new THREE.Color('#9aa0a6'), []);

  useFrame((state, dt) => {
    const fresh = live.lastRx > 0 && performance.now() - live.lastRx < 1500;
    const f = live.frame;
    const target = fresh ? headQuaternion(live.disp) : ([0, 0, 0, 1] as Quat);
    q.current = slerp(q.current, target, smoothingFactor(dt, fresh ? SMOOTH_TAU : 0.4));
    rig.pivot.quaternion.set(...q.current);

    const tremor = fresh && !!f?.tremor;
    const t = state.clock.elapsedTime;
    rig.led.color.copy(tremor ? alertCol : fresh ? okCol : idleCol);
    rig.led.emissive.copy(rig.led.color);
    rig.led.emissiveIntensity = tremor && !reduced ? 0.6 + 0.6 * (0.5 + 0.5 * Math.sin(t * 9)) : fresh ? 0.7 : 0.1;

    rig.rings.forEach((ring, i) => {
      const on = tremor && f!.dir === i;
      const m = ring.material as THREE.MeshBasicMaterial;
      const goal = on ? 0.85 : 0;
      m.opacity += (goal - m.opacity) * Math.min(1, dt * 8);
      ring.visible = m.opacity > 0.02;
      if (ring.visible) {
        const base = i === 0 ? Math.PI - 0.7 : Math.PI / 2;
        const swing = reduced ? 0 : 0.35 * Math.sin(t * 2 * Math.PI * 1.1);
        const a = base + swing;
        rig.ringDots[i].position.set(Math.cos(a) * 1.42, Math.sin(a) * 1.42, 0);
      }
    });

    camera.position.lerp(camGoal, reduced ? 1 : Math.min(1, dt * 4));
    camera.lookAt(TARGET);
  });

  return <primitive object={rig.root} />;
}

export default function Head3D() {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 30, position: CAMERAS['three-quarter'], near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      style={{ touchAction: 'pan-y' }}
      aria-hidden="true"
    >
      <hemisphereLight args={['#ffffff', '#d8d2c8', 1.25]} />
      <directionalLight position={[-3, 4, 5]} intensity={1.7} />
      <directionalLight position={[4, 2, -4]} intensity={0.7} color="#fff1e6" />
      <Rig />
    </Canvas>
  );
}
