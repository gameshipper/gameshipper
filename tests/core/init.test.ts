import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../../src/core/config/detect.js';
import { initErrors, initProject } from '../../src/core/config/init.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

const ICON = makeSolidPng(1024, 1024);
const SMALL_ICON = makeSolidPng(512, 512);

describe('detectProject', () => {
  it('plain folder with index.html', () => {
    const dir = path.join(makeTmpDir(), 'capybara-delivery');
    writeFiles(dir, { 'index.html': '', 'icon.png': ICON });
    expect(detectProject(dir)).toEqual({
      name: 'Capybara Delivery',
      entry: 'index.html',
      buildCommand: null,
      outputDir: null,
      icon: 'icon.png',
      unsuitableIcon: null,
      keyArt: null,
      logo: null,
    });
  });

  it('only proposes an icon that is a square PNG of at least 1024x1024', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'icon.png': SMALL_ICON, 'art/icon.png': makeSolidPng(2048, 1024), 'assets/icon.png': ICON });
    expect(detectProject(dir)).toMatchObject({ icon: 'assets/icon.png', unsuitableIcon: null });
  });

  it('reports the first unsuitable icon when none qualifies', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'art/icon.png': SMALL_ICON, 'public/icon.png': 'not a png' });
    expect(detectProject(dir)).toMatchObject({ icon: null, unsuitableIcon: { path: 'art/icon.png', found: 'is 512x512' } });
    writeFiles(dir, { 'icon.png': 'GIF89a' });
    expect(detectProject(dir).unsuitableIcon).toEqual({ path: 'icon.png', found: "isn't a PNG file" });
  });

  it('falls back to the first .html file', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'game.html': '', 'b.html': '' });
    expect(detectProject(dir).entry).toBe('b.html');
  });

  it('a missing folder detects nothing instead of throwing', () => {
    const dir = path.join(makeTmpDir(), 'nope');
    expect(detectProject(dir)).toEqual({ name: 'Nope', entry: null, buildCommand: null, outputDir: null, icon: null, unsuitableIcon: null, keyArt: null, logo: null });
  });

  it('Vite project with a build script', () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'package.json': JSON.stringify({ name: '@me/space-game', scripts: { build: 'vite build' }, devDependencies: { vite: '^7' } }),
      'index.html': '',
    });
    expect(detectProject(dir)).toMatchObject({ name: 'Space Game', buildCommand: 'npm run build', outputDir: 'dist', entry: 'index.html' });
  });
});

