import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { buildNumber, bundleIdProblem, checkBundleId, checkMobileVersion } from '../../../src/core/mobile/bundle-id.js';

const cfg = (bundleId: string | null) => parseConfig({ name: 'x', version: '1.0.0', mobile: { bundleId } }).data!;

describe('bundle IDs', () => {
  it('BUNDLE_ID_REQUIRED when unset, BUNDLE_ID_INVALID for Java keywords', () => {
    expect(checkBundleId(cfg(null))).toMatchObject({ code: 'BUNDLE_ID_REQUIRED', fix: expect.stringContaining('--bundle-id') });
    expect(checkBundleId(cfg('com.example.new'))).toMatchObject({ code: 'BUNDLE_ID_INVALID', message: expect.stringContaining('"new"') });
    expect(checkBundleId(cfg('com.example.New'))).toBeNull();
    expect(checkBundleId(cfg('com.jane.moongame'))).toBeNull();
  });

  it('says what is wrong with an ID the stores reject', () => {
    expect(bundleIdProblem('com.jane.moongame')).toBeNull();
    expect(bundleIdProblem('my-game')).toMatch(/com\.yourname\.yourgame/);
    expect(bundleIdProblem('com.jane.2fast')).toMatch(/com\.yourname\.yourgame/);
    expect(bundleIdProblem('com.int.game')).toContain('"int"');
  });

  it('derives a build number from the version', () => {
    expect(buildNumber('1.2.3')).toBe(1002003);
    expect(buildNumber('0.0.1')).toBe(1);
  });

  it('VERSION_UNSUPPORTED for versions whose build number would collide or pass Google Play\'s limit', () => {
    const version = (v: string) => parseConfig({ name: 'x', version: v, mobile: { bundleId: 'com.jane.moon' } }).data!;
    for (const ok of ['1.2.3', '0.999.999', '2099.999.999', '2100.0.0']) expect(checkMobileVersion(version(ok)), ok).toBeNull();
    for (const bad of ['1.1000.0', '1.0.1000', '2100.0.1', '3000.0.0', '99999.0.0']) {
      const e = checkMobileVersion(version(bad));
      expect(e, bad).toMatchObject({ code: 'VERSION_UNSUPPORTED', message: expect.stringContaining(bad), fix: expect.stringContaining('1002003') });
    }
  });
});
