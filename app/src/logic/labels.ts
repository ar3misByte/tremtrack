// Human-readable labels shared by screens and the report.
export const AXIS_LONG = ['Nodding ("yes-yes")', 'Tilting side to side', 'Turning ("no-no")'] as const;
export const AXIS_SHORT = ['Nod', 'Tilt', 'Turn'] as const;
export const AXIS_VAR = ['--axis-pitch', '--axis-roll', '--axis-yaw'] as const;
export const SOURCE_LABEL: Record<string, string> = {
  serial: 'USB', websocket: 'Wi-Fi', ble: 'Bluetooth', demo: 'Demo', replay: 'Replay', sample: 'Sample history',
};

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '–';
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  if (m < 60) return sec ? `${m} min ${sec} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
export const fmtMinutes = (s: number) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${(s / 60).toFixed(s < 600 ? 1 : 0)} min` : `${(s / 3600).toFixed(1)} h`);
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ms: number, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(ms).toLocaleDateString(undefined, opts);
export const fmtPct = (x: number) => (x < 0.001 && x > 0 ? '<0.1 %' : `${(100 * x).toFixed(x < 0.1 ? 1 : 0)} %`);
export const fmtScore = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toFixed(1));
