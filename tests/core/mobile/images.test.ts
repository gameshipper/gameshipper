import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { pngSize } from '../../../src/core/desktop/icons.js';
import { writeAndroidImages, writeIosImages } from '../../../src/core/mobile/images.js';
import { generatedPlatform } from '../../helpers/capacitor.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, readText } from '../../helpers/tmp.js';

function icon(): string {
  const file = path.join(makeTmpDir(), 'icon.png');
  fs.writeFileSync(file, makeSolidPng(1024, 1024, [255, 120, 0, 128]));
  return file;
}

function snapshot(files: string[]) {
  return new Map(files.map((f) => [f, fs.readFileSync(f)]));
}

describe('writeIosImages', () => {
  it('replaces the app icon (opaque) and splash screens at their original sizes', async () => {
    const { platformDir } = await generatedPlatform('ios');
    const assets = path.join(platformDir, 'App/App/Assets.xcassets');
    const files = ['AppIcon.appiconset', 'Splash.imageset'].flatMap((d) =>
      fs.readdirSync(path.join(assets, d)).filter((f) => f.endsWith('.png')).map((f) => path.join(assets, d, f)),
    );
    const before = snapshot(files);
    expect(await writeIosImages(platformDir, icon())).toBe(4);
    for (const f of files) {
      expect(pngSize(fs.readFileSync(f))).toEqual(pngSize(before.get(f)!));
      expect(fs.readFileSync(f).equals(before.get(f)!)).toBe(false);
    }
    const appIcon = await sharp(path.join(assets, 'AppIcon.appiconset/AppIcon-512@2x.png')).metadata();
    expect([appIcon.width, appIcon.height, appIcon.hasAlpha]).toEqual([1024, 1024, false]);
  });
});

describe('writeAndroidImages', () => {
  it('replaces launcher icons, round icons, adaptive foregrounds and splashes', async () => {
    const { platformDir } = await generatedPlatform('android');
    const res = path.join(platformDir, 'app/src/main/res');
    // 5 densities × 3 launcher icons, plus 11 splash screens.
    expect(await writeAndroidImages(platformDir, icon())).toBe(26);
    const round = await sharp(path.join(res, 'mipmap-xxxhdpi/ic_launcher_round.png')).raw().toBuffer({ resolveWithObject: true });
    expect(round.info.width).toBe(192);
    expect(round.data[3]).toBe(0); // the corner is transparent
    const splash = await sharp(path.join(res, 'drawable-port-xxxhdpi/splash.png')).metadata();
    expect([splash.width, splash.height]).toEqual([1280, 1920]);
    expect(readText(res, 'values/ic_launcher_background.xml')).toContain('#000000');
  });
});
