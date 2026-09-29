import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The game's own process: Electron's main process, where the GPU also runs (`--in-process-gpu`),
 * steamworks-ffi-node loads Steam's libraries, and Steam injects its overlay.
 */
export const MAIN_ENTITLEMENTS = [
  // V8 compiles JavaScript at runtime (Electron requires this under the hardened runtime).
  'com.apple.security.cs.allow-jit',
  // Steam's steamclient.dylib and gameoverlayrenderer.dylib are signed by Valve, not by the game's team.
  'com.apple.security.cs.disable-library-validation',
  // Steam loads its overlay by launching games with DYLD_INSERT_LIBRARIES.
  'com.apple.security.cs.allow-dyld-environment-variables',
  // Microphone (voice chat), USB and Bluetooth controllers.
  'com.apple.security.device.audio-input',
  'com.apple.security.device.usb',
  'com.apple.security.device.bluetooth',
] as const;

/**
 * Electron's helper apps (renderer, GPU, plugin, utility). They also run V8, and without a Team ID
 * (ad-hoc signing) they can only load Electron's framework with library validation off.
 * No DYLD entitlement, so Steam's overlay is only injected into the main process.
 */
export const HELPER_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.device.audio-input',
  'com.apple.security.device.usb',
  'com.apple.security.device.bluetooth',
] as const;

export function entitlementsPlist(keys: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...keys.flatMap((key) => [`\t<key>${key}</key>`, '\t<true/>']),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** True for the .app bundle itself and anything directly in its Contents/MacOS folder. */
export function isMainCode(file: string, appPath: string): boolean {
  return path.resolve(file) === path.resolve(appPath) || path.dirname(path.resolve(file)) === path.join(path.resolve(appPath), 'Contents', 'MacOS');
}

export interface EntitlementFiles {
  main: string;
  helper: string;
}

/** Writes main.plist and helper.plist into dir (the project's .gameshipper/sign folder). */
export function writeEntitlementFiles(dir: string): EntitlementFiles {
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, 'main.plist');
  const helper = path.join(dir, 'helper.plist');
  fs.writeFileSync(main, entitlementsPlist(MAIN_ENTITLEMENTS));
  fs.writeFileSync(helper, entitlementsPlist(HELPER_ENTITLEMENTS));
  return { main, helper };
}
