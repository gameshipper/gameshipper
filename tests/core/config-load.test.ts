import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../../src/core/config/load.js';
import { resolveDepots } from '../../src/core/config/schema.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('parseConfig', () => {
  it('fills defaults from a minimal config', () => {
    const r = parseConfig({ name: 'My Game', version: '1.0.0' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      game: { dir: '.', entry: 'index.html', buildCommand: null, outputDir: null },
      targets: ['windows', 'mac', 'linux', 'ios', 'android'],
      window: { width: 1280, height: 720, fullscreen: true, resizable: true },
      steam: { appId: 480, depots: { windows: null, mac: null, linux: null } },
      keyArtFocus: [0.5, 0.5],
      plugins: [],
    });
  });

  it('reports each bad field with its path', () => {
    const r = parseConfig({ name: 'x', version: 'one', window: { width: 'big' }, bogus: 1 });
    expect(r.ok).toBe(false);
    const messages = r.errors.map((e) => e.message).join('\n');
    expect(r.errors.every((e) => e.code === 'CONFIG_INVALID')).toBe(true);
    expect(messages).toContain('version');
    expect(messages).toContain('window.width');
    expect(messages).toContain('bogus');
  });

  it('requires outputDir when buildCommand is set', () => {
    const r = parseConfig({ name: 'x', version: '1.0.0', game: { buildCommand: 'npm run build' } });
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toContain('game.outputDir');
  });
});

describe('resolveDepots', () => {
  it('defaults to appId + 1/2/3', () => {
    const cfg = parseConfig({ name: 'x', version: '1.0.0', steam: { appId: 1000 } }).data!;
    expect(resolveDepots(cfg)).toEqual({ windows: 1001, mac: 1002, linux: 1003 });
  });
});

describe('loadConfig', () => {
  it('CONFIG_MISSING when there is no file', () => {
    const r = loadConfig(makeTmpDir());
    expect(r.errors[0].code).toBe('CONFIG_MISSING');
    expect(r.errors[0].fix).toContain('npx gameshipper init');
  });

  it('CONFIG_INVALID on broken JSON', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gameshipper.json': '{ "name": ' });
    expect(loadConfig(dir).errors[0].code).toBe('CONFIG_INVALID');
  });

  it('ENTRY_MISSING when the entry file does not exist', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    expect(loadConfig(dir).errors[0].code).toBe('ENTRY_MISSING');
  });

  it('ASSET_MISSING when icon points nowhere', () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '<html></html>',
      'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', icon: 'nope.png' }),
    });
    expect(loadConfig(dir).errors[0].code).toBe('ASSET_MISSING');
  });

  it('loads a valid project', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<html></html>', 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    const r = loadConfig(dir);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, r.data!.game.entry))).toBe(true);
  });
});
