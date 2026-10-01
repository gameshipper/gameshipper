import { describe, expect, it } from 'vitest';
import { helpData } from '../../src/cli/help.js';
import { chromiumSwitches, isSoftwareGlNote, softwareGl } from '../../src/shell/flags.js';

describe('software WebGL for machines without a GPU', () => {
  it('lets WebGL fall back to SwiftShader only when asked', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(chromiumSwitches(platform)).not.toContainEqual(['enable-unsafe-swiftshader']);
      const ci = chromiumSwitches(platform, { softwareGl: true });
      expect(ci).toContainEqual(['enable-unsafe-swiftshader']);
      // Everything else stays the same, including the switch the Steam overlay needs.
      expect(ci.filter((s) => s[0] !== 'enable-unsafe-swiftshader')).toEqual(chromiumSwitches(platform));
    }
  });

  it("is honoured only in runs Gameshipper makes to look at the game, never in a player's launch of a shipped game", () => {
    const on = { GAMESHIPPER_SOFTWARE_GL: '1' };
    // A smoke run (play --smoke, play --packaged --smoke, check) or the unpackaged app play runs.
    expect(softwareGl({ ...on, GAMESHIPPER_SMOKE_SECONDS: '5' }, true)).toBe(true);
    expect(softwareGl(on, false)).toBe(true);
    // A shipped game started by a player, whatever their environment says.
    expect(softwareGl(on, true)).toBe(false);
    expect(softwareGl({ ...on, GAMESHIPPER_SMOKE_SECONDS: '0' }, true)).toBe(false);
    expect(softwareGl({ GAMESHIPPER_SOFTWARE_GL: '0', GAMESHIPPER_SMOKE_SECONDS: '5' }, false)).toBe(false);
    expect(softwareGl({}, false)).toBe(false);
  });

  it("knows Chromium's own console warnings about drawing WebGL in software from the game's", () => {
    // What a three.js game that never reads pixels back got on GitHub's Windows runner, which has no GPU.
    const note = '[.WebGL-0x2c9400450800]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels';
    expect(isSoftwareGlNote(note)).toBe(true);
    expect(isSoftwareGlNote(`${note} (this message will no longer repeat)`)).toBe(true);
    // The game's own WebGL mistakes and messages are still reported.
    expect(isSoftwareGlNote('[.WebGL-0x2c9400450800]GL Driver Message (OpenGL, Error, GL_INVALID_OPERATION, High): Error: 0x00000502, in drawArrays')).toBe(false);
    expect(isSoftwareGlNote('WebGL: INVALID_OPERATION: drawArrays: no buffer is bound to enabled attribute')).toBe(false);
    expect(isSoftwareGlNote('GPU stall due to ReadPixels')).toBe(false);
  });

  it('is listed with the environment variables Gameshipper reads', () => {
    expect(helpData().environment.find((e) => e.name === 'GAMESHIPPER_SOFTWARE_GL')?.description).toContain('GPU');
  });
});
