// Cloud MQTT protocol, version 1. Single source of truth for the device simulator, the Lambdas and the
// app (the firmware implements the same spec in milestone 7). Documented in docs/TELEMETRY_PROTOCOL.md.
//
// Topics: tremor/v1/{owner}/{thing}/{kind}
//   owner = the user's Cognito identity id (e.g. "ap-south-1:3f2c..."), stored as the thing attribute "owner"
//   thing = the device's IoT thing name (also its MQTT client id)
//   kind  = telemetry | event | status | cmd | viewer
// No raw 50 Hz data is ever sent to the cloud.

export const PROTOCOL_VERSION = 1;
export type TopicKind = 'telemetry' | 'event' | 'status' | 'cmd' | 'viewer';
export const topic = (owner: string, thing: string, kind: TopicKind) => `tremor/v1/${owner}/${thing}/${kind}`;
export function parseTopic(t: string): { owner: string; thing: string; kind: TopicKind } | null {
  const m = /^tremor\/v1\/([^/]+)\/([^/]+)\/(telemetry|event|status|cmd|viewer)$/.exec(t);
  return m ? { owner: m[1], thing: m[2], kind: m[3] as TopicKind } : null;
}

/** Device -> cloud, 0.2-1 Hz: a compact summary of the last `per` seconds. */
export interface Telemetry {
  v: 1;
  seq: number;              // increments per message; gaps show lost messages
  ts: number;               // ms since epoch (UTC), end of the summarised period
  per: number;              // seconds summarised (1 or 5)
  p: number; r: number; y: number;   // orientation, degrees
  tr: 0 | 1;                // tremor alert on
  ax: number;               // shaking-axes mask (1 pitch, 2 roll, 4 yaw)
  dir: 0 | 1 | 2;           // alerting / strongest axis
  f: number;                // frequency Hz (0 = none)
  a: number;                // band amplitude, deg/s (combined across shaking axes)
  sev: number;              // severity of the episode in progress so far, 0-10 (0 = none)
  wk: 0 | 1;                // walking
  hr: number | null;        // heart rate, bpm (valid readings only)
  sp: number | null;        // SpO2 estimate, %
  ppg: 0 | 1 | 2 | 3;       // pulse sensor state
  pf: number | null;        // posture: forward (+) / back (-) vs neutral, degrees; null = not calibrated
  pt: number | null;        // posture: side tilt, degrees
  st: 'still' | 'normal' | 'restless' | 'walking';
  rssi: number | null;      // Wi-Fi signal, dBm
  bat: number | null;       // battery %, null = mains / unknown
}

export interface EpisodeSummary {
  start: number; end: number; durationS: number; axes: number[]; pattern: string;
  ampDps: number; freqHz: number; score: number; bpm: number | null;
}
export interface FallSummary { t: number; path: 'freefall+impact' | 'impact'; peakG: number; freeFallMs: number; orientationChangeDeg: number; outcome: 'pending' | 'cancelled' | 'confirmed' | 'no-response' }

/** Device -> cloud, on change. */
export type DeviceEvent = { v: 1; seq: number; ts: number } & (
  | { type: 'tremor_start'; ax: number; f: number }
  | { type: 'episode'; ep: EpisodeSummary }
  | { type: 'fall'; fall: FallSummary }
  | { type: 'sensitivity'; level: number }
  | { type: 'boot'; fw: string; tzMin: number }
);

/** Device -> cloud, retained; the broker publishes the offline variant as the device's last will. */
export interface Status { v: 1; online: boolean; ts?: number; fw?: string; tzMin?: number; rate?: number }
/** Cloud/app -> device. */
export interface Command { v: 1; sens?: number; rate?: number }
/** App -> device, retained: someone is watching the live cloud view, so send 1 Hz until `until`. */
export interface Viewer { v: 1; watching: boolean; until: number }

// ---------------- validation ----------------
type Check = (x: unknown) => boolean;
const num: Check = (x) => typeof x === 'number' && Number.isFinite(x);
const int: Check = (x) => Number.isInteger(x);
const range = (lo: number, hi: number): Check => (x) => num(x) && (x as number) >= lo && (x as number) <= hi;
const nullable = (c: Check): Check => (x) => x === null || c(x);
const oneOf = (...v: unknown[]): Check => (x) => v.includes(x);
const TS_MIN = Date.UTC(2024, 0, 1), TS_MAX = Date.UTC(2100, 0, 1);
const ts = range(TS_MIN, TS_MAX);

