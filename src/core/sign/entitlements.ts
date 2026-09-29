import * as fs from 'node:fs';
import * as path from 'node:path';

/** What decides a Mac app's entitlements. */
export interface EntitlementOptions {
  /** Signed ad-hoc: without a Team ID, library validation would stop Electron loading its own framework. */
  adhoc: boolean;
  /** The app bundles Steam (an SDK with a Mac library was found), which loads Valve's libraries and overlay into it. */
  steam: boolean;
}

// V8 compiles JavaScript at runtime (Electron requires this under the hardened runtime).
const JIT = 'com.apple.security.cs.allow-jit';
// Load libraries signed by another team: Valve's steamclient.dylib and gameoverlayrenderer.dylib, or, when signed
// ad-hoc, Electron's own framework (no Team ID matches no Team ID).
const NO_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
// Steam loads its overlay by launching games with DYLD_INSERT_LIBRARIES.
const DYLD_VARIABLES = 'com.apple.security.cs.allow-dyld-environment-variables';
// Microphone, for voice chat. (USB and Bluetooth entitlements only mean something inside the App Sandbox, which
// Steam games don't use: controllers work without them.)
const MICROPHONE = 'com.apple.security.device.audio-input';

/**
 * The game's own process: Electron's main process, where the GPU also runs (`--in-process-gpu`),
 * steamworks-ffi-node loads Steam's libraries, and Steam injects its overlay.
 */
export function mainEntitlements({ adhoc, steam }: EntitlementOptions): string[] {
  return [JIT, ...(adhoc || steam ? [NO_LIBRARY_VALIDATION] : []), ...(steam ? [DYLD_VARIABLES] : []), MICROPHONE];
}

/**
 * Electron's helper apps (renderer, GPU, plugin, utility). They run V8 too, and load nothing of Steam's: no DYLD
 * entitlement, so Steam's overlay is only injected into the main process.
 */
export function helperEntitlements({ adhoc }: EntitlementOptions): string[] {
  return [JIT, ...(adhoc ? [NO_LIBRARY_VALIDATION] : []), MICROPHONE];
}

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

/**
 * Electron's crash reporter and Squirrel's updater (which Steam games never use): plain native programs that run
 * no JavaScript and load no one else's libraries, so they need no entitlements.
 */
const NO_ENTITLEMENTS = [/\/Contents\/Frameworks\/[^/]+\.framework\/Versions\/[^/]+\/Helpers\/chrome_crashpad_handler$/, /\/Contents\/Frameworks\/Squirrel\.framework\/Versions\/[^/]+\/Resources\/ShipIt$/];

/** Which entitlements a file inside the app is signed with. */
export function codeRole(file: string, appPath: string): 'main' | 'helper' | 'none' {
  if (isMainCode(file, appPath)) return 'main';
  const rel = `/${path.relative(appPath, file).split(path.sep).join('/')}`;
  return NO_ENTITLEMENTS.some((re) => re.test(rel)) ? 'none' : 'helper';
}

export interface EntitlementFiles {
  main: string;
  helper: string;
  /** An empty set, for code that needs none. */
  none: string;
}

/** Writes main.plist, helper.plist and none.plist into dir (the project's .gameshipper/sign folder). */
export function writeEntitlementFiles(dir: string, opts: EntitlementOptions): EntitlementFiles {
  fs.mkdirSync(dir, { recursive: true });
  const files = { main: path.join(dir, 'main.plist'), helper: path.join(dir, 'helper.plist'), none: path.join(dir, 'none.plist') };
  fs.writeFileSync(files.main, entitlementsPlist(mainEntitlements(opts)));
  fs.writeFileSync(files.helper, entitlementsPlist(helperEntitlements(opts)));
  fs.writeFileSync(files.none, entitlementsPlist([]));
  return files;
}
