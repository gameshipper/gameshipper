import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { entitlementsPlist, HELPER_ENTITLEMENTS, isMainCode, MAIN_ENTITLEMENTS, writeEntitlementFiles } from '../../../src/core/sign/entitlements.js';
import { makeTmpDir } from '../../helpers/tmp.js';

describe('entitlements', () => {
  it('lets Steam inject its overlay into the main process only', () => {
    expect(MAIN_ENTITLEMENTS).toContain('com.apple.security.cs.allow-dyld-environment-variables');
    expect(MAIN_ENTITLEMENTS).toContain('com.apple.security.cs.disable-library-validation');
    expect(HELPER_ENTITLEMENTS).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
    for (const list of [MAIN_ENTITLEMENTS, HELPER_ENTITLEMENTS]) {
      expect(list).toContain('com.apple.security.cs.allow-jit');
      expect(list.some((k) => k.includes('app-sandbox'))).toBe(false);
    }
  });

  it('writes a plist with every key set to true', () => {
    const xml = entitlementsPlist(['a.b', 'c.d']);
    expect(xml).toContain('<key>a.b</key>\n\t<true/>\n\t<key>c.d</key>\n\t<true/>');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('writes plists that plutil accepts', () => {
    const files = writeEntitlementFiles(path.join(makeTmpDir(), 'sign'));
    for (const f of [files.main, files.helper]) {
      expect(execFileSync('plutil', ['-lint', f], { encoding: 'utf8' })).toContain('OK');
    }
    expect(fs.readFileSync(files.helper, 'utf8')).not.toContain('allow-dyld');
  });

  it('treats the bundle and Contents/MacOS as main code', () => {
    const app = '/o/mac/Moon.app';
    expect(isMainCode(app, app)).toBe(true);
    expect(isMainCode(`${app}/Contents/MacOS/Moon`, app)).toBe(true);
    expect(isMainCode(`${app}/Contents/Frameworks/Moon Helper.app`, app)).toBe(false);
    expect(isMainCode(`${app}/Contents/Frameworks/Moon Helper.app/Contents/MacOS/Moon Helper`, app)).toBe(false);
    expect(isMainCode(`${app}/Contents/Resources/app.asar.unpacked/node_modules/koffi/build/koffi.node`, app)).toBe(false);
  });
});
