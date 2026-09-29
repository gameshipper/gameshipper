import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeIcons, pngSize } from '../../src/core/desktop/icons.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('pngSize', () => {
  it('reads width and height from the PNG header', () => {
    expect(pngSize(makeSolidPng(64, 32))).toEqual({ width: 64, height: 32 });
    expect(pngSize(Buffer.from('not a png'))).toBeNull();
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

  it('ICON_TOO_SMALL for small or non-square icons', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'small.png': makeSolidPng(512, 512), 'wide.png': makeSolidPng(2048, 1024) });
    for (const f of ['small.png', 'wide.png']) {
      expect(() => makeIcons(path.join(dir, f), path.join(dir, 'o'))).toThrow(
        expect.objectContaining({ error: expect.objectContaining({ code: 'ICON_TOO_SMALL' }) }),
      );
    }
  });

  it('ICON_INVALID for files that are not PNGs', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'icon.png': 'GIF89a' });
    expect(() => makeIcons(path.join(dir, 'icon.png'), path.join(dir, 'o'))).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'ICON_INVALID' }) }),
    );
  });
});
