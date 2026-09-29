import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { makeStoreImages } from '../../../src/core/assets/store-images.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeLogoPng, makeQuadrantPng, pixel } from '../../helpers/images.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

const config = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', keyArt: 'art/key.png', logo: 'art/logo.png', ...extra }).data!;

function project(keyArt: Buffer, logo: Buffer): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'art/key.png': keyArt, 'art/logo.png': logo, 'out/store/screenshots/keep.png': 'x' });
  return dir;
}

describe('makeStoreImages', () => {
  it('writes all eight images at their exact sizes, logo on the capsules only', async () => {
    const dir = project(await makeQuadrantPng(3840, 2160), await makeLogoPng(1400, 600));
    const r = await makeStoreImages(testCtx(dir), config());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe('built');
    expect(r.dir).toBe(path.join(dir, 'out', 'store'));
    expect(r.images.map((i) => path.basename(i.file))).toEqual([
      'header_capsule.png',
      'small_capsule.png',
      'main_capsule.png',
      'vertical_capsule.png',
      'library_capsule.png',
      'library_header.png',
      'library_hero.png',
      'library_logo.png',
    ]);
    for (const image of r.images) {
      const meta = await sharp(image.file).metadata();
      expect([path.basename(image.file), meta.width, meta.height]).toEqual([path.basename(image.file), image.width, image.height]);
    }
    const store = path.join(dir, 'out', 'store');
    // The logo (white) sits in the middle of the capsules; the hero is key art only.
    expect(await pixel(path.join(store, 'header_capsule.png'), 460, 215)).toEqual([255, 255, 255, 255]);
    expect(await pixel(path.join(store, 'header_capsule.png'), 5, 5)).toEqual([255, 0, 0, 255]);
    expect(await pixel(path.join(store, 'library_hero.png'), 1000, 400)).toEqual([255, 0, 0, 255]);
    // The library logo is the logo alone on a transparent background.
    expect((await pixel(path.join(store, 'library_logo.png'), 0, 0))[3]).toBe(0);
    expect(await pixel(path.join(store, 'library_logo.png'), 640, 360)).toEqual([255, 255, 255, 255]);
    // Screenshots already in out/store are kept.
    expect(fs.existsSync(path.join(store, 'screenshots', 'keep.png'))).toBe(true);
  });

  it('centres crops on keyArtFocus', async () => {
    const dir = project(await makeQuadrantPng(3840, 2160), await makeLogoPng(1400, 600));
    await makeStoreImages(testCtx(dir), config({ keyArtFocus: [1, 1] }));
    // Focus bottom-right: the hero shows the yellow quadrant.
    expect(await pixel(path.join(dir, 'out', 'store', 'library_hero.png'), 3000, 1000)).toEqual([255, 255, 0, 255]);
  });

  it('warns when the key art or logo had to be enlarged', async () => {
    const dir = project(await makeQuadrantPng(1920, 1080), await makeLogoPng(440, 140));
    const r = await makeStoreImages(testCtx(dir), config());
    expect(r.status).toBe('built');
    expect(r.warnings.map((w) => w.code)).toEqual(['KEYART_LOW_RES', 'LOGO_LOW_RES']);
    expect(r.warnings[0].message).toContain('library_hero.png');
    expect(r.warnings[0].message).not.toContain('main_capsule.png');
    expect(r.warnings[1].message).toContain('library_logo.png');
  });

  it('flattens transparent key art onto black', async () => {
    const half = await sharp({ create: { width: 3840, height: 1080, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const art = await sharp({ create: { width: 3840, height: 2160, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
      .composite([{ input: half, left: 0, top: 1080 }])
      .png()
      .toBuffer();
    const dir = project(art, await makeLogoPng(1400, 600));
    expect((await makeStoreImages(testCtx(dir), config())).errors).toEqual([]);
    const store = path.join(dir, 'out', 'store');
    // Top half: transparent in the key art, black in the images. Bottom half: the red art.
    expect(await pixel(path.join(store, 'library_hero.png'), 100, 100)).toEqual([0, 0, 0, 255]);
    expect(await pixel(path.join(store, 'library_hero.png'), 100, 1200)).toEqual([255, 0, 0, 255]);
    expect(await pixel(path.join(store, 'header_capsule.png'), 5, 5)).toEqual([0, 0, 0, 255]);
  });

  it('replaces every image from an earlier build, keeping the screenshots', async () => {
    const dir = project(await makeQuadrantPng(3840, 2160), await makeLogoPng(1400, 600));
    writeFiles(dir, { 'out/store/renamed_capsule.png': makeSolidPng(10, 10), 'out/store/notes.txt': 'kept' });
    await makeStoreImages(testCtx(dir), config());
    const store = path.join(dir, 'out', 'store');
    expect(fs.existsSync(path.join(store, 'renamed_capsule.png'))).toBe(false);
    expect(fs.readdirSync(store).filter((f) => f.endsWith('.png'))).toHaveLength(8);
    expect(fs.existsSync(path.join(store, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(store, 'screenshots', 'keep.png'))).toBe(true);
  });

  it('skips with a warning when keyArt or logo is not set, removing images from an earlier build', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'out/store/header_capsule.png': makeSolidPng(920, 430), 'out/store/screenshots/keep.png': 'x' });
    const r = await makeStoreImages(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0', logo: 'l.png' }).data!);
    expect(r.status).toBe('skipped');
    expect(r.warnings.map((w) => w.code)).toEqual(['STORE_IMAGES_SKIPPED']);
    expect(r.warnings[0].message).toBe("Store images weren't made because keyArt is not set in gameshipper.json.");
    expect(fs.readdirSync(path.join(dir, 'out', 'store'))).toEqual(['screenshots']);
  });

  it('fails with the validation error for bad inputs, leaving no store images', async () => {
    const dir = project(await makeQuadrantPng(3840, 2160), makeSolidPng(800, 300));
    writeFiles(dir, { 'out/store/header_capsule.png': makeSolidPng(920, 430) });
    const r = await makeStoreImages(testCtx(dir), config());
    expect(r.status).toBe('failed');
    expect(r.errors.map((e) => e.code)).toEqual(['LOGO_NOT_TRANSPARENT']);
    expect(r.images).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'out', 'store'))).toEqual(['screenshots']);
  });
});
