import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectHostTools, planDesktopJobs } from '../../src/core/desktop/targets.js';
import { ELECTRON_VERSION, electronBinary } from '../../src/core/electron.js';

describe('electron', () => {
  it('pins the Electron version from the installed package', async () => {
    expect(ELECTRON_VERSION).toBe('44.4.5');
    expect(fs.existsSync(await electronBinary())).toBe(true);
  });
});

describe('planDesktopJobs', () => {
  const all = ['windows', 'mac', 'linux', 'ios', 'android'] as const;

  it('macOS host builds everything desktop, Mac as universal', () => {
    const plan = planDesktopJobs(all, 'darwin', { lipo: true });
    expect(plan.jobs.map((j) => [j.target, j.platform, j.arch])).toEqual([
      ['windows', 'win32', 'x64'],
      ['mac', 'darwin', 'universal'],
      ['linux', 'linux', 'x64'],
    ]);
    // ios and android aren't Electron packages: runBuild hands them to buildMobileTargets.
    expect(plan.skipped).toEqual([]);
  });

  it('Linux host builds an arm64 Mac app with a warning', () => {
    const mac = planDesktopJobs(['mac'], 'linux').jobs[0];
    expect([mac.arch, mac.warnings[0].code]).toEqual(['arm64', 'MAC_NOT_UNIVERSAL']);
  });

  it("macOS host without Apple's command-line tools builds an arm64 Mac app with a warning", () => {
    const mac = planDesktopJobs(['mac'], 'darwin', { lipo: false }).jobs[0];
    expect([mac.platform, mac.arch, mac.warnings[0].code]).toEqual(['darwin', 'arm64', 'MAC_NOT_UNIVERSAL']);
    expect(mac.warnings[0].fix).toContain('xcode-select --install');
  });

  it("checks for Apple's tools only when it plans a Mac app on a Mac", () => {
    const detect = vi.fn(() => ({ lipo: true }));
    planDesktopJobs(['windows', 'linux', 'ios'], 'darwin', detect);
    planDesktopJobs(['mac'], 'linux', detect);
    planDesktopJobs(['mac'], 'win32', detect);
    expect(detect).not.toHaveBeenCalled();
    expect(planDesktopJobs(['windows', 'mac'], 'darwin', detect).jobs.map((j) => j.arch)).toEqual(['x64', 'universal']);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('Windows host cannot build Mac', () => {
    const plan = planDesktopJobs(['windows', 'mac'], 'win32');
    expect(plan.jobs.map((j) => j.target)).toEqual(['windows']);
    expect(plan.skipped[0]).toMatchObject({ target: 'mac', fatal: true, reason: { code: 'MAC_BUILD_HOST' } });
  });
});

describe('detectHostTools', () => {
  it('finds lipo through xcrun only when xcode-select reports the command-line tools', () => {
    const calls: string[] = [];
    const runner = (ok: Record<string, boolean>) => (command: string, args: string[]) => {
      calls.push([command, ...args].join(' '));
      return ok[command] ?? false;
    };
    expect(detectHostTools('darwin', runner({ 'xcode-select': true, xcrun: true }))).toEqual({ lipo: true });
    expect(calls).toEqual(['xcode-select -p', 'xcrun --find lipo']);
    calls.length = 0;
    // Without the tools, xcrun would pop up an install dialog, so it must not run.
    expect(detectHostTools('darwin', runner({ 'xcode-select': false, xcrun: true }))).toEqual({ lipo: false });
    expect(calls).toEqual(['xcode-select -p']);
    expect(detectHostTools('darwin', runner({ 'xcode-select': true, xcrun: false }))).toEqual({ lipo: false });
  });

  it('never runs Apple tools on other hosts', () => {
    const run = () => {
      throw new Error('should not run');
    };
    expect(detectHostTools('linux', run)).toEqual({ lipo: false });
    expect(detectHostTools('win32', run)).toEqual({ lipo: false });
  });
});
