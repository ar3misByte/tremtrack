// App-side thresholds and weights, all in one place.
// These are ENGINEERING choices for a self-tracking prototype, not clinical constants.
// The firmware's own detector thresholds live in the sketch (SENS table) and are not set here.
// Changing anything in SEVERITY changes scores: bump SEVERITY.version so stored scores can be told apart.

export const EPISODES = {
  /** An alert that drops for less than this and comes back is the same episode (s). */
  mergeGapS: 3,
  /** Alerts shorter than this are not stored as episodes (s). The firmware needs ~0.2 s of agreement to raise one. */
  minDurationS: 1.0,
  /** The firmware raises an alert about this long after shaking starts (1.5 s window + 2 ticks). Shown, not subtracted. */
  detectionLatencyS: 1.7,
};

export const SESSIONS = {
  /** No frame for this long ends the session (s). */
  staleS: 10,
  /** Gaps between frames longer than this are not counted as monitored time (s). */
  maxFrameGapS: 1,
  /** How often the open session and 1 Hz samples are flushed to storage (s). */
  flushEveryS: 5,
};

export const STORAGE = {
  /** 1 Hz samples are deleted after this many days. Episodes and sessions are kept until you delete them. */
  sampleRetentionDays: 30,
};

export const SEVERITY = {
  // v2: the episode amplitude is the combined magnitude across all axes shaking (multi-axis tremor)
  version: 2,
  // ---- episode score ----
  // Intensity is the estimated angular displacement amplitude theta = A / (2 pi f) in degrees,
  // where A is the band amplitude (deg/s) and f the frequency (Hz). Mapped on a log scale:
  //   I = clamp( ln(1 + theta/theta0) / ln(1 + thetaMax/theta0), 0, 1 )
  /** Displacement where the log scale starts to bend (deg). About the smallest the default detector flags. */
  theta0Deg: 0.05,
  /** Displacement that maps to full intensity (deg). Larger values are capped. */
  thetaMaxDeg: 5,
  // Duration term:  Dn = clamp( ln(1 + D/d0) / ln(1 + dMax/d0), 0, 1 )
  d0S: 2,
  dMaxS: 300,
  /** Episode score = 10 * (wI * I + wD * Dn) / (wI + wD). */
  wIntensity: 0.7,
  wDuration: 0.3,
  // ---- daily score ----
  // Burden B = sum over episodes of (D_i * I_i) / monitored seconds  (intensity-weighted share of time shaking)
  // Daily = 10 * clamp( ln(1 + B/b0) / ln(1 + bMax/b0), 0, 1 )
  b0: 0.002,
  bMax: 0.3,
  /** Days with less monitored time than this show "not enough data" instead of a score (s). */
  minMonitoredS: 10 * 60,
};

export const MULTIAXIS = {
  // How two shaking axes relate (logic/multiaxis.ts). The firmware decides WHICH axes shake.
  /** Frequencies further apart than max(this, independentRel x the higher one) = two separate rhythms (Hz). */
  independentMinHz: 0.6,
  independentRel: 0.12,
  /** Below this phase coherence (0..1) the relation is "mixed". */
  minCoherence: 0.6,
  /** Phase within this of 0 or 180 degrees = diagonal. */
  diagonalMaxDeg: 30,
  /** Phase within this of 90 degrees = circular. */
  circularTolDeg: 35,
  /** In an episode, an axis counts as part of it when it was shaking for at least this share of the alert time. */
  episodeAxisMinShare: 0.3,
};

export const FALL = {
  // Rule-based fall / sudden-impact candidate (logic/fall.ts). A HEURISTIC: it will miss falls and raise
  // false alarms, and a head-worn sensor cannot tell a fall from the headset being dropped.
  /** |a| below this = free fall (g). */
  freeFallG: 0.5,
  /** Free fall must last at least this long (s). */
  freeFallMinS: 0.1,
  /** After free fall, an impact above this within impactWindowS counts (g). */
  impactG: 2.5,
  impactWindowS: 1.0,
  /** An impact above this counts even without free fall (trips, slips) (g). */
  impactOnlyG: 4.0,
  /** Stillness is checked from settleS after the impact, for stillWindowS. */
  settleS: 0.5,
  stillWindowS: 2.0,
  /** "Still": |a| within [stillMinG, stillMaxG] and orientation spread below stillMaxDeg, for stillMinShare of the window. */
  stillMinG: 0.85,
  stillMaxG: 1.15,               // walking bounces about +-0.2 g, so it is never "still"
  stillMaxDeg: 4,
  stillMinShare: 0.85,
  /** Also require the head to end up in a different orientation (lying). Off: a fall can end sitting up. */
  requireOrientationChange: false,
  minOrientationChangeDeg: 30,
  /** No new candidate for this long after one (s). */
  cooldownS: 15,
  /** Time the user has to cancel before the caregiver alert (s). */
  cancelCountdownS: 30,
};

export const POSTURE = {
  // Neutral-pose posture and stillness (logic/posture.ts). Mounting differs between people: calibrate first.
  /** Hold still this long to calibrate the neutral pose (s). */
  calibrateS: 3,
  /** Calibration fails if the orientation spreads more than this while holding still (deg). */
  calibrateMaxSpreadDeg: 2,
  /** Outside the pose range: head forward (chin down) more than this (deg). */
  droopMaxDeg: 15,
  /** ... or back (chin up) more than this (deg). */
  backMaxDeg: 20,
  /** ... or tilted sideways more than this (deg). */
  tiltMaxDeg: 12,
  /** Seconds with orientation spread below this are "still" (deg). */
  stillMaxDeg: 0.4,
  /** Seconds with orientation spread above this (not walking) are "restless" (deg). */
  restlessMinDeg: 2.0,
  /** Gentle prompt after this long mostly outside the range (s), then not again for promptCooldownS. */
  promptAfterS: 120,
  promptMinShare: 0.8,
  promptCooldownS: 600,
};

export const RESTING = {
  // Resting heart rate and SpO2 (logic/vitals.ts). Only readings with ppgState = 3 count.
  /** Low motion for at least this long before readings count as "resting" (s). */
  restMinS: 180,
  /** Low motion: orientation spread per second below this (deg), not walking, no tremor alert. */
  restMaxMotionDeg: 1.0,
  /** One resting reading per this many seconds while resting. */
  readingEveryS: 30,
  /** Reading quality: good when at least this share of seconds had a valid reading and the heart-rate spread (IQR) is small. */
  goodValidShare: 0.8,
  goodMaxSpreadBpm: 6,
  fairValidShare: 0.5,
  /** Flags (never a diagnosis): a day counts as "low" when its median resting SpO2 estimate is below this (%). */
  lowSpo2Pct: 92,
  /** ... and "high" when its median resting heart rate is above this (bpm). */
  highBpm: 100,
  /** Flag when at least this many of the last 7 days are low / high. */
  flagDays: 2,
};
