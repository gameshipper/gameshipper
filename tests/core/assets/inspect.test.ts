import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { colourMix, frameInfo, imageInfo, inspectKeyArt, inspectLogo, isPlain } from '../../../src/core/assets/inspect.js';
import { makeLogoPng, makeQuadrantPng } from '../../helpers/images.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

function files(entries: Record<string, Buffer | string>): string {
  const dir = makeTmpDir();
  writeFiles(dir, entries);
  return dir;
}

const failure = (code: string) => expect.objectContaining({ error: expect.objectContaining({ code }) });

describe('imageInfo', () => {
  it('reads size and format, or null for non-images', async () => {
    const dir = files({ 'a.png': makeSolidPng(30, 20), 'b.jpg': await sharp(makeSolidPng(8, 4)).jpeg().toBuffer(), 'c.png': 'nope' });
    expect(await imageInfo(path.join(dir, 'a.png'))).toEqual({ width: 30, height: 20, format: 'png' });
    expect(await imageInfo(path.join(dir, 'b.jpg'))).toEqual({ width: 8, height: 4, format: 'jpeg' });
    expect(await imageInfo(path.join(dir, 'c.png'))).toBeNull();
    expect(await imageInfo(path.join(dir, 'missing.png'))).toBeNull();
  });
});

describe('inspectKeyArt', () => {
  it('accepts PNG or JPEG key art of at least 1280x720', async () => {
    const dir = files({ 'k.jpg': await sharp(await makeQuadrantPng(1280, 720)).jpeg().toBuffer() });
    expect(await inspectKeyArt(path.join(dir, 'k.jpg'))).toEqual({ width: 1280, height: 720, format: 'jpeg' });
  });

  it('KEYART_INVALID for unreadable files, KEYART_TOO_SMALL below 1280x720', async () => {
    const dir = files({ 'bad.png': 'GIF89a', 'small.png': makeSolidPng(1279, 720) });
    await expect(inspectKeyArt(path.join(dir, 'bad.png'))).rejects.toThrow(failure('KEYART_INVALID'));
    await expect(inspectKeyArt(path.join(dir, 'small.png'))).rejects.toThrow(failure('KEYART_TOO_SMALL'));
  });

  it('KEYART_INVALID for images that are not PNG or JPEG', async () => {
    const dir = files({ 'k.webp': await sharp(await makeQuadrantPng(1280, 720)).webp().toBuffer() });
    const error = await inspectKeyArt(path.join(dir, 'k.webp')).catch((e: { error: { code: string; message: string } }) => e.error);
    expect(error).toMatchObject({ code: 'KEYART_INVALID', message: 'keyArt k.webp is a WEBP image; it must be PNG or JPEG.' });
  });
});

describe('inspectLogo', () => {
  it('measures the logo with its transparent margins trimmed', async () => {
    const dir = files({ 'logo.png': await makeLogoPng(400, 200, 50) });
    expect(await inspectLogo(path.join(dir, 'logo.png'))).toEqual({ width: 400, height: 200, format: 'png', trimmed: { width: 300, height: 100 } });
  });

  it('LOGO_INVALID for non-PNGs, LOGO_NOT_TRANSPARENT for PNGs without transparency', async () => {
    const dir = files({
      'logo.jpg': await sharp(await makeLogoPng(400, 200)).flatten().jpeg().toBuffer(),
      'opaque.png': makeSolidPng(400, 200),
    });
    await expect(inspectLogo(path.join(dir, 'logo.jpg'))).rejects.toThrow(failure('LOGO_INVALID'));
    await expect(inspectLogo(path.join(dir, 'opaque.png'))).rejects.toThrow(failure('LOGO_NOT_TRANSPARENT'));
  });

  it('LOGO_INVALID for a fully transparent logo', async () => {
    const dir = files({ 'empty.png': makeSolidPng(400, 200, [255, 255, 255, 0]) });
    const error = await inspectLogo(path.join(dir, 'empty.png')).catch((e: { error: { code: string; message: string } }) => e.error);
    expect(error).toMatchObject({ code: 'LOGO_INVALID', message: 'logo empty.png is empty (fully transparent).' });
  });
});

describe('frameInfo', () => {
  it('calls a single-colour frame blank and anything with content not blank', async () => {
    const dir = files({ 'black.png': makeSolidPng(64, 40, [0, 0, 0, 255]), 'art.png': await makeQuadrantPng(64, 40) });
    expect(await frameInfo(path.join(dir, 'black.png'))).toEqual({
      width: 64,
      height: 40,
      blank: true,
      color: '#000000',
      plain: true,
      main: { share: 1, color: '#000000' },
    });
    expect(await frameInfo(path.join(dir, 'art.png'))).toMatchObject({ width: 64, height: 40, blank: false, plain: false, main: { share: 0.25 } });
  });
});

type Rgb = [number, number, number];
/** A frame of 10,000 RGB pixels: `count` pixels of each colour, in order. */
function pixels(parts: Array<[number, Rgb]>): Uint8Array {
  const out: number[] = [];
  for (const [count, rgb] of parts) for (let i = 0; i < count; i++) out.push(...rgb);
  expect(out.length).toBe(30_000);
  return Uint8Array.from(out);
}
const BLACK: Rgb = [0, 0, 0];
const greys = (count: number, each: number): Array<[number, Rgb]> => Array.from({ length: count }, (_, i) => [each, [40 + 32 * i, 40 + 32 * i, 40 + 32 * i]]);

describe('colourMix', () => {
  it('a loading screen: one colour, its text and the text’s antialiasing, is plain', () => {
    const mix = colourMix(pixels([[9850, BLACK], [100, [255, 255, 255]], ...greys(5, 10)]), 3);
    expect(mix).toEqual({ share: 0.985, color: '#000000', others: 1 });
    expect(isPlain(mix)).toBe(true);
  });

  it('a small, clearly varied scene on one background is not plain', () => {
    // The three.js spinning cube at 1280x800: three differently coloured faces on black.
    const mix = colourMix(pixels([[9567, BLACK], [289, [129, 190, 238]], [102, [64, 32, 183]], [32, [238, 72, 157]], ...greys(1, 10)]), 3);
    expect(mix).toMatchObject({ share: 0.9567, others: 3 });
    expect(isPlain(mix)).toBe(false);
  });

  it('only frames over 95% one colour are plain, counting near shades as that colour', () => {
    expect(isPlain(colourMix(pixels([[9600, BLACK], [400, [200, 0, 0]]]), 3))).toBe(true);
    expect(isPlain(colourMix(pixels([[9400, BLACK], [600, [200, 0, 0]]]), 3))).toBe(false);
    const noisy = colourMix(pixels([[9000, BLACK], [900, [10, 12, 8]], [100, [255, 255, 255]]]), 3);
    expect(noisy).toEqual({ share: 0.99, color: '#010101', others: 1 });
  });

  it('reads RGBA pixels', () => {
    const rgba = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]);
    expect(colourMix(rgba, 4)).toEqual({ share: 0.75, color: '#000000', others: 1 });
  });
});
