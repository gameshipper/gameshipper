import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/cli/help.js';
import { exitCodeFor } from '../../src/cli/output.js';
import { buildSummary } from '../../src/cli/summaries.js';
import { fail, gsError, ok } from '../../src/core/result.js';

describe('mobile projects in the CLI', () => {
  it('a bundle ID the stores reject is an input error (exit 2); generation failures are exit 1', () => {
    for (const code of ['BUNDLE_ID_REQUIRED', 'BUNDLE_ID_INVALID', 'VERSION_UNSUPPORTED']) expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(2);
    for (const code of ['MOBILE_GENERATE_FAILED', 'MOBILE_TEMPLATE_UNEXPECTED']) expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(1);
  });

  it('build --help mentions the mobile targets', () => {
    const build = COMMANDS.find((c) => c.name === 'build')!;
    expect(build.usage).toContain('--target windows,mac,linux,ios,android');
    expect(build.summary).toContain('iOS');
  });

  it('the build summary shows where the projects are and what to do with them', () => {
    const r = ok({
      outDir: '/p/out',
      targets: [
        { target: 'ios' as const, status: 'built' as const, mobile: { target: 'ios' as const, dir: '/p/out/ios', project: '/p/out/ios/App/App.xcodeproj' }, errors: [], warnings: [] },
        { target: 'android' as const, status: 'built' as const, mobile: { target: 'android' as const, dir: '/p/out/android', project: '/p/out/android' }, errors: [], warnings: [] },
      ],
    });
    expect(buildSummary(r, '/p')).toEqual([
      '✓ ios      out/ios/App/App.xcodeproj',
      '✓ android  out/android',
      '',
      'Next: `npx gameshipper check` tests the build against Steam and Steam Deck requirements.',
      'Mobile: open out/ios/App/App.xcodeproj in Xcode, or out/android in Android Studio, to sign and upload.',
    ]);
  });

  it('the Mobile line names only the projects that were built', () => {
    const ios = { target: 'ios' as const, status: 'built' as const, mobile: { target: 'ios' as const, dir: '/p/out/ios', project: '/p/out/ios/App/App.xcodeproj' }, errors: [], warnings: [] };
    const android = { target: 'android' as const, status: 'built' as const, mobile: { target: 'android' as const, dir: '/p/out/android', project: '/p/out/android' }, errors: [], warnings: [] };
    const failed = (target: 'ios' | 'android') => ({ target, status: 'failed' as const, errors: [gsError('MOBILE_GENERATE_FAILED', 'x')], warnings: [] });
    const mobileLine = (targets: object[]) => buildSummary(fail(gsError('MOBILE_GENERATE_FAILED', 'x'), [], { outDir: '/p/out', targets } as never), '/p').find((l) => l.startsWith('Mobile:'));
    expect(mobileLine([ios, failed('android')])).toBe('Mobile: open out/ios/App/App.xcodeproj in Xcode to sign and upload.');
    expect(mobileLine([failed('ios'), android])).toBe('Mobile: open out/android in Android Studio to sign and upload.');
    expect(mobileLine([failed('ios'), failed('android')])).toBeUndefined();
  });
});
