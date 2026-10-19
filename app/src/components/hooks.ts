import { useEffect, useRef, useState } from 'react';

export function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}

/** Runs `draw` every animation frame while mounted. */
export function useAnimationFrame(draw: (now: number) => void) {
  const ref = useRef(draw);
  useEffect(() => { ref.current = draw; });
  useEffect(() => {
    let id = 0;
    const loop = (now: number) => { ref.current(now); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

/** Sizes a canvas to its CSS box at device pixel ratio; returns the 2D context or null. */
export function fitCanvas(cv: HTMLCanvasElement | null): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  if (!cv) return null;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

export function cssVar(name: string, fallback = '#000'): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
