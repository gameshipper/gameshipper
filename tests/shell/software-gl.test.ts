import { describe, expect, it } from 'vitest';
import { helpData } from '../../src/cli/help.js';
import { chromiumSwitches, softwareGl } from '../../src/shell/flags.js';

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

  it('is listed with the environment variables Gameshipper reads', () => {
    expect(helpData().environment.find((e) => e.name === 'GAMESHIPPER_SOFTWARE_GL')?.description).toContain('GPU');
  });
});