describe('initProject', () => {
  it('writes a complete gameshipper.json using detection plus answers', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', '.gitignore': 'node_modules/\n' });
    const r = initProject(dir, { name: 'Moon Game', appId: 1234567 });
    expect(r.ok).toBe(true);
    const written = JSON.parse(readText(dir, 'gameshipper.json'));
    expect(written).toMatchObject({ name: 'Moon Game', version: '1.0.0', steam: { appId: 1234567 }, game: { entry: 'index.html' } });
    // Desktop only: mobile targets are added on purpose.
    expect(written.targets).toEqual(['windows', 'mac', 'linux']);
    expect(readText(dir, '.gitignore')).toBe('node_modules/\n# Gameshipper\n.gameshipper/\nout/\n.sdk/\n');
    expect(r.data!.gitignoreUpdated).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('creates a .gitignore in a git repository that has none', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', '.git/HEAD': 'ref: refs/heads/main\n' });
    const r = initProject(dir);
    expect(r.data!.gitignoreUpdated).toBe(true);
    expect(readText(dir, '.gitignore')).toBe('# Gameshipper\n.gameshipper/\nout/\n.sdk/\n');
  });

  it('leaves a folder that is not a git repository without a .gitignore', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    expect(initProject(dir).data!.gitignoreUpdated).toBe(false);
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('adds only the lines a .gitignore is missing, however they are written', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', '.gitignore': '/out\r\n.gameshipper/' });
    expect(initProject(dir).data!.gitignoreUpdated).toBe(true);
    expect(readText(dir, '.gitignore')).toBe('/out\r\n.gameshipper/\n# Gameshipper\n.sdk/\n');
    expect(initProject(dir, { force: true }).data!.gitignoreUpdated).toBe(false);
  });

  it('warns when still using the test app', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    expect(initProject(dir).warnings[0].code).toBe('STEAM_TEST_APP');
  });

  it('refuses to overwrite without force', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': '{}' });
    expect(initProject(dir).errors[0].code).toBe('CONFIG_EXISTS');
    expect(initProject(dir, { force: true }).ok).toBe(true);
  });

  it('INPUT_REQUIRED when no HTML file can be found', () => {
    const dir = makeTmpDir();
    const r = initProject(dir);
    expect(r.errors[0].code).toBe('INPUT_REQUIRED');
    expect(r.errors[0].fix).toContain('--entry');
    expect(fs.existsSync(path.join(dir, 'gameshipper.json'))).toBe(false);
  });

  it('DIR_MISSING when the folder is missing or is a file, without creating anything', () => {
    const parent = makeTmpDir();
    const missing = path.join(parent, 'nope');
    const r = initProject(missing, { name: 'x', entry: 'index.html' });
    expect(r.errors).toEqual([
      { code: 'DIR_MISSING', message: `The folder ${missing} doesn't exist.`, fix: 'Check the path, or run the command from your game folder.' },
    ]);
    expect(fs.existsSync(missing)).toBe(false);
    writeFiles(parent, { 'file.txt': '' });
    const file = path.join(parent, 'file.txt');
    expect(initProject(file, { entry: 'index.html' }).errors[0]).toMatchObject({ code: 'DIR_MISSING', message: `${file} isn't a folder.` });
  });

  it('uses a detected icon that qualifies', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'icon.png': ICON });
    const r = initProject(dir, { appId: 1234567 });
    expect([r.ok, r.data!.config.icon, r.warnings]).toEqual([true, 'icon.png', []]);
  });

  it('ICON_UNSUITABLE when the detected icon is too small or not square: init succeeds without it', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'icon.png': SMALL_ICON });
    const r = initProject(dir, { appId: 1234567 });
    expect(r.ok).toBe(true);
    expect(r.data!.config.icon).toBeNull();
    expect(JSON.parse(readText(dir, 'gameshipper.json')).icon).toBeNull();
    expect(r.warnings).toEqual([
      {
        code: 'ICON_UNSUITABLE',
        message: "icon.png is 512x512; Steam needs a square PNG of at least 1024x1024, so it wasn't used.",
        fix: 'Export a square PNG of at least 1024x1024 and set "icon" in gameshipper.json to its path. Until then builds use the default Electron icon.',
      },
    ]);
  });

  it('checks an explicit --icon: a wrong size is left out with a warning, a missing file or a non-PNG is an error', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'art/wide.png': makeSolidPng(2048, 1024), 'art/big.png': ICON });
    const wide = initProject(dir, { appId: 1, icon: 'art/wide.png' });
    expect([wide.ok, wide.data!.config.icon]).toEqual([true, null]);
    expect(wide.warnings[0]).toMatchObject({ code: 'ICON_UNSUITABLE', message: expect.stringMatching(/^art\/wide\.png is 2048x1024; /) });

    const big = initProject(dir, { appId: 1, icon: 'art/big.png', force: true });
    expect([big.ok, big.data!.config.icon, big.warnings]).toEqual([true, 'art/big.png', []]);

    const other = makeTmpDir();
    writeFiles(other, { 'index.html': '', 'icon.jpg': 'JFIF' });
    const missing = initProject(other, { icon: 'nope.png' });
    expect(missing.errors).toEqual([{ code: 'ASSET_MISSING', message: "icon: nope.png doesn't exist.", fix: expect.stringContaining('--icon none') }]);
    // Paths in gameshipper.json are relative to the project folder, which isn't the game folder when a build makes it.
    expect(missing.errors[0].fix).toContain('relative to your project folder');
    const notPng = initProject(other, { icon: 'icon.jpg' });
    expect(notPng.errors).toEqual([{ code: 'ICON_INVALID', message: "icon: icon.jpg isn't a PNG file.", fix: expect.stringContaining('--icon') }]);
    expect(fs.existsSync(path.join(other, 'gameshipper.json'))).toBe(false);
    // "none" (null) means no icon, without looking for one.
    writeFiles(other, { 'icon.png': SMALL_ICON });
    const none = initProject(other, { icon: null, appId: 1 });
    expect([none.ok, none.data!.config.icon, none.warnings]).toEqual([true, null, []]);
  });

  it('ENTRY_MISSING for an --entry that does not exist, unless a build command makes it', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const r = initProject(dir, { entry: 'game.html' });
    expect(r.errors).toEqual([{ code: 'ENTRY_MISSING', message: "Can't find game.html.", fix: expect.stringContaining('--entry') }]);
    expect(r.errors[0].fix).toContain('relative to your project folder');
    expect(fs.existsSync(path.join(dir, 'gameshipper.json'))).toBe(false);
    const built = initProject(dir, { entry: 'game.html', buildCommand: 'npm run build', outputDir: 'dist' });
    expect(built.ok).toBe(true);
    expect(built.data!.config.game).toMatchObject({ entry: 'game.html', buildCommand: 'npm run build', outputDir: 'dist' });
  });

  it('initErrors lists what would stop init, without writing anything', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'small.png': SMALL_ICON });
    expect(initErrors(dir)).toEqual([]);
    expect(initErrors(dir, { icon: 'small.png' })).toEqual([]);
    expect(initErrors(dir, { entry: 'nope.html', icon: 'nope.png' }).map((e) => e.code)).toEqual(['ENTRY_MISSING', 'ASSET_MISSING']);
    writeFiles(dir, { 'gameshipper.json': '{}' });
    expect(initErrors(dir).map((e) => e.code)).toEqual(['CONFIG_EXISTS']);
    expect(initErrors(dir, { force: true })).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(['gameshipper.json', 'index.html', 'small.png']);
  });
});
