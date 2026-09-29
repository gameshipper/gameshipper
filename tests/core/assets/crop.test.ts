import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverCrop } from '../../../src/core/assets/crop.js';
import { screenshotDirFor, STORE_IMAGES, storeDirFor } from '../../../src/core/assets/sizes.js';

const K4 = { width: 3840, height: 2160 };

describe('STORE_IMAGES', () => {
  it('lists the eight Steam images at the sizes in spec §8', () => {
    expect(STORE_IMAGES.map((s) => [s.file, s.width, s.height, s.kind])).toEqual([
      ['header_capsule.png', 920, 430, 'art+logo'],
      ['small_capsule.png', 462, 174, 'art+logo'],
      ['main_capsule.png', 1232, 706, 'art+logo'],
      ['vertical_capsule.png', 748, 896, 'art+logo'],
      ['library_capsule.png', 600, 900, 'art+logo'],
      ['library_header.png', 920, 430, 'art+logo'],
      ['library_hero.png', 3840, 1240, 'art'],
      ['library_logo.png', 1280, 720, 'logo'],
    ]);
  });

  it('lives in out/store, with screenshots in out/store/screenshots', () => {
    expect(storeDirFor('/p')).toBe(path.join('/p', 'out', 'store'));
    expect(screenshotDirFor('/p')).toBe(path.join('/p', 'out', 'store', 'screenshots'));
  });
});

describe('coverCrop', () => {
  it('centres a landscape crop by default', () => {
    expect(coverCrop(K4, { width: 920, height: 430 }, [0.5, 0.5])).toEqual({
      scale: 920 / 3840,
      resize: { width: 920, height: 518 },
      extract: { left: 0, top: 44, width: 920, height: 430 },
    });
  });

  it('moves the window towards the focus point and stops at the edges', () => {
    expect(coverCrop(K4, { width: 920, height: 430 }, [0, 0]).extract).toMatchObject({ left: 0, top: 0 });
    expect(coverCrop(K4, { width: 920, height: 430 }, [1, 1]).extract).toMatchObject({ left: 0, top: 88 });
    expect(coverCrop(K4, { width: 600, height: 900 }, [0.5, 0.5]).extract).toMatchObject({ left: 500, top: 0 });
    expect(coverCrop(K4, { width: 600, height: 900 }, [0.2, 0.5]).extract).toMatchObject({ left: 20, top: 0 });
    expect(coverCrop(K4, { width: 600, height: 900 }, [0.95, 0.5]).extract).toMatchObject({ left: 1000, top: 0 });
  });

  it('reports enlargement when the source is too small', () => {
    const c = coverCrop({ width: 1920, height: 1080 }, { width: 3840, height: 1240 }, [0.5, 0.5]);
    expect(c.scale).toBe(2);
    expect(c.resize).toEqual({ width: 3840, height: 2160 });
    expect(c.extract).toEqual({ left: 0, top: 460, width: 3840, height: 1240 });
  });

  it('never cuts outside the resized image, whatever the rounding', () => {
    for (const spec of STORE_IMAGES) {
      for (const src of [K4, { width: 1283, height: 721 }, { width: 5000, height: 5000 }, { width: 1280, height: 2000 }]) {
        const c = coverCrop(src, spec, [0.37, 0.81]);
        expect(c.extract.left + c.extract.width).toBeLessThanOrEqual(c.resize.width);
        expect(c.extract.top + c.extract.height).toBeLessThanOrEqual(c.resize.height);
        expect(Math.min(c.extract.left, c.extract.top)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
