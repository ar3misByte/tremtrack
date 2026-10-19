// Stored records. Times are milliseconds since the epoch (UTC); days are bucketed in local time when shown.
import type { Axis } from './csv';

export type Source = 'serial' | 'websocket' | 'ble' | 'demo' | 'replay' | 'sample';
/** Simulated / replayed / generated data is flagged so it can be filtered and deleted separately. */
export const isDemoSource = (s: Source) => s === 'demo' || s === 'replay' || s === 'sample';

export interface Session {
  id: string;
  source: Source;
  demo: boolean;
  start: number;
  end: number;
  open: boolean;                 // still receiving data
  monitoredS: number;            // time with data arriving (gaps > 1 s excluded)
  tremorS: number;               // sum of stored episode durations
  walkingS: number;
  episodes: number;
  frames: number;
  sensitivity: number;           // level the app last sent (the device may differ if changed elsewhere)
}

export interface Episode {
  id: string;
  sessionId: string;
  source: Source;
  demo: boolean;
  start: number;                 // when the device's alert rose (the shaking began ~1.7 s earlier)
  end: number;                   // when the alert last held
  durationS: number;
  axis: Axis;                    // dominant axis while the alert was on
  axisShare: [number, number, number];
  ampDps: number;                // mean band amplitude on the alert axis (deg/s)
  peakAmpDps: number;
  freqHz: number;                // mean frequency
  q: number;                     // mean band-energy share
  cycles: number;                // mean consistent cycles per window
  walkingFrac: number;           // share of the episode spent walking
  bpm: number | null;            // mean of valid heart-rate readings during the episode
  displacementDeg: number;       // ampDps / (2 pi freqHz)
  score: number;                 // episode severity 0-10
  scoreVersion: number;
  sensitivity: number;
}

/** One-second summary of the live stream (kept STORAGE.sampleRetentionDays). */
export interface Sample {
  sessionId: string;
  t: number;                     // start of the second
  demo: boolean;
  pitch: number; roll: number; yaw: number;   // means, degrees
  motionDeg: number;             // spread of orientation within the second (stillness indicator)
  tremorFrac: number;            // share of frames with the alert on
  ampDps: number;                // max band amplitude across axes
  freqHz: number;                // last non-zero frequency
  walkingFrac: number;
  bpm: number | null;            // last valid reading in the second
  spo2: number | null;
  ppgState: number;              // highest state seen (3 = valid)
}
