// Stored records. Times are milliseconds since the epoch (UTC); days are bucketed in local time when shown.
import type { Axis } from './csv';
import type { ComboPattern } from './multiaxis';

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
  // posture and stillness (missing on sessions stored before milestone 3)
  stillS?: number;
  restlessS?: number;
  poseMonitoredS?: number;       // seconds with a calibrated neutral pose
  outsidePoseS?: number;         // of those, seconds outside the configured pose range
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
  axisShare: [number, number, number];   // share of alert time each axis was the ALERTING (strongest) axis
  /** Axes that were shaking for at least MULTIAXIS.episodeAxisMinShare of the episode (several = combined tremor). Missing on episodes stored before v2. */
  axes?: Axis[];
  axesActiveFrac?: [number, number, number];   // share of alert time each axis was shaking
  ampByAxis?: [number, number, number];        // mean band amplitude of each axis while it was shaking (deg/s)
  pattern?: ComboPattern;                      // how the axes moved together ('single' for one axis)
  ampDps: number;                // band amplitude: the alert axis for one axis, the combined magnitude sqrt(sum a_i^2) across the episode's axes
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
  axes: number;                  // OR of the shaking-axes masks in the second
  freqHz: number;                // last non-zero frequency
  walkingFrac: number;
  bpm: number | null;            // last valid reading in the second
  spo2: number | null;
  ppgState: number;              // highest state seen (3 = valid)
  state?: 'still' | 'normal' | 'restless' | 'walking';
  devForward?: number | null;    // posture vs the calibrated neutral pose (deg, + = chin down); null without calibration
  devTilt?: number | null;
  zone?: 'ok' | 'forward' | 'back' | 'tilt' | null;
}

/** Fall / impact candidates and what happened next. */
export interface FallEvent {
  id: string;
  sessionId: string;
  demo: boolean;
  t: number;                     // impact time
  path: 'freefall+impact' | 'impact';
  peakG: number;
  freeFallMs: number;
  orientationChangeDeg: number;
  outcome: 'pending' | 'cancelled' | 'confirmed' | 'no-response';
  resolvedAt: number | null;
  caregiverAlert: 'not-configured' | 'sent' | 'failed' | 'not-needed';
}

// ---------- milestone 4: tags, medications, doses ----------
export type TagKind = 'coffee' | 'poor-sleep' | 'stress' | 'exercise' | 'alcohol' | 'meal' | 'custom';

/** A quick tag ("coffee", "stress", ...) at a moment in time. */
export interface Tag {
  id: string;
  t: number;
  kind: TagKind;
  label: string | null;          // only for custom tags
  demo: boolean;
}

/** A medication schedule. The name and dose are free text typed by the user; the app gives no advice. */
export interface Medication {
  id: string;
  name: string;
  dose: string;
  times: string[];               // local "HH:MM"
  days: number[];                // 0 = Sunday ... 6; empty = every day
  active: boolean;
  createdAt: number;
  demo: boolean;
}

/** What happened to one scheduled dose (or an extra, unscheduled one). */
export interface DoseLog {
  id: string;                    // `${medId}@${scheduledFor}` for scheduled doses, so a dose is logged once
  medId: string;
  scheduledFor: number | null;   // ms, null = extra dose
  takenAt: number | null;        // null when skipped
  status: 'taken' | 'skipped';
  loggedAt: number;
  demo: boolean;
}
