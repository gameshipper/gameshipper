import { describe, expect, it } from 'vitest';
import { helpData } from '../../src/cli/help.js';
import { chromiumSwitches } from '../../src/shell/flags.js';

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

  it('is listed with the environment variables Gameshipper reads', () => {
    expect(helpData().environment.find((e) => e.name === 'GAMESHIPPER_SOFTWARE_GL')?.description).toContain('GPU');
  });
});
