// One line of plain language for a cloud event, shared by the Cloud screen and the doctor dashboard.
import type { CloudEventRow } from './aws';
import { axesLong, fmtDuration, fmtScore } from '../logic/labels';
import type { Axis } from '../logic/csv';

export function eventText(e: CloudEventRow): string {
  if (e.type === 'episode' && e.ep) {
    const axes = e.ep.axes as Axis[];
    return `Tremor episode, ${fmtDuration(e.ep.durationS)}: ${axesLong(axes)}${e.ep.freqHz > 0 ? `, about ${e.ep.freqHz.toFixed(1)} Hz` : ''}. Score ${fmtScore(e.ep.score)} of 10.`;
  }
  if (e.type === 'fall' && e.fall) {
    const how = { pending: 'waiting for an answer', cancelled: 'the wearer said they are OK', confirmed: 'the wearer asked for help', 'no-response': 'nobody answered the countdown' }[e.fall.outcome] ?? e.fall.outcome;
    return `Possible fall (peak ${e.fall.peakG.toFixed(1)} g): ${how}.`;
  }
  if (e.type === 'sensitivity') return `Sensitivity set to ${e.level}.`;
  if (e.type === 'boot') return 'Headset started.';
  if (e.type === 'tremor_start') return 'Tremor started.';
  return e.type;
}
