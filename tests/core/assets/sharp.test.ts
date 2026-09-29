import { describe, expect, it } from 'vitest';
import { loadSharp } from '../../../src/core/assets/sharp.js';
import { makeLogoPng, makeQuadrantPng, pixel } from '../../helpers/images.js';

describe('loadSharp', () => {
  it('loads sharp once and reuses it', async () => {
    const sharp = await loadSharp();
    expect(await loadSharp()).toBe(sharp);
    const meta = await sharp(await makeQuadrantPng(64, 32)).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([64, 32, 'png']);
  });
});

describe('image test helpers', () => {
  it('draw the colours and transparency they promise', async () => {
    const art = await makeQuadrantPng(100, 50);
    expect(await pixel(art, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(await pixel(art, 90, 10)).toEqual([0, 255, 0, 255]);
    expect(await pixel(art, 10, 40)).toEqual([0, 0, 255, 255]);
    expect(await pixel(art, 90, 40)).toEqual([255, 255, 0, 255]);
    const logo = await makeLogoPng(200, 100);
    expect((await pixel(logo, 2, 2))[3]).toBe(0);
    expect(await pixel(logo, 100, 50)).toEqual([255, 255, 255, 255]);
  });
});
