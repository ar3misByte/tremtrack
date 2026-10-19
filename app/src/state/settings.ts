// User preferences, persisted in localStorage (per browser). Display only: nothing medical here.
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULT_MAPPING, type AxisMapping } from '../logic/orientation';

export type ViewMode = '3d' | '2d';
export type CameraView = 'three-quarter' | 'front' | 'side';

export interface Settings {
  viewMode: ViewMode;
  cameraView: CameraView;
  exaggeration: number;       // 1..10, multiplies the fast (tremor) part of the motion on screen
  range2d: number;            // degrees at the edge of the 2D circle
  trail: boolean;
  mapping: AxisMapping;
  wsUrl: string;
  sensitivity: number;        // 1..5, sent to the device
  largeText: boolean;
  showDemoData: boolean;      // include demo / replay / sample data in Trends and today's score
  set: (p: Partial<Omit<Settings, 'set'>>) => void;
}

const safeStorage = createJSONStorage(() => {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; }
  catch { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; }
});

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      viewMode: '3d',
      cameraView: 'three-quarter',
      exaggeration: 3,
      range2d: 25,
      trail: true,
      mapping: DEFAULT_MAPPING,
      wsUrl: 'ws://localhost:8787',
      sensitivity: 2,
      largeText: false,
      showDemoData: true,
      set: (p) => set(p),
    }),
    { name: 'htm.settings.v1', storage: safeStorage, partialize: ({ set: _s, ...rest }) => rest },
  ),
);
