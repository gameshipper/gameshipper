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
    expect(scanBuildCode(asar)).toEqual({ gamepad: ['js/input.js'], textInputs: ['js/menu.js'], skipped: ['js/phaser.min.js'] });
  });

  it("skips engine and library code: node_modules, files over 1 MB and an engine's own files", async () => {
    const src = makeTmpDir();
    const pad = 'navigator.getGamepads()';
    writeFiles(src, {
      'game/index.html': '<canvas></canvas>',
      'game/node_modules/gamepad-lib/index.js': pad,
      'game/lib/phaser.js': pad,
      'game/lib/Phaser.min.js': pad,
      'game/assets/three.module.js': pad,
      'game/assets/three.core.js': pad,
      'game/assets/three.module.min.js': pad,
      'game/assets/babylon.max.js': pad,
      'game/assets/pixi.mjs': pad,
      'game/assets/index-9f2c1.js': `${pad};${' '.repeat(1024 * 1024)}`,
      // The game's own code, even when its name starts with or contains an engine's.
      'game/js/three-scene.js': pad,
      'game/js/main.three.js': pad,
      'game/js/three_utils.js': pad,
      'game/js/threefold.js': 'const rounds = 3;',
      'game/js/pixie-dust.js': pad,
    });
    const asar = path.join(makeTmpDir(), 'app.asar');
    await createPackage(src, asar);
    expect(scanBuildCode(asar)).toEqual({
      gamepad: ['js/main.three.js', 'js/pixie-dust.js', 'js/three-scene.js', 'js/three_utils.js'],
      textInputs: [],
      skipped: [
        'assets/babylon.max.js',
        'assets/index-9f2c1.js',
        'assets/pixi.mjs',
        'assets/three.core.js',
        'assets/three.module.js',
        'assets/three.module.min.js',
        'lib/Phaser.min.js',
        'lib/phaser.js',
        'node_modules/gamepad-lib/index.js',
      ],
    });
  });

  it('is null without an app.asar', () => {
    expect(scanBuildCode(path.join(makeTmpDir(), 'app.asar'))).toBeNull();
  });
});
