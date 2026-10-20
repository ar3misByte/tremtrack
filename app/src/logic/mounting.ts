// How the board sits on the head, in the words a person uses, and the `!orient` command the headset understands.
//
// The detector works in the HEAD's axes: X to the right, Y forward (the face), Z up. A board can be fixed to the head in any
// of 24 ways. For each of the board's three axes (the X, Y, Z printed on the MPU6050) the user says which way it points.
// The headset then reads head X from the board axis that points left or right (negated if it points left), and so on.
// Docs: docs/ORIENTATION.md

export type Dir = 'right' | 'left' | 'forward' | 'back' | 'up' | 'down';
export const DIRS: { id: Dir; label: string }[] = [
  { id: 'right', label: 'to the right ear' }, { id: 'left', label: 'to the left ear' },
  { id: 'forward', label: 'forward (the face)' }, { id: 'back', label: 'backward' },
  { id: 'up', label: 'up (the crown)' }, { id: 'down', label: 'down (the neck)' },
];
export const DEFAULT_DIRS: [Dir, Dir, Dir] = ['right', 'forward', 'up'];
export const MOUNTING_PRESETS: { name: string; dirs: [Dir, Dir, Dir] }[] = [
  { name: 'Default: X to the right, Y forward, Z up', dirs: ['right', 'forward', 'up'] },
  { name: 'Turned a quarter: X forward, Y to the left, Z up', dirs: ['forward', 'left', 'up'] },
  { name: 'Turned a quarter the other way: X back, Y to the right, Z up', dirs: ['back', 'right', 'up'] },
  { name: 'Turned half way round: X to the left, Y back, Z up', dirs: ['left', 'back', 'up'] },
  { name: 'Standing on its edge: X to the right, Y down, Z forward', dirs: ['right', 'down', 'forward'] },
  { name: 'Upside down: X to the left, Y forward, Z down', dirs: ['left', 'forward', 'down'] },
];

const HEAD = { right: 0, left: 0, forward: 1, back: 1, up: 2, down: 2 } as const;       // which head axis a direction is along
const SIGN = { right: 1, left: -1, forward: 1, back: -1, up: 1, down: -1 } as const;
const LETTER = ['x', 'y', 'z'] as const;

export type MountingResult = { ok: true; command: string; orient: string } | { ok: false; error: string };

/** dirs[k] = the way board axis k (X, Y, Z) points. */
export function mountingCommand(dirs: readonly [Dir, Dir, Dir]): MountingResult {
  const src: number[] = [-1, -1, -1], sgn = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    const h = HEAD[dirs[k]];
    if (src[h] !== -1) return { ok: false, error: 'Two board axes cannot point along the same line (for example both left and right). Give X, Y and Z one of the three lines each: left–right, forward–back, up–down.' };
    src[h] = k; sgn[h] = SIGN[dirs[k]];
  }
  const inv = (src[0] > src[1] ? 1 : 0) + (src[0] > src[2] ? 1 : 0) + (src[1] > src[2] ? 1 : 0);
  if (((inv % 2) ? -1 : 1) * sgn[0] * sgn[1] * sgn[2] !== 1) {
    return { ok: false, error: 'That cannot be a real mounting: X, Y and Z of a board always form a right-handed set. Change the direction of one axis to its opposite.' };
  }
  const orient = [0, 1, 2].map((h) => `${sgn[h] > 0 ? '+' : '-'}${LETTER[src[h]]}`).join(' ');
  return { ok: true, command: `!orient ${orient}`, orient };
}

/** The headset's own report ("+y-x+z" in `# INFO … orient=`) back into directions, to show what it is using. */
export function dirsFromOrient(orient: string): [Dir, Dir, Dir] | null {
  const m = /^([+-])([xyz])([+-])([xyz])([+-])([xyz])$/.exec(orient.replace(/\s+/g, ''));
  if (!m) return null;
  const out: Dir[] = ['right', 'forward', 'up'];
  const heads: Dir[][] = [['right', 'left'], ['forward', 'back'], ['up', 'down']];
  for (let h = 0; h < 3; h++) {
    const k = LETTER.indexOf(m[2 + 2 * h] as 'x');
    out[k] = heads[h][m[1 + 2 * h] === '+' ? 0 : 1];
  }
  const r = mountingCommand(out as [Dir, Dir, Dir]);
  return r.ok ? (out as [Dir, Dir, Dir]) : null;
}
