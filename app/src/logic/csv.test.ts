import { describe, expect, it } from 'vitest';
import { formatLine, LineSplitter, parseLine, type Frame } from './csv';

// Real lines captured from the formats the legacy firmware has produced.
const FULL = '$,12.3,-4.5,30.1,1.20,-0.50,8.75,1,2,0.4,0.3,9.8,5.5,0.82,0,0.00,7,74,97,3,-12.4';
const OLD13 = '$,1.0,2.0,3.0,0.10,0.20,0.30,0,0,0.3,0.3,0.3,0.0,0.20';
const OLD16 = '$,1.0,2.0,3.0,0.10,0.20,0.30,0,1,0.3,0.3,0.3,0.0,0.20,1,1.85,0';

function frame(line: string): Frame {
  const r = parseLine(line);
  if (!r || r.kind !== 'frame') throw new Error('expected frame, got ' + JSON.stringify(r));
  return r.frame;
}

describe('parseLine', () => {
  it('parses a full 20-value line', () => {
    const f = frame(FULL);
    expect(f).toMatchObject({ pitch: 12.3, roll: -4.5, yaw: 30.1, fYaw: 8.75, tremor: true, dir: 2, ampY: 9.8, freq: 5.5, q: 0.82,
      walking: false, cycles: 7, bpm: 74, spo2: 97, ppgState: 3, pulse: -12.4, nValues: 20, extra: [] });
  });

  it('accepts the oldest 13-value shape with gait and vitals defaulted', () => {
    const f = frame(OLD13);
    expect(f.nValues).toBe(13);
    expect(f.walking).toBe(false);
    expect(f.stepHz).toBe(0);
    expect(f.ppgState).toBe(-1);
    expect(f.pulse).toBeNull();
  });

  it('accepts the 16-value shape (walking, stepHz, cycles)', () => {
    const f = frame(OLD16);
    expect(f.walking).toBe(true);
    expect(f.stepHz).toBeCloseTo(1.85);
    expect(f.dir).toBe(1);
    expect(f.ppgState).toBe(-1);
  });

  it('reads the axes mask and acceleration extremes (23-value shape)', () => {
    const f = frame(FULL + ',5,2.31,0.95');
    expect(f.axes).toBe(5);
    expect(f.aMax).toBeCloseTo(2.31);
    expect(f.aMin).toBeCloseTo(0.95);
    expect(f.extra).toEqual([]);
  });

  it('always includes the alerting axis in the mask, and clears it when there is no tremor', () => {
    expect(frame(FULL + ',1,1.0,1.0').axes).toBe(1 | 4);           // dir = 2 (yaw) added
    expect(frame(FULL.replace(',1,2,0.4', ',0,2,0.4') + ',5,1.0,1.0').axes).toBe(0);   // no tremor: mask ignored
  });

  it('derives the mask from tremor + dir for older firmware', () => {
    expect(frame(FULL).axes).toBe(4);
    expect(frame(FULL).aMax).toBeNull();
    expect(frame(OLD13).axes).toBe(0);
  });

  it('reads the compass state from the 24th value', () => {
    const f = frame(FULL + ',5,2.31,0.95,3');
    expect(f.magQ).toBe(3);
    expect(f.extra).toEqual([]);
    expect(frame(FULL + ',5,2.31,0.95').magQ).toBeNull();            // 23-value firmware: no compass field
    expect(frame(FULL + ',5,2.31,0.95,3,77').extra).toEqual([77]);   // later fields still land in extra
    expect(frame(FULL + ',5,2.31,0.95,9').magQ).toBeNull();          // not a compass state: kept raw
    expect(frame(FULL + ',5,2.31,0.95,9').extra).toEqual([9]);
  });

  it('keeps values appended after the known fields in extra', () => {
    expect(frame(FULL + ',5,2.31,0.95,42').extra).toEqual([42]);
    expect(frame(FULL + ',1.02,0,42').extra).toEqual([1.02, 0, 42]);   // not a valid mask: kept raw
  });

  it('returns status text for # lines', () => {
    expect(parseLine('# Calibrating: keep the board still')).toEqual({ kind: 'status', text: 'Calibrating: keep the board still' });
  });

  it('ignores blank lines and tolerates CR and spaces', () => {
    expect(parseLine('   ')).toBeNull();
    expect(frame(FULL + '\r').pulse).toBe(-12.4);
  });

  it.each([
    ['too few values', '$,1,2,3'],
    ['non-numeric value', '$,1.0,abc,3.0,0.10,0.20,0.30,0,0,0.3,0.3,0.3,0.0,0.20'],
    ['non-numeric (empty field)','$,1.0,,3.0,0.10,0.20,0.30,0,0,0.3,0.3,0.3,0.0,0.20'],
    ['tremor flag not 0/1', '$,1.0,2.0,3.0,0.10,0.20,0.30,2,0,0.3,0.3,0.3,0.0,0.20'],
    ['dir not 0/1/2', '$,1.0,2.0,3.0,0.10,0.20,0.30,0,3,0.3,0.3,0.3,0.0,0.20'],
    ['malformed header', '$x,1.0,2.0,3.0,0.10,0.20,0.30,0,0,0.3,0.3,0.3,0.0,0.20'],
    ['unknown line type', 'garbage from a half-received line'],
  ])('rejects: %s', (reason, line) => {
    const r = parseLine(line);
    expect(r?.kind).toBe('invalid');
    if (r?.kind === 'invalid') expect(r.reason).toContain(reason.split(' ')[0]);
  });

  it('treats a vitals block with an out-of-range ppgState as absent', () => {
    const f = frame('$,1.0,2.0,3.0,0.10,0.20,0.30,0,0,0.3,0.3,0.3,0.0,0.20,0,0.00,0,70,98,9,1.0');
    expect(f.ppgState).toBe(-1);
    expect(f.bpm).toBe(0);
  });
});

describe('formatLine', () => {
  it('round-trips through parseLine', () => {
    const line = FULL + ',5,2.31,0.95';
    expect(formatLine(frame(line))).toBe(line);
  });
});

describe('LineSplitter', () => {
  it('reassembles lines split across chunks and strips CR', () => {
    const s = new LineSplitter();
    expect(s.push('$,1,2')).toEqual([]);
    expect(s.push(',3\r\n# hi\n$,4')).toEqual(['$,1,2,3', '# hi']);
    expect(s.push('\n')).toEqual(['$,4']);
  });

  it('drops a runaway buffer with no newline', () => {
    const s = new LineSplitter(16);
    s.push('x'.repeat(40));
    expect(s.push('ok\n')).toEqual(['ok']);
  });
});
