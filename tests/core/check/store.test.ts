import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_IMAGES } from '../../../src/core/assets/sizes.js';
import { aiDisclosureCheck, screenshotsCheck, storeImagesCheck, trailerCheck } from '../../../src/core/check/store.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

const config = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', ...extra }).data!;

describe('storeImagesCheck', () => {
  it('passes when all eight images have exact sizes', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, Object.fromEntries(STORE_IMAGES.map((s) => [`out/store/${s.file}`, makeSolidPng(s.width, s.height)])));
    expect(await storeImagesCheck(dir, config())).toMatchObject({ id: 'store.images', status: 'pass' });
  });

  it('fails listing missing and wrong-size images, with a fix that fits the config', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, Object.fromEntries(STORE_IMAGES.slice(1).map((s) => [`out/store/${s.file}`, makeSolidPng(s.width, s.height)])));
    writeFiles(dir, { 'out/store/small_capsule.png': makeSolidPng(460, 174) });
    const c = await storeImagesCheck(dir, config());
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_STORE_IMAGES' });
    expect(c.details).toEqual(['header_capsule.png (Header capsule): missing', 'small_capsule.png (Small capsule): 460x174, needs 462x174']);
    expect(c.fix).toContain('Set "keyArt"');
    expect((await storeImagesCheck(dir, config({ keyArt: 'k.png', logo: 'l.png' }))).fix).toBe('Run `npx gameshipper build` to make them again.');
  });

  it('fails when the key art or logo changed after the images were made', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      ...Object.fromEntries(STORE_IMAGES.map((s) => [`out/store/${s.file}`, makeSolidPng(s.width, s.height)])),
      'art/key.png': 'k',
      'art/logo.png': 'l',
    });
    const at = (rel: string, seconds: number) => fs.utimesSync(path.join(dir, rel), seconds, seconds);
    const now = Math.floor(Date.now() / 1000);
    for (const s of STORE_IMAGES) at(`out/store/${s.file}`, now - 60);
    at('art/key.png', now - 120);
    at('art/logo.png', now - 120);
    const art = config({ keyArt: 'art/key.png', logo: 'art/logo.png' });
    expect((await storeImagesCheck(dir, art)).status).toBe('pass');

    at('art/logo.png', now);
    at('out/store/library_hero.png', now + 10);
    const c = await storeImagesCheck(dir, art);
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_STORE_IMAGES', fix: 'Run `npx gameshipper build` to make them again.' });
    expect(c.message).toBe('7 of 8 store images are older than art/logo.png: rebuild to refresh the store images.');
    expect(c.details).toEqual(STORE_IMAGES.filter((s) => s.file !== 'library_hero.png').map((s) => `${s.file} (${s.label}): older than art/logo.png`));
  });
});

describe('screenshotsCheck', () => {
  it('needs five 16:9 screenshots of at least 1920x1080', async () => {
    const dir = makeTmpDir();
    const shot = makeSolidPng(1920, 1080);
    writeFiles(dir, {
      'out/store/screenshots/1.png': shot,
      'out/store/screenshots/2.png': shot,
      'out/store/screenshots/3.png': shot,
      'out/store/screenshots/4.png': makeSolidPng(3840, 2160),
      'out/store/screenshots/small.png': makeSolidPng(1280, 720),
      'out/store/screenshots/notes.txt': 'ignored',
    });
    const c = await screenshotsCheck(dir);
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_SCREENSHOTS', details: ['small.png: 1280x720'] });
    expect(c.message).toBe('4 usable screenshots in out/store/screenshots; Steam needs at least 5 at 1920x1080.');
    writeFiles(dir, { 'out/store/screenshots/5.png': shot });
    expect(await screenshotsCheck(dir)).toMatchObject({ status: 'pass', message: '5 screenshots at 1920x1080 or larger.' });
  });

  it('fails when there is no screenshots folder', async () => {
    expect((await screenshotsCheck(makeTmpDir())).status).toBe('fail');
  });
});

describe('reminders', () => {
  it('trailer and AI disclosure are info only', () => {
    expect([trailerCheck().status, aiDisclosureCheck().status]).toEqual(['info', 'info']);
  });
});