function check(obj: unknown, spec: Record<string, Check>, extra = false): string[] {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return ['not an object'];
  const o = obj as Record<string, unknown>;
  const errs: string[] = [];
  for (const [k, c] of Object.entries(spec)) if (!c(o[k])) errs.push(`${k}: invalid (${JSON.stringify(o[k])?.slice(0, 40)})`);
  if (!extra) for (const k of Object.keys(o)) if (!(k in spec)) errs.push(`${k}: unknown field`);
  return errs;
}

export const TELEMETRY_SPEC: Record<string, Check> = {
  v: oneOf(1), seq: (x) => int(x) && (x as number) >= 0, ts, per: range(0.2, 60),
  p: range(-180, 180), r: range(-180, 180), y: range(-360, 360), tr: oneOf(0, 1), ax: (x) => int(x) && range(0, 7)(x), dir: oneOf(0, 1, 2),
  f: range(0, 30), a: range(0, 2000), sev: range(0, 10), wk: oneOf(0, 1), hr: nullable(range(20, 250)), sp: nullable(range(50, 100)),
  ppg: oneOf(0, 1, 2, 3), pf: nullable(range(-180, 180)), pt: nullable(range(-180, 180)), st: oneOf('still', 'normal', 'restless', 'walking'),
  rssi: nullable(range(-120, 0)), bat: nullable(range(0, 100)),
};
export const MAX_TELEMETRY_BYTES = 512;

export function validateTelemetry(x: unknown): { ok: true; value: Telemetry } | { ok: false; errors: string[] } {
  const errors = check(x, TELEMETRY_SPEC);
  if (!errors.length && JSON.stringify(x).length > MAX_TELEMETRY_BYTES) errors.push('message too large');
  return errors.length ? { ok: false, errors } : { ok: true, value: x as Telemetry };
}

const EPISODE_SPEC: Record<string, Check> = {
  start: ts, end: ts, durationS: range(0, 86_400), axes: (x) => Array.isArray(x) && x.length >= 1 && x.length <= 3 && x.every((a) => oneOf(0, 1, 2)(a)),
  pattern: oneOf('single', 'diagonal', 'circular', 'independent', 'mixed'), ampDps: range(0, 2000), freqHz: range(0, 30), score: range(0, 10), bpm: nullable(range(20, 250)),
};
const FALL_SPEC: Record<string, Check> = {
  t: ts, path: oneOf('freefall+impact', 'impact'), peakG: range(0, 64), freeFallMs: range(0, 10_000), orientationChangeDeg: range(0, 360),
  outcome: oneOf('pending', 'cancelled', 'confirmed', 'no-response'),
};

export function validateEvent(x: unknown): { ok: true; value: DeviceEvent } | { ok: false; errors: string[] } {
  const base = check(x, { v: oneOf(1), seq: (y) => int(y) && (y as number) >= 0, ts, type: oneOf('tremor_start', 'episode', 'fall', 'sensitivity', 'boot') }, true);
  if (base.length) return { ok: false, errors: base };
  const o = x as Record<string, unknown>;
  const common = { v: oneOf(1), seq: int, ts, type: oneOf(o.type) };
  const errors =
    o.type === 'tremor_start' ? check(o, { ...common, ax: (y) => int(y) && range(1, 7)(y), f: range(0, 30) })
    : o.type === 'episode' ? [...check(o, { ...common, ep: (y) => typeof y === 'object' && y !== null }), ...(typeof o.ep === 'object' && o.ep ? check(o.ep, EPISODE_SPEC) : [])]
    : o.type === 'fall' ? [...check(o, { ...common, fall: (y) => typeof y === 'object' && y !== null }), ...(typeof o.fall === 'object' && o.fall ? check(o.fall, FALL_SPEC) : [])]
    : o.type === 'sensitivity' ? check(o, { ...common, level: oneOf(1, 2, 3, 4, 5) })
    : check(o, { ...common, fw: (y) => typeof y === 'string' && (y as string).length <= 40, tzMin: range(-720, 840) });
  if (!errors.length && JSON.stringify(x).length > 2048) errors.push('message too large');
  return errors.length ? { ok: false, errors } : { ok: true, value: x as DeviceEvent };
}

export function validateStatus(x: unknown): { ok: true; value: Status } | { ok: false; errors: string[] } {
  const errors = check(x, { v: oneOf(1), online: (y) => typeof y === 'boolean', ts: (y) => y === undefined || ts(y), fw: (y) => y === undefined || (typeof y === 'string' && (y as string).length <= 40), tzMin: (y) => y === undefined || range(-720, 840)(y), rate: (y) => y === undefined || range(0.05, 1)(y) });
  return errors.length ? { ok: false, errors } : { ok: true, value: x as Status };
}
