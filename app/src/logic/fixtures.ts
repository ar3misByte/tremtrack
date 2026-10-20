// Test helper: loads a gzipped firmware recording from __fixtures__ (made by tools/hostsim/make-fixtures.mjs).
// Node only (vitest); never imported by the app.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseLine, type Frame } from './csv';
import { parseRecording } from './recording';

export const FIXTURE_START = Date.parse('2026-01-01T00:00:00Z');
/** Scenario time (s) of a fixture timestamp: the host simulator starts scenarios after 5 s of warm-up. */
export const sceneS = (t: number) => (t - FIXTURE_START) / 1000 - 5;

export function loadFixture(name: string): { t: number; frame: Frame }[] {
  const txt = gunzipSync(readFileSync(new URL(`./__fixtures__/${name}.rec.gz`, import.meta.url))).toString('utf8');
  const rec = parseRecording(txt);
  const out: { t: number; frame: Frame }[] = [];
  for (const [ms, line] of rec.entries) {
    const p = parseLine(line);
    if (p?.kind === 'frame') out.push({ t: rec.start + ms, frame: p.frame });
  }
  return out;
}
