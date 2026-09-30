import { describe, expect, it } from 'vitest';
import { helpData } from '../../src/cli/help.js';
import { exitCodeFor } from '../../src/cli/output.js';
import { buildSummary } from '../../src/cli/summaries.js';
import { fail, gsError, ok } from '../../src/core/result.js';

describe('Mac signing in the CLI', () => {
  it('Apple setup problems are input errors (exit 2); signing failures are exit 1', () => {
    for (const code of ['APPLE_CREDENTIALS_INVALID', 'MAC_IDENTITY_NOT_FOUND']) expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(2);
    for (const code of ['MAC_SIGN_FAILED', 'NOTARIZE_FAILED', 'NOTARIZE_TOOL_MISSING', 'STAPLE_FAILED']) expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(1);
  });

  it('help --json lists every environment variable Gameshipper reads', () => {
    expect(helpData().environment.map((e) => e.name)).toEqual([
      'GAMESHIPPER_CACHE',
      'GAMESHIPPER_STEAM_SDK',
      'GAMESHIPPER_NPM_REGISTRY',
      'GAMESHIPPER_SOFTWARE_GL',
      'GAMESHIPPER_MAC_IDENTITY',
      'GAMESHIPPER_NOTARY_PROFILE',
      'GAMESHIPPER_NOTARY_KEYCHAIN',
      'GAMESHIPPER_NOTARY_KEY',
      'GAMESHIPPER_NOTARY_KEY_ID',
      'GAMESHIPPER_NOTARY_ISSUER',
    ]);
    expect(helpData().environment.every((e) => e.description.length > 10)).toBe(true);
  });

  it('the build summary says how the Mac app was signed', () => {
    const mac = (signing: 'developer-id' | 'adhoc' | 'unsigned', notarized: boolean) =>
      buildSummary(
        ok({
          outDir: '/p/out',
          targets: [
            {
              target: 'mac' as const,
              status: 'built' as const,
              output: { target: 'mac' as const, dir: '/p/out/mac', executable: '/p/out/mac/G.app/Contents/MacOS/G', warnings: [], mac: { signing, notarized } },
              errors: [],
              warnings: [],
            },
          ],
        }),
        '/p',
      )[0];
    expect(mac('adhoc', false)).toBe('✓ mac      out/mac/G.app/Contents/MacOS/G (ad-hoc signed)');
    expect(mac('developer-id', true)).toBe('✓ mac      out/mac/G.app/Contents/MacOS/G (signed and notarized)');
    expect(mac('developer-id', false)).toBe('✓ mac      out/mac/G.app/Contents/MacOS/G (signed, not notarized)');
    expect(mac('unsigned', false)).toBe('✓ mac      out/mac/G.app/Contents/MacOS/G (unsigned)');
  });
});
