import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureAndroid, removeLocalProperties } from '../../../src/core/mobile/native-android.js';
import { configureIos, readDevelopmentTeam } from '../../../src/core/mobile/native-ios.js';
import { generatedPlatform, mobileConfig } from '../../helpers/capacitor.js';
import { makeTmpDir, readText, writeFiles } from '../../helpers/tmp.js';

describe('configureIos', () => {
  it('sets version, build number, deployment target, orientation and full screen', async () => {
    const { platformDir, config } = await generatedPlatform('ios');
    configureIos(platformDir, config, null);
    const plist = readText(platformDir, 'App/App/Info.plist');
    expect(plist).toMatch(/<key>UISupportedInterfaceOrientations<\/key>\s*<array>\s*<string>UIInterfaceOrientationLandscapeLeft<\/string>\s*<string>UIInterfaceOrientationLandscapeRight<\/string>\s*<\/array>/);
    expect(plist).not.toContain('UIInterfaceOrientationPortrait<');
    expect(plist).toContain('<key>UIRequiresFullScreen</key>\n\t<true/>');
    const pbx = readText(platformDir, 'App/App.xcodeproj/project.pbxproj');
    expect(pbx).toContain('MARKETING_VERSION = 1.2.3;');
    expect(pbx).toContain('CURRENT_PROJECT_VERSION = 1002003;');
    expect(pbx).not.toMatch(/IPHONEOS_DEPLOYMENT_TARGET = (?!16\.4;)/);
    expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.jane.moongame;');
    expect(pbx).not.toContain('DEVELOPMENT_TEAM');
    expect(readText(platformDir, '.gitignore')).not.toContain('App/App/public');
    if (process.platform === 'darwin') execFileSync('plutil', ['-lint', path.join(platformDir, 'App/App/Info.plist')]);
  });

  it('portrait games, and keeping the signing team picked in Xcode', async () => {
    const config = mobileConfig({ mobile: { bundleId: 'com.jane.moongame', orientation: 'portrait' } });
    const { platformDir } = await generatedPlatform('ios', config);
    configureIos(platformDir, config, 'ABCDE12345');
    expect(readText(platformDir, 'App/App/Info.plist')).toMatch(/<key>UISupportedInterfaceOrientations<\/key>\s*<array>\s*<string>UIInterfaceOrientationPortrait<\/string>\s*<\/array>/);
    const pbx = readText(platformDir, 'App/App.xcodeproj/project.pbxproj');
    expect(pbx.match(/DEVELOPMENT_TEAM = ABCDE12345;/g)).toHaveLength(2);
    expect(readDevelopmentTeam(platformDir)).toBe('ABCDE12345');
    expect(readDevelopmentTeam(path.join(platformDir, 'nope'))).toBeNull();
  });

  it('MOBILE_TEMPLATE_UNEXPECTED when the template lacks what it edits', async () => {
    const { platformDir, config } = await generatedPlatform('ios');
    const plist = path.join(platformDir, 'App/App/Info.plist');
    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('<key>UISupportedInterfaceOrientations</key>', '<key>Renamed</key>'));
    expect(() => configureIos(platformDir, config, null)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'MOBILE_TEMPLATE_UNEXPECTED' }) }));
  });
});

describe('removeLocalProperties', () => {
  it("deletes the file that holds this computer's Android SDK path, and nothing else", () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'local.properties': 'sdk.dir=/Users/u/Library/Android/sdk\n', 'gradle.properties': 'android.useAndroidX=true\n', 'app/local.properties': 'kept' });
    removeLocalProperties(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['app', 'gradle.properties']);
    expect(readText(dir, 'app/local.properties')).toBe('kept');
  });

  it('does nothing in a project without one', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gradle.properties': '' });
    expect(() => removeLocalProperties(dir)).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['gradle.properties']);
  });
});

describe('configureAndroid', () => {
  it('sets version, versionCode and orientation', async () => {
    const { platformDir, config } = await generatedPlatform('android');
    configureAndroid(platformDir, config);
    const gradle = readText(platformDir, 'app/build.gradle');
    expect(gradle).toContain('versionCode 1002003');
    expect(gradle).toContain('versionName "1.2.3"');
    expect(gradle).toContain('applicationId "com.jane.moongame"');
    expect(readText(platformDir, 'app/src/main/AndroidManifest.xml')).toMatch(/android:name="\.MainActivity"\s+android:screenOrientation="sensorLandscape"/);
    expect(fs.existsSync(path.join(platformDir, 'app/src/main/java/com/jane/moongame/MainActivity.java'))).toBe(true);
    expect(readText(platformDir, '.gitignore')).not.toContain('\napp/src/main/assets/public\n');
  });

  it.runIf(spawnSync('git', ['--version']).status === 0)("its .gitignore never ignores the game's own files, whatever they're called", async () => {
    const { platformDir, config } = await generatedPlatform('android');
    configureAndroid(platformDir, config);
    const game = 'app/src/main/assets/public';
    // Capacitor's rules for build/, bin/, gen/, out/ and *.log match anywhere, like three.js's own build/ folder.
    const kept = [
      `${game}/_gameshipper/cdn/unpkg.com/three@0.170.0/build/three.module.js`,
      `${game}/bin/level.bin`,
      `${game}/gen/map.json`,
      `${game}/out/intro.png`,
      `${game}/debug.log`,
      `${game}/index.html`,
    ];
    const stillIgnored = ['build/outputs/app.apk', 'app/build/intermediates/x.dex', 'local.properties', 'debug.log'];
    writeFiles(platformDir, Object.fromEntries([...kept, ...stillIgnored].map((f) => [f, 'x'])));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: platformDir, encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    // Exit code 1: not ignored (-v would also show the last rule that matched, here the re-including one).
    for (const f of kept) expect(git('check-ignore', '-q', f).status, `${f}: ${git('check-ignore', '-v', f).stdout}`).toBe(1);
    for (const f of stillIgnored) expect(git('check-ignore', '-q', f).status, f).toBe(0);
    const untracked = git('status', '--porcelain', '--untracked-files=all').stdout;
    for (const f of kept) expect(untracked, f).toContain(`?? ${f}`);
  });
});
