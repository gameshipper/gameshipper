import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vendorAndroid, vendorIos } from '../../../src/core/mobile/vendor.js';
import { generatedPlatform } from '../../helpers/capacitor.js';
import { readText } from '../../helpers/tmp.js';

describe('copying native code out of node_modules', () => {
  it('iOS: copies the Preferences plugin next to the Xcode project', async () => {
    const { platformDir } = await generatedPlatform('ios');
    expect(vendorIos(platformDir)).toEqual(['CapacitorPreferences']);
    const pkg = readText(platformDir, 'App/CapApp-SPM/Package.swift');
    expect(pkg).toContain('.package(name: "CapacitorPreferences", path: "../CapacitorPlugins/CapacitorPreferences")');
    expect(pkg).toContain('https://github.com/ionic-team/capacitor-swift-pm.git');
    const plugin = path.join(platformDir, 'App/CapacitorPlugins/CapacitorPreferences');
    expect(fs.existsSync(path.join(plugin, 'Package.swift'))).toBe(true);
    expect(fs.existsSync(path.join(plugin, 'ios/Sources/PreferencesPlugin/PreferencesPlugin.swift'))).toBe(true);
    expect(fs.existsSync(path.join(plugin, 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(plugin, 'android'))).toBe(false);
  });

  it('Android: copies Capacitor and the Preferences plugin into capacitor-libs', async () => {
    const { platformDir } = await generatedPlatform('android');
    expect(vendorAndroid(platformDir)).toEqual(['capacitor-android', 'capacitor-preferences']);
    const settings = readText(platformDir, 'capacitor.settings.gradle');
    expect(settings).not.toContain('node_modules');
    expect(settings).toContain("project(':capacitor-android').projectDir = new File('capacitor-libs/capacitor-android')");
    expect(fs.existsSync(path.join(platformDir, 'capacitor-libs/capacitor-android/build.gradle'))).toBe(true);
    expect(fs.existsSync(path.join(platformDir, 'capacitor-libs/capacitor-android/LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(platformDir, 'capacitor-libs/capacitor-preferences/src/main/java'))).toBe(true);
  });
});
