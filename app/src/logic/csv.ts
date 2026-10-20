// Parser for the firmware's serial / WebSocket line protocol.
//
//   $,pitch,roll,yaw,fPitch,fRoll,fYaw,tremor,dir,ampP,ampR,ampY,freq,q,walking,stepHz,cycles,bpm,spo2,ppgState,pulse,axes,aMax,aMin,magq[,extra...]
//   # human-readable status
//
// Older firmware sends fewer fields; all three historical shapes are accepted:
//   13 values (14 comma-separated fields incl. '$'): orientation + tremor only
//   16 values (17 fields): + walking, stepHz, cycles
//   20 values (21 fields): + bpm, spo2, ppgState, pulse
//   23 values (24 fields): + axes (bit mask of shaking axes), aMax, aMin (|a| extremes, g)
//   24 values (25 fields): + magq (compass: 0 not fitted, 1 not calibrated, 2 calibrated but ignored now, 3 correcting yaw, 4 calibrating)   (current)
// New fields are only ever APPENDED; anything after the known values lands in `extra`.

export type Axis = 0 | 1 | 2;                 // 0 = pitch ("yes-yes"), 1 = roll (tilt), 2 = yaw ("no-no")
export type PpgState = -1 | 0 | 1 | 2 | 3;    // -1 = firmware does not send vitals; 0 no sensor; 1 no finger; 2 measuring; 3 valid

export interface Frame {
  pitch: number; roll: number; yaw: number;          // degrees
  fPitch: number; fRoll: number; fYaw: number;       // band-passed gyro, dps
  tremor: boolean;
  dir: Axis;
  ampP: number; ampR: number; ampY: number;          // band amplitude per axis, dps
  freq: number;                                      // Hz, 0 = none
  q: number;                                         // band energy share 0..1
  walking: boolean;
  stepHz: number;
  cycles: number;
  bpm: number;                                       // 0 = no valid reading
  spo2: number;                                      // 0 = no valid reading
  ppgState: PpgState;
  pulse: number | null;                              // filtered IR wave, null if not sent
  axes: number;                                      // bit mask of shaking axes (1 pitch, 2 roll, 4 yaw); older firmware: derived from tremor + dir
  aMax: number | null;                               // largest |a| (g) since the previous line, null if not sent
  aMin: number | null;                               // smallest |a| (g) since the previous line
  magQ: number | null;                               // compass state 0-4 (see above), null if the firmware does not send it
  nValues: number;                                   // how many values the line had (protocol shape)
  extra: number[];                                   // values appended by newer firmware
}

export type ParsedLine =
  | { kind: 'frame'; frame: Frame }
  | { kind: 'status'; text: string }
  | { kind: 'invalid'; reason: string; line: string };

const MIN_VALUES = 13;

export function parseLine(raw: string): ParsedLine | null {
  const line = raw.trim();
  if (!line) return null;
  if (line[0] === '#') return { kind: 'status', text: line.replace(/^#\s*/, '') };
  if (line[0] !== '$') return { kind: 'invalid', reason: 'unknown line type', line };

  const parts = line.split(',');
  if (parts[0] !== '$') return { kind: 'invalid', reason: 'malformed header', line };
  const v = parts.slice(1).map((s) => (s.trim() === '' ? NaN : Number(s)));
  if (v.length < MIN_VALUES) return { kind: 'invalid', reason: `too few values (${v.length})`, line };
  if (v.slice(0, MIN_VALUES).some((x) => !Number.isFinite(x))) return { kind: 'invalid', reason: 'non-numeric value', line };

  const tremor = v[6], dir = v[7];
  if (tremor !== 0 && tremor !== 1) return { kind: 'invalid', reason: 'tremor flag not 0/1', line };
  if (dir !== 0 && dir !== 1 && dir !== 2) return { kind: 'invalid', reason: 'dir not 0/1/2', line };

  const hasGait = v.length >= 16 && v.slice(13, 16).every(Number.isFinite);
  const hasVitals = v.length >= 20 && v.slice(16, 20).every(Number.isFinite) && [0, 1, 2, 3].includes(v[18]);
  const hasMotion = hasVitals && v.length >= 23 && Number.isInteger(v[20]) && v[20] >= 0 && v[20] <= 7 && Number.isFinite(v[21]) && Number.isFinite(v[22]);
  const dirBit = tremor === 1 ? 1 << dir : 0;
  const hasMag = hasMotion && v.length >= 24 && Number.isInteger(v[23]) && v[23] >= 0 && v[23] <= 4;

  const frame: Frame = {
    pitch: v[0], roll: v[1], yaw: v[2],
    fPitch: v[3], fRoll: v[4], fYaw: v[5],
    tremor: tremor === 1,
    dir: dir as Axis,
    ampP: v[8], ampR: v[9], ampY: v[10],
    freq: v[11], q: v[12],
    walking: hasGait ? v[13] === 1 : false,
    stepHz: hasGait ? v[14] : 0,
    cycles: hasGait ? v[15] : 0,
    bpm: hasVitals ? v[16] : 0,
    spo2: hasVitals ? v[17] : 0,
    ppgState: hasVitals ? (v[18] as PpgState) : -1,
    pulse: hasVitals ? v[19] : null,
    axes: hasMotion ? (tremor === 1 ? v[20] | dirBit : 0) : dirBit,
    aMax: hasMotion ? v[21] : null,
    aMin: hasMotion ? v[22] : null,
    magQ: hasMag ? v[23] : null,
    nValues: v.length,
    extra: v.length > (hasMag ? 24 : hasMotion ? 23 : 20) ? v.slice(hasMag ? 24 : hasMotion ? 23 : 20) : [],
  };
  return { kind: 'frame', frame };
}

/** Builds a protocol line from a frame (used by the demo generator and the device simulator). */
export function formatLine(f: Omit<Frame, 'nValues' | 'extra' | 'axes' | 'aMax' | 'aMin' | 'magQ'> & { axes?: number; aMax?: number | null; aMin?: number | null; magQ?: number | null; extra?: number[] }): string {
  const n = (x: number, d: number) => x.toFixed(d);
  const parts = [
    '$', n(f.pitch, 1), n(f.roll, 1), n(f.yaw, 1), n(f.fPitch, 2), n(f.fRoll, 2), n(f.fYaw, 2),
    f.tremor ? '1' : '0', String(f.dir), n(f.ampP, 1), n(f.ampR, 1), n(f.ampY, 1), n(f.freq, 1), n(f.q, 2),
    f.walking ? '1' : '0', n(f.stepHz, 2), String(Math.round(f.cycles)),
    String(Math.round(f.bpm)), String(Math.round(f.spo2)), String(f.ppgState < 0 ? 0 : f.ppgState), n(f.pulse ?? 0, 1),
  ];
  if (f.axes !== undefined) parts.push(String(f.axes), n(f.aMax ?? 1, 2), n(f.aMin ?? 1, 2));
  if (f.axes !== undefined && f.magQ !== undefined && f.magQ !== null) parts.push(String(f.magQ));
  for (const x of f.extra ?? []) parts.push(String(x));
  return parts.join(',');
}

/** Splits a byte/text stream into lines. Guards against a runaway buffer if no newline ever arrives. */
export class LineSplitter {
  private buf = '';
  constructor(private readonly maxBuffer = 4096) {}
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      out.push(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    if (this.buf.length > this.maxBuffer) this.buf = '';
    return out;
  }
}

/** Axes present in a bit mask, in axis order. */
export const axesOf = (mask: number): Axis[] => ([0, 1, 2] as Axis[]).filter((a) => (mask >> a) & 1);
