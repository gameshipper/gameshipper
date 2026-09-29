import * as path from 'node:path';
import { createPackage } from '@electron/asar';
import { describe, expect, it } from 'vitest';
import { appAsarPath, scanBuildCode } from '../../../src/core/check/scan.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

describe('appAsarPath', () => {
  it('knows where packager puts app.asar on each OS', () => {
    expect(appAsarPath('mac', '/o/mac/G.app/Contents/MacOS/G', '/o/mac')).toBe(path.join('/o/mac/G.app/Contents', 'Resources', 'app.asar'));
    expect(appAsarPath('linux', '/o/linux/g', '/o/linux')).toBe(path.join('/o/linux', 'resources', 'app.asar'));
    expect(appAsarPath('windows', '/o/windows/G.exe', '/o/windows')).toBe(path.join('/o/windows', 'resources', 'app.asar'));
  });
});

describe('scanBuildCode', () => {
  it("finds gamepad use and text fields in the game's own code only", async () => {
    const src = makeTmpDir();
    writeFiles(src, {
      'shell/preload.js': 'navigator.getGamepads()',
      'game/index.html': '<input type="hidden" name="x"><canvas></canvas>',
      'game/js/input.js': "window.addEventListener('gamepadconnected', start)",
      'game/js/menu.js': "const name = document.createElement('input');",
      'game/js/phaser.min.js': 'navigator.getGamepads()',
      'game/_gameshipper/cdn/unpkg.com/lib.js': 'navigator.getGamepads(); <textarea>',
      'game/levels/1.json': '"getGamepads"',
    });
    const asar = path.join(makeTmpDir(), 'app.asar');
    await createPackage(src, asar);
    expect(scanBuildCode(asar)).toEqual({ gamepad: ['js/input.js'], textInputs: ['js/menu.js'] });
  });

  it('is null without an app.asar', () => {
    expect(scanBuildCode(path.join(makeTmpDir(), 'app.asar'))).toBeNull();
  });
});
