import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { frameInfo, imageInfo, inspectKeyArt, inspectLogo } from '../../../src/core/assets/inspect.js';
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
});

describe('frameInfo', () => {
  it('calls a single-colour frame blank and anything with content not blank', async () => {
    const dir = files({ 'black.png': makeSolidPng(64, 40, [0, 0, 0, 255]), 'art.png': await makeQuadrantPng(64, 40) });
    expect(await frameInfo(path.join(dir, 'black.png'))).toEqual({ width: 64, height: 40, blank: true, color: '#000000' });
    expect(await frameInfo(path.join(dir, 'art.png'))).toMatchObject({ width: 64, height: 40, blank: false });
  });
});
