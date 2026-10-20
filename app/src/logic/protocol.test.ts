import { describe, expect, it } from 'vitest';
import { parseTopic, topic, validateEvent, validateStatus, validateTelemetry, MAX_TELEMETRY_BYTES } from './protocol';
import { CloudSummarizer, type CloudMessage } from './cloudSummary';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseRecording } from './recording';
import { parseLine } from './csv';

const T = Date.UTC(2026, 9, 20, 8);
const tel = { v: 1, seq: 1, ts: T, per: 1, p: 1, r: 2, y: 3, tr: 1, ax: 5, dir: 2, f: 5.1, a: 12, sev: 3.4, wk: 0, hr: 72, sp: 97, ppg: 3, pf: 4, pt: -1, st: 'normal', rssi: -60, bat: null };

describe('topics', () => {
  it('build and parse', () => {
    const t = topic('ap-south-1:abc-123', 'htm-01', 'telemetry');
    expect(t).toBe('tremor/v1/ap-south-1:abc-123/htm-01/telemetry');
    expect(parseTopic(t)).toEqual({ owner: 'ap-south-1:abc-123', thing: 'htm-01', kind: 'telemetry' });
    expect(parseTopic('tremor/v1/a/b/other')).toBeNull();
  });
});

describe('validators', () => {
  it('accepts a valid telemetry message and rejects bad ones', () => {
    expect(validateTelemetry(tel).ok).toBe(true);
    for (const bad of [{ ...tel, v: 2 }, { ...tel, tr: 2 }, { ...tel, hr: 400 }, { ...tel, ts: 5 }, { ...tel, extra: 1 }, { ...tel, ax: 1.5 }, { ...tel, st: 'asleep' }, (({ seq: _s, ...x }) => x)(tel)]) {
      expect(validateTelemetry(bad).ok).toBe(false);
    }
    expect(JSON.stringify(tel).length).toBeLessThan(MAX_TELEMETRY_BYTES);
  });
  it('validates each event type', () => {
    expect(validateEvent({ v: 1, seq: 0, ts: T, type: 'tremor_start', ax: 4, f: 5 }).ok).toBe(true);
    expect(validateEvent({ v: 1, seq: 1, ts: T, type: 'episode', ep: { start: T - 9000, end: T, durationS: 9, axes: [0, 2], pattern: 'diagonal', ampDps: 12, freqHz: 5, score: 4, bpm: null } }).ok).toBe(true);
    expect(validateEvent({ v: 1, seq: 2, ts: T, type: 'fall', fall: { t: T, path: 'impact', peakG: 6, freeFallMs: 0, orientationChangeDeg: 70, outcome: 'pending' } }).ok).toBe(true);
    expect(validateEvent({ v: 1, seq: 3, ts: T, type: 'sensitivity', level: 6 }).ok).toBe(false);
    expect(validateEvent({ v: 1, seq: 4, ts: T, type: 'episode', ep: { start: T, end: T, durationS: 9, axes: [5], pattern: 'x', ampDps: 1, freqHz: 5, score: 11, bpm: null } }).ok).toBe(false);
    expect(validateEvent({ v: 1, seq: 5, ts: T, type: 'unknown' }).ok).toBe(false);
  });
  it('validates status', () => {
    expect(validateStatus({ v: 1, online: false }).ok).toBe(true);
    expect(validateStatus({ v: 1, online: true, ts: T, fw: 'm7', tzMin: 330, rate: 0.2 }).ok).toBe(true);
    expect(validateStatus({ v: 1, online: 'yes' }).ok).toBe(false);
  });
});

describe('CloudSummarizer on the real-firmware showcase', () => {
  const rec = parseRecording(gunzipSync(readFileSync(new URL('../../public/demo/showcase.rec.gz', import.meta.url))).toString('utf8'));
  const s = new CloudSummarizer(rec.start, 5);
  const out: CloudMessage[] = [];
  for (const [ms, line] of rec.entries) { const p = parseLine(line); if (p?.kind === 'frame') out.push(...s.push(p.frame, rec.start + ms)); }
  out.push(...s.close(rec.start + rec.entries.at(-1)![0]));
  const tels = out.filter((m) => m.kind === 'telemetry').map((m) => m.msg);
  const evs = out.filter((m) => m.kind === 'event').map((m) => m.msg as { type: string });

  it('sends one telemetry message per 5 s, all valid and compact', () => {
    const dur = (rec.entries.at(-1)![0]) / 1000;
    expect(tels.length).toBeGreaterThanOrEqual(Math.floor(dur / 5) - 2);
    expect(tels.length).toBeLessThanOrEqual(Math.ceil(dur / 5) + 1);
    for (const m of tels) expect(validateTelemetry(m)).toMatchObject({ ok: true });
    expect(Math.max(...tels.map((m) => JSON.stringify(m).length))).toBeLessThan(400);
  });

  it('sends events on change: two tremor starts, two episodes (one combined), one fall', () => {
    for (const e of out.filter((m) => m.kind === 'event')) expect(validateEvent(e.msg)).toMatchObject({ ok: true });
    expect(evs.filter((e) => e.type === 'tremor_start')).toHaveLength(2);
    const eps = out.filter((m) => m.kind === 'event' && (m.msg as { type: string }).type === 'episode').map((m) => (m.msg as unknown as { ep: { axes: number[] } }).ep);
    expect(eps).toHaveLength(2);
    expect(eps[1].axes).toEqual([0, 2]);
    expect(evs.filter((e) => e.type === 'fall')).toHaveLength(1);
  });

  it('message budget: about 12 messages per minute at the 5 s rate', () => {
    const minutes = rec.entries.at(-1)![0] / 60000;
    expect(out.length / minutes).toBeLessThan(16);
  });
});
