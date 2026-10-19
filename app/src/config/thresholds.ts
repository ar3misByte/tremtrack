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
  version: 1,
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
