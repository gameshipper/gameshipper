import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeRole, entitlementsPlist, helperEntitlements, isMainCode, mainEntitlements, writeEntitlementFiles } from '../../../src/core/sign/entitlements.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const JIT = 'com.apple.security.cs.allow-jit';
const NO_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';
const DYLD = 'com.apple.security.cs.allow-dyld-environment-variables';
const MICROPHONE = 'com.apple.security.device.audio-input';
const ALL = [
  { adhoc: true, steam: true },
  { adhoc: true, steam: false },
  { adhoc: false, steam: true },
  { adhoc: false, steam: false },
];

describe('entitlements', () => {
  it('the main process: JIT always; DYLD variables and library validation off only with Steam (library validation also when ad-hoc)', () => {
    expect(mainEntitlements({ adhoc: false, steam: false })).toEqual([JIT, MICROPHONE]);
    expect(mainEntitlements({ adhoc: false, steam: true })).toEqual([JIT, NO_LIBRARY_VALIDATION, DYLD, MICROPHONE]);
    // Without a Team ID, library validation would stop the app loading Electron's own framework.
    expect(mainEntitlements({ adhoc: true, steam: false })).toEqual([JIT, NO_LIBRARY_VALIDATION, MICROPHONE]);
    expect(mainEntitlements({ adhoc: true, steam: true })).toEqual([JIT, NO_LIBRARY_VALIDATION, DYLD, MICROPHONE]);
  });

  it("helpers: library validation off only when ad-hoc, never DYLD variables, so Steam's overlay only goes into the main process", () => {
    expect(helperEntitlements({ adhoc: true, steam: true })).toEqual([JIT, NO_LIBRARY_VALIDATION, MICROPHONE]);
    expect(helperEntitlements({ adhoc: false, steam: true })).toEqual([JIT, MICROPHONE]);
    expect(helperEntitlements({ adhoc: false, steam: false })).toEqual([JIT, MICROPHONE]);
  });

  it('no App Sandbox, and no USB or Bluetooth entitlements (they only mean something inside the sandbox)', () => {
    for (const opts of ALL) {
      for (const key of [...mainEntitlements(opts), ...helperEntitlements(opts)]) expect(key).not.toMatch(/app-sandbox|device\.usb|device\.bluetooth/);
    }
  });

  it('writes a plist with every key set to true', () => {
    const xml = entitlementsPlist(['a.b', 'c.d']);
    expect(xml).toContain('<key>a.b</key>\n\t<true/>\n\t<key>c.d</key>\n\t<true/>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(entitlementsPlist([])).toContain('<dict>\n</dict>');
  });

  it.runIf(process.platform === 'darwin')('writes plists that plutil accepts', () => {
    const files = writeEntitlementFiles(path.join(makeTmpDir(), 'sign'), { adhoc: false, steam: true });
    for (const f of [files.main, files.helper, files.none]) {
      expect(execFileSync('plutil', ['-lint', f], { encoding: 'utf8' })).toContain('OK');
    }
    expect(fs.readFileSync(files.main, 'utf8')).toContain('allow-dyld');
    expect(fs.readFileSync(files.helper, 'utf8')).not.toContain('allow-dyld');
    expect(fs.readFileSync(files.none, 'utf8')).not.toContain('<key>');
  });

  it('treats the bundle and Contents/MacOS as main code', () => {
    const app = '/o/mac/Moon.app';
    expect(isMainCode(app, app)).toBe(true);
    expect(isMainCode(`${app}/Contents/MacOS/Moon`, app)).toBe(true);
    expect(isMainCode(`${app}/Contents/Frameworks/Moon Helper.app`, app)).toBe(false);
    expect(isMainCode(`${app}/Contents/Frameworks/Moon Helper.app/Contents/MacOS/Moon Helper`, app)).toBe(false);
    expect(isMainCode(`${app}/Contents/Resources/app.asar.unpacked/node_modules/koffi/build/koffi.node`, app)).toBe(false);
  });

  it("gives Electron's crash reporter and Squirrel's updater no entitlements", () => {
    const app = '/o/mac/Moon.app';
    expect(codeRole(`${app}/Contents/MacOS/Moon`, app)).toBe('main');
    expect(codeRole(`${app}/Contents/Frameworks/Moon Helper (Renderer).app`, app)).toBe('helper');
    expect(codeRole(`${app}/Contents/Frameworks/Moon Helper (GPU).app/Contents/MacOS/Moon Helper (GPU)`, app)).toBe('helper');
    expect(codeRole(`${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`, app)).toBe('none');
    expect(codeRole(`${app}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`, app)).toBe('none');
    // A game's own file that happens to share the name isn't Electron's.
    expect(codeRole(`${app}/Contents/Resources/app.asar.unpacked/ShipIt`, app)).toBe('helper');
  });
});
