import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRS, MOUNTING_PRESETS, dirsFromOrient, mountingCommand, type Dir } from './mounting';

describe('board mounting', () => {
  it('the default mounting is the identity', () => {
    expect(mountingCommand(DEFAULT_DIRS)).toEqual({ ok: true, command: '!orient +x +y +z', orient: '+x +y +z' });
  });

  it('reads head X from whichever board axis points left or right, negated for left', () => {
    // board X forward, Y left, Z up: head X (right) is board -Y, head Y (forward) is board +X
    expect(mountingCommand(['forward', 'left', 'up'])).toMatchObject({ ok: true, command: '!orient -y +x +z' });
    // board X to the right, Y down, Z forward ("standing on its edge"): head Y (forward) is board +Z, head Z (up) is board -Y
    expect(mountingCommand(['right', 'down', 'forward'])).toMatchObject({ ok: true, command: '!orient +x +z -y' });
    expect(mountingCommand(['left', 'forward', 'down'])).toMatchObject({ ok: true, command: '!orient -x +y -z' });
  });

  it('every preset is a valid rotation, and so is every one of the 24 possible mountings', () => {
    for (const p of MOUNTING_PRESETS) expect(mountingCommand(p.dirs).ok, p.name).toBe(true);
    const all: Dir[] = ['right', 'left', 'forward', 'back', 'up', 'down'];
    let valid = 0, handed = 0, repeated = 0;
    for (const a of all) for (const b of all) for (const c of all) {
      const r = mountingCommand([a, b, c]);
      if (r.ok) valid++; else if (/right-handed/.test(r.error)) handed++; else repeated++;
    }
    expect(valid).toBe(24);                    // the 24 rotations of a cube
    expect(handed).toBe(24);                   // the 24 mirror images are refused
    expect(valid + handed + repeated).toBe(216);
  });

  it('refuses two axes along the same line, and mirror images, with a reason', () => {
    expect(mountingCommand(['right', 'left', 'up'])).toMatchObject({ ok: false, error: expect.stringMatching(/same line/) });
    expect(mountingCommand(['right', 'forward', 'down'])).toMatchObject({ ok: false, error: expect.stringMatching(/right-handed/) });
  });

  it('turns the headset\'s report back into directions', () => {
    expect(dirsFromOrient('+x+y+z')).toEqual(DEFAULT_DIRS);
    for (const p of MOUNTING_PRESETS) {
      const r = mountingCommand(p.dirs);
      if (r.ok) expect(dirsFromOrient(r.orient)).toEqual(p.dirs);
    }
    expect(dirsFromOrient('nonsense')).toBeNull();
    expect(dirsFromOrient('+x+x+z')).toBeNull();
  });
});
