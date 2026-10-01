import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles } from '../../../src/core/fsutil.js';
import { buildMobileTargets } from '../../../src/core/mobile/build-mobile.js';
import { SHIM_TAG } from '../../../src/core/mobile/shim.js';
import { mobileConfig } from '../../helpers/capacitor.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, readText, writeFiles } from '../../helpers/tmp.js';

function project() {
  const dir = makeTmpDir();
  const stageDir = path.join(dir, '.gameshipper', 'stage');
  writeFiles(stageDir, { 'index.html': '<!DOCTYPE html><html><head><title>Moon</title></head><body><script src="game.js"></script></body></html>', 'game.js': 'console.log(1)' });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  return { dir, stageDir, iconPng: path.join(dir, 'icon.png') };
}

/** Text files in a generated project that could point outside it. */
function externalRefs(root: string): string[] {
  return listFiles(root)
    .filter((f) => /(\.gradle|Package\.swift|\.pbxproj|\.xcconfig)$/.test(f))
    .filter((f) => readText(root, f).includes('node_modules'));
}

describe('buildMobileTargets', () => {
  it('generates self-contained out/ios and out/android projects', async () => {
    const { dir, stageDir, iconPng } = project();
    const results = await buildMobileTargets(testCtx(dir), mobileConfig(), ['ios', 'android'], { stageDir, iconPng });
    expect(results.map((r) => [r.target, 'error' in r ? r.error.code : 'ok'])).toEqual([
      ['ios', 'ok'],
      ['android', 'ok'],
    ]);
    expect(results[0]).toEqual({ target: 'ios', output: { target: 'ios', dir: path.join(dir, 'out/ios'), project: path.join(dir, 'out/ios/App/App.xcodeproj') } });
    expect(results[1]).toMatchObject({ output: { project: path.join(dir, 'out/android') } });

    const ios = path.join(dir, 'out/ios');
    const android = path.join(dir, 'out/android');
    expect(readText(ios, 'App/App/public/index.html')).toContain(SHIM_TAG);
    expect(readText(ios, 'App/App/public/game.js')).toBe('console.log(1)');
    expect(readText(ios, 'App/App/capacitor.config.json')).toContain('"appId": "com.jane.moongame"');
    expect(readText(android, 'app/src/main/assets/public/_gameshipper/mobile.js')).toContain('Preferences');
    expect(externalRefs(ios)).toEqual([]);
    expect(externalRefs(android)).toEqual([]);
    // Nothing from this computer: no path of an Android SDK, and nothing left of the Capacitor CLI's own home folder.
    expect(fs.existsSync(path.join(android, 'local.properties'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gameshipper/mobile/home'))).toBe(false);
    // Windows has no executable bits: there Android Studio and gradlew.bat run the build.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(android, 'gradlew')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dir, '.gameshipper/mobile/ios'))).toBe(false);
  });

  it('keeps the Xcode signing team across rebuilds', async () => {
    const { dir, stageDir, iconPng } = project();
    await buildMobileTargets(testCtx(dir), mobileConfig(), ['ios'], { stageDir, iconPng });
    const pbx = path.join(dir, 'out/ios/App/App.xcodeproj/project.pbxproj');
    fs.writeFileSync(pbx, fs.readFileSync(pbx, 'utf8').replace(/CODE_SIGN_STYLE = Automatic;/g, 'CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;'));
    await buildMobileTargets(testCtx(dir), mobileConfig(), ['ios'], { stageDir, iconPng });
    expect(fs.readFileSync(pbx, 'utf8').match(/DEVELOPMENT_TEAM = ABCDE12345;/g)).toHaveLength(2);
  });

  it('BUNDLE_ID_REQUIRED fails every mobile target without generating anything', async () => {
    const { dir, stageDir } = project();
    const config = mobileConfig({ mobile: { bundleId: null } });
    const results = await buildMobileTargets(testCtx(dir), config, ['ios', 'android'], { stageDir, iconPng: null });
    expect(results.map((r) => ('error' in r ? r.error.code : 'ok'))).toEqual(['BUNDLE_ID_REQUIRED', 'BUNDLE_ID_REQUIRED']);
    expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
  });

  it('an unexpected error fails only the mobile targets, with MOBILE_GENERATE_FAILED and the reason', async () => {
    const { dir, stageDir } = project();
    // The icon is gone: reading it throws a plain ENOENT error, not a Gameshipper one.
    const results = await buildMobileTargets(testCtx(dir), mobileConfig(), ['ios', 'android'], { stageDir, iconPng: path.join(dir, 'gone.png') });
    for (const r of results) {
      expect(r, r.target).toMatchObject({ error: { code: 'MOBILE_GENERATE_FAILED', message: expect.stringContaining('ENOENT') } });
      expect('error' in r && r.error.fix).toBeTruthy();
    }
    expect(results.map((r) => r.target)).toEqual(['ios', 'android']);
  });

  it('a workspace that cannot be prepared fails each mobile target instead of the whole build', async () => {
    const dir = makeTmpDir();
    const results = await buildMobileTargets(testCtx(dir), mobileConfig(), ['ios', 'android'], { stageDir: path.join(dir, 'no-stage'), iconPng: null });
    expect(results.map((r) => [r.target, 'error' in r ? r.error.code : 'ok'])).toEqual([
      ['ios', 'MOBILE_GENERATE_FAILED'],
      ['android', 'MOBILE_GENERATE_FAILED'],
    ]);
    expect('error' in results[0] && results[0].error.message).toContain('ENOENT');
  });

  it('no targets, no work', async () => {
    expect(await buildMobileTargets(testCtx(makeTmpDir()), mobileConfig(), [], { stageDir: '/nope', iconPng: null })).toEqual([]);
  });
});
