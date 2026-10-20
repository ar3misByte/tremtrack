// A cloud telemetry summary (every 1-5 s) turned into the same '$' line the headset streams over USB, so the live
// view, the 3D head and the vitals can show a remote headset without any special case.
// What a summary does not carry stays at zero: the band-passed waveforms, the pulse wave, cycle counts.
import type { Telemetry } from '../logic/protocol';

export function telemetryToLine(t: Telemetry): string {
  const dir = t.dir;
  const amp = [0, 0, 0];
  if (t.tr || t.a > 0) amp[dir] = t.a;
  const f = (x: number, d: number) => x.toFixed(d);
  return [
    '$', f(t.p, 1), f(t.r, 1), f(t.y, 1), '0.00', '0.00', '0.00',
    t.tr ? '1' : '0', String(dir), f(amp[0], 1), f(amp[1], 1), f(amp[2], 1), f(t.f, 1), f(t.tr ? 0.8 : 0, 2),
    t.wk ? '1' : '0', f(t.wk ? 1.8 : 0, 2), '0',
    String(t.hr ?? 0), String(t.sp ?? 0), String(t.ppg), '0.0',
    String(t.ax), '1.00', '1.00',
  ].join(',');
}
