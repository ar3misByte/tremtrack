// Raw stream recordings (".rec"): exact protocol lines with their arrival time, for replaying a
// session later (stage fallback, bug reports, the bundled showcase made from the real firmware).
//
//   #REC v1 start=2026-10-20T08:00:00.000Z source=serial
//   0\t# Tremor Stream starting
//   20\t$,1.2,...
//
// Offsets are milliseconds from the start. Lines are stored verbatim (including '#' status lines).

export interface Recording { start: number; source: string; entries: [number, string][] }

export function formatRecording(r: Recording): string {
  const head = `#REC v1 start=${new Date(r.start).toISOString()} source=${r.source}`;
  return [head, ...r.entries.map(([ms, l]) => `${Math.round(ms)}\t${l}`)].join('\n') + '\n';
}

export function parseRecording(text: string): Recording {
  const lines = text.split(/\r?\n/);
  const m = /^#REC v1 start=(\S+)(?: source=(\S+))?/.exec(lines[0] ?? '');
  if (!m) throw new Error('Not a recording file (missing "#REC v1" header).');
  const start = Date.parse(m[1]);
  if (!Number.isFinite(start)) throw new Error('Recording header has an invalid start time.');
  const entries: [number, string][] = [];
  let last = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const tab = l.indexOf('\t');
    if (tab < 0) continue;
    const ms = Number(l.slice(0, tab));
    if (!Number.isFinite(ms) || ms < last) continue;            // skip garbage and out-of-order lines
    last = ms;
    entries.push([ms, l.slice(tab + 1)]);
  }
  if (!entries.length) throw new Error('Recording contains no data lines.');
  return { start, source: m[2] ?? 'unknown', entries };
}

/** Gzip helpers using the browser's CompressionStream (Chrome, Edge, Safari 16.4+, Firefox 113+). */
export async function gzipText(text: string): Promise<Blob> {
  const cs = new CompressionStream('gzip');
  return new Response(new Blob([text]).stream().pipeThrough(cs)).blob();
}
export async function gunzipToText(data: Blob | ArrayBuffer): Promise<string> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text();      // not gzipped
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
