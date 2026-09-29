import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject } from '../../src/core/config/detect.js';
import { initProject } from '../../src/core/config/init.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

describe('detectProject', () => {
  it('plain folder with index.html', () => {
    const dir = path.join(makeTmpDir(), 'capybara-delivery');
    writeFiles(dir, { 'index.html': '', 'icon.png': '' });
    expect(detectProject(dir)).toEqual({
      name: 'Capybara Delivery',
      entry: 'index.html',
      buildCommand: null,
      outputDir: null,
      icon: 'icon.png',
    });
  });

  it('falls back to the first .html file', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'game.html': '', 'b.html': '' });
    expect(detectProject(dir).entry).toBe('b.html');
  });

  it('a missing folder detects nothing instead of throwing', () => {
    const dir = path.join(makeTmpDir(), 'nope');
    expect(detectProject(dir)).toEqual({ name: 'Nope', entry: null, buildCommand: null, outputDir: null, icon: null });
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
    expect(readText(dir, '.gitignore')).toContain('.gameshipper/');
    expect(readText(dir, '.gitignore')).toContain('out/');
    expect(r.data!.gitignoreUpdated).toBe(true);
    expect(r.warnings).toEqual([]);
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
});
