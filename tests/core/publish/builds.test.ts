import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDesktopBuilds, mobileNextSteps } from '../../../src/core/publish/builds.js';
import { fakeProject } from '../../helpers/fake-builds.js';

describe('findDesktopBuilds', () => {
  it('finds every configured desktop build in out/', () => {
    const p = fakeProject();
    const r = findDesktopBuilds(p.dir, p.config);
    expect(r.errors).toEqual([]);
    expect(r.builds.map((b) => [b.target, path.relative(p.dir, b.executable)])).toEqual([
      ['windows', path.join('out', 'windows', 'Moon Game.exe')],
      ['mac', path.join('out', 'mac', 'Moon Game.app', 'Contents', 'MacOS', 'Moon Game')],
      ['linux', path.join('out', 'linux', 'moon-game')],
    ]);
  });

  it('names files the way the builds do: "Moon: Game" is Moon- Game.exe', () => {
    const p = fakeProject({ name: 'Moon: Game' }, ['windows']);
    expect(path.basename(p.builds[0].executable)).toBe('Moon- Game.exe');
  });

  it('BUILD_MISSING for each configured desktop target without a build', () => {
    const p = fakeProject({ targets: ['windows', 'linux'] }, ['windows']);
    const r = findDesktopBuilds(p.dir, p.config);
    expect(r.builds.map((b) => b.target)).toEqual(['windows']);
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['BUILD_MISSING', "No linux build to publish: out/linux/moon-game doesn't exist."]]);
    expect(r.errors[0].fix).toContain('npx gameshipper build');
  });

  it('BUILD_MISSING when there is no desktop target at all', () => {
    const p = fakeProject({ targets: ['ios'], mobile: { bundleId: 'com.moon.game' } }, []);
    expect(findDesktopBuilds(p.dir, p.config).errors.map((e) => e.message)).toEqual(['There are no desktop targets to publish.']);
  });
});

describe('mobileNextSteps', () => {
  it('says how to upload iOS and Android by hand, and to build them first', () => {
    const p = fakeProject({ targets: ['windows', 'ios', 'android'], mobile: { bundleId: 'com.moon.game' } }, ['windows']);
    fs.mkdirSync(path.join(p.dir, 'out', 'android'));
    const steps = mobileNextSteps(p.dir, p.config);
    expect(steps.map((s) => s.target)).toEqual(['ios', 'android']);
    expect(steps[0].steps[0]).toBe('Make the Xcode project first: `npx gameshipper build --target ios`.');
    expect(steps[0].steps).toContain('On a Mac, open out/ios/App/App.xcodeproj in Xcode and pick your signing team.');
    expect(steps[1].steps[0]).toBe('Open out/android in Android Studio.');
  });

  it('is empty for a desktop-only game', () => {
    const p = fakeProject();
    expect(mobileNextSteps(p.dir, p.config)).toEqual([]);
  });
});
