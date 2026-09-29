import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planDesktopJobs } from '../../src/core/desktop/targets.js';
import { ELECTRON_VERSION, electronBinary } from '../../src/core/electron.js';

describe('electron', () => {
  it('pins the Electron version from the installed package', () => {
    expect(ELECTRON_VERSION).toBe('44.4.5');
    expect(fs.existsSync(electronBinary())).toBe(true);
  });
});

describe('planDesktopJobs', () => {
  const all = ['windows', 'mac', 'linux', 'ios', 'android'] as const;

  it('macOS host builds everything desktop, Mac as universal', () => {
    const plan = planDesktopJobs(all, 'darwin');
    expect(plan.jobs.map((j) => [j.target, j.platform, j.arch])).toEqual([
      ['windows', 'win32', 'x64'],
      ['mac', 'darwin', 'universal'],
      ['linux', 'linux', 'x64'],
    ]);
    expect(plan.skipped.map((s) => [s.target, s.reason.code, s.fatal])).toEqual([
      ['ios', 'TARGET_NOT_YET_SUPPORTED', false],
      ['android', 'TARGET_NOT_YET_SUPPORTED', false],
    ]);
  });

  it('Linux host builds an arm64 Mac app with a warning', () => {
    const mac = planDesktopJobs(['mac'], 'linux').jobs[0];
    expect([mac.arch, mac.warnings[0].code]).toEqual(['arm64', 'MAC_NOT_UNIVERSAL']);
  });

  it('Windows host cannot build Mac', () => {
    const plan = planDesktopJobs(['windows', 'mac'], 'win32');
    expect(plan.jobs.map((j) => j.target)).toEqual(['windows']);
    expect(plan.skipped[0]).toMatchObject({ target: 'mac', fatal: true, reason: { code: 'MAC_BUILD_HOST' } });
  });
});
