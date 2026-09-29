import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { buildNumber, bundleIdProblem, checkBundleId } from '../../../src/core/mobile/bundle-id.js';

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
});
