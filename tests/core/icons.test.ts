import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { iconFileProblem, iconProblem, makeIcons, pngSize } from '../../src/core/desktop/icons.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('pngSize', () => {
  it('reads width and height from the PNG header', () => {
    expect(pngSize(makeSolidPng(64, 32))).toEqual({ width: 64, height: 32 });
    expect(pngSize(Buffer.from('not a png'))).toBeNull();
  });
});

describe('iconProblem', () => {
  it('accepts square PNGs of at least 1024x1024', () => {
    expect(iconProblem(makeSolidPng(1024, 1024))).toBeNull();
    expect(iconProblem(makeSolidPng(2048, 2048))).toBeNull();
  });

  it('says what is wrong: not a PNG, not square (checked first), or too small', () => {
    expect(iconProblem(Buffer.from('GIF89a'))).toEqual({ code: 'ICON_INVALID', found: "isn't a PNG file" });
    expect(iconProblem(makeSolidPng(2048, 1024))).toEqual({ code: 'ICON_NOT_SQUARE', found: 'is 2048x1024' });
    expect(iconProblem(makeSolidPng(512, 256))).toEqual({ code: 'ICON_NOT_SQUARE', found: 'is 512x256' });
    expect(iconProblem(makeSolidPng(512, 512))).toEqual({ code: 'ICON_TOO_SMALL', found: 'is 512x512' });
  });

  it('iconFileProblem reads only the header, and treats unreadable files as not PNGs', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'small.png': makeSolidPng(512, 512), 'empty.png': '' });
    expect(iconFileProblem(path.join(dir, 'small.png'))).toMatchObject({ code: 'ICON_TOO_SMALL' });
    expect(iconFileProblem(path.join(dir, 'empty.png'))).toMatchObject({ code: 'ICON_INVALID' });
    expect(iconFileProblem(dir)).toMatchObject({ code: 'ICON_INVALID' });
    expect(iconFileProblem(path.join(dir, 'nope.png'))).toMatchObject({ code: 'ICON_INVALID' });
  });
});

describe('makeIcons', () => {
  it('writes .icns, .ico and .png next to each other and returns the base path', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
    const out = path.join(dir, 'icons');
    const base = makeIcons(path.join(dir, 'icon.png'), out);
    expect(base).toBe(path.join(out, 'icon'));
    expect(fs.readFileSync(`${base}.icns`).subarray(0, 4).toString('ascii')).toBe('icns');
    expect([...fs.readFileSync(`${base}.ico`).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(fs.readFileSync(`${base}.png`)).toEqual(fs.readFileSync(path.join(dir, 'icon.png')));
  });

  it('ICON_TOO_SMALL for small icons, ICON_NOT_SQUARE for non-square ones', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'small.png': makeSolidPng(512, 512), 'wide.png': makeSolidPng(2048, 1024) });
    expect(() => makeIcons(path.join(dir, 'small.png'), path.join(dir, 'o'), 'art/small.png')).toThrow(
      expect.objectContaining({
        error: {
          code: 'ICON_TOO_SMALL',
          message: 'art/small.png is 512x512; Steam needs a square PNG of at least 1024x1024.',
          fix: 'Export a square PNG of at least 1024x1024 and point "icon" in gameshipper.json at it.',
        },
      }),
    );
    expect(() => makeIcons(path.join(dir, 'wide.png'), path.join(dir, 'o'))).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ICON_NOT_SQUARE', message: expect.stringMatching(/^wide\.png is 2048x1024; /) }) }),
    );
    expect(fs.existsSync(path.join(dir, 'o'))).toBe(false);
  });

  it('ICON_INVALID for files that are not PNGs', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'icon.png': 'GIF89a' });
    expect(() => makeIcons(path.join(dir, 'icon.png'), path.join(dir, 'o'))).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ICON_INVALID' }) }),
    );
  });
});
