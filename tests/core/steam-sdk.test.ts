import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { ensureSteamSdk, findSteamSdk, newestFirst, sdkMissingWarning, type FindSdkOptions } from '../../src/core/steam/sdk.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';
import { makeZip } from '../helpers/zip.js';

const LIBS = {
  'redistributable_bin/win64/steam_api64.dll': 'dll',
  'redistributable_bin/win64/steam_api64.lib': 'import library, never shipped',
  'redistributable_bin/osx/libsteam_api.dylib': 'dylib',
  'redistributable_bin/linux64/libsteam_api.so': 'so',
};

/** A zip laid out like Valve's steamworks_sdk_<version>.zip. */
function sdkZip(version: string): Buffer {
  const files: Record<string, string> = { 'sdk/Readme.txt': `Welcome\n\nv${version} 23th July 2026\n`, 'sdk/steamworksexample/release/steam_appid.txt': '480' };
  for (const [rel, content] of Object.entries(LIBS)) files[`sdk/${rel}`] = content;
  return makeZip(files);
}

function options(projectDir: string, extra: Partial<FindSdkOptions> = {}): FindSdkOptions {
  return { projectDir, config: null, env: {}, cacheDir: makeTmpDir('gs-cache-'), ...extra };
}

describe('findSteamSdk', () => {
  it('uses the newest .sdk/steamworks_sdk_*.zip in the project', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.sdk/steamworks_sdk_162.zip': sdkZip('1.62'), '.sdk/steamworks_sdk_165.zip': sdkZip('1.65'), '.sdk/notes.txt': '' });
    expect(findSteamSdk(options(dir))).toEqual({
      kind: 'project',
      path: path.join(dir, '.sdk', 'steamworks_sdk_165.zip'),
      format: 'zip',
      version: '1.65',
      targets: ['windows', 'mac', 'linux'],
      root: 'sdk/',
    });
  });

  it('uses a steamworks_sdk/ folder in the project (steamworks-ffi-node layout)', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib': 'dylib' });
    expect(findSteamSdk(options(dir))).toMatchObject({ kind: 'project', format: 'dir', version: null, targets: ['mac'], root: path.join(dir, 'steamworks_sdk') });
  });

  it('prefers --steam-sdk, then steam.sdk (relative to the project), then GAMESHIPPER_STEAM_SDK', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'a/steamworks_sdk_163.zip': sdkZip('1.63'), 'b/sdk.zip': sdkZip('1.64'), 'c/sdk.zip': sdkZip('1.65') });
    const config = parseConfig({ name: 'x', version: '1.0.0', steam: { sdk: 'b/sdk.zip' } }).data!;
    const env = { GAMESHIPPER_STEAM_SDK: path.join(dir, 'c', 'sdk.zip') };
    const flagPath = path.join(dir, 'a', 'steamworks_sdk_163.zip');
    expect(findSteamSdk(options(dir, { config, env, flagPath }))).toMatchObject({ kind: 'flag', version: '1.63' });
    expect(findSteamSdk(options(dir, { config, env }))).toMatchObject({ kind: 'config', version: '1.64', path: path.join(dir, 'b', 'sdk.zip') });
    expect(findSteamSdk(options(dir, { env }))).toMatchObject({ kind: 'env', version: '1.65' });
  });

  it('STEAM_SDK_INVALID when a configured or project SDK is not usable', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'notes.txt': 'hello', 'empty/.keep': '' });
    const config = parseConfig({ name: 'x', version: '1.0.0', steam: { sdk: 'notes.txt' } }).data!;
    expect(() => findSteamSdk(options(dir, { config }))).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'STEAM_SDK_INVALID' }) }));
    expect(() => findSteamSdk(options(dir, { flagPath: path.join(dir, 'empty') }))).toThrow(/isn't a usable Steamworks SDK/);
    expect(() => findSteamSdk(options(dir, { flagPath: path.join(dir, 'missing.zip') }))).toThrow(/missing\.zip/);
    writeFiles(dir, { '.sdk/steamworks_sdk_165.zip': 'half a download' });
    expect(() => findSteamSdk(options(dir))).toThrow(/\.sdk\/steamworks_sdk_165\.zip/);
  });

  it('falls back to the newest SDK already in the cache, else null', () => {
    const dir = makeTmpDir();
    const cacheDir = makeTmpDir('gs-cache-');
    expect(findSteamSdk(options(dir, { cacheDir }))).toBeNull();
    writeFiles(path.join(cacheDir, 'steamworks-sdk'), {
      '1.9/Readme.txt': 'v1.9 old',
      '1.9/redistributable_bin/osx/libsteam_api.dylib': 'old',
      '1.65/Readme.txt': 'v1.65 new',
      '1.65/redistributable_bin/osx/libsteam_api.dylib': 'new',
      '.extract-abc/redistributable_bin/osx/libsteam_api.dylib': 'partial',
    });
    expect(findSteamSdk(options(dir, { cacheDir }))).toMatchObject({ kind: 'cache', version: '1.65', format: 'dir' });
  });

  it('sorts versions numerically, unknown last', () => {
    expect(['1.9', null, '1.65', '1.62'].sort(newestFirst)).toEqual(['1.65', '1.62', '1.9', null]);
  });

  it('explains how to get the SDK when it is missing', () => {
    const w = sdkMissingWarning();
    expect(w.code).toBe('STEAM_SDK_MISSING');
    expect(w.fix).toContain('https://partner.steamgames.com/downloads/list');
    expect(w.fix).toContain('.sdk/');
  });
});

describe('ensureSteamSdk', () => {
  it('extracts only the libraries from a zip into the cache, once per version', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { '.sdk/steamworks_sdk_165.zip': sdkZip('1.65') });
    const ctx = testCtx(dir);
    const sdk = ensureSteamSdk(ctx, findSteamSdk(options(dir, { cacheDir: ctx.cacheDir }))!);
    expect(sdk.dir).toBe(path.join(ctx.cacheDir, 'steamworks-sdk', '1.65'));
    const files: string[] = fs.readdirSync(sdk.dir, { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(path.join(sdk.dir, f)).isFile());
    expect(files.map((f) => f.split(path.sep).join('/')).sort()).toEqual([
      'Readme.txt',
      'redistributable_bin/linux64/libsteam_api.so',
      'redistributable_bin/osx/libsteam_api.dylib',
      'redistributable_bin/win64/steam_api64.dll',
    ]);
    fs.rmSync(path.join(dir, '.sdk'), { recursive: true });
    expect(findSteamSdk(options(dir, { cacheDir: ctx.cacheDir }))).toMatchObject({ kind: 'cache', version: '1.65' });
  });

  it('keys zips without a version by their hash, and uses folders in place', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'custom.zip': makeZip({ 'redistributable_bin/osx/libsteam_api.dylib': 'dylib' }), 'folder/redistributable_bin/linux64/libsteam_api.so': 'so' });
    const ctx = testCtx(dir);
    const zipped = ensureSteamSdk(ctx, findSteamSdk(options(dir, { flagPath: path.join(dir, 'custom.zip') }))!);
    expect(path.basename(zipped.dir)).toMatch(/^sha256-[0-9a-f]{16}$/);
    expect(fs.readFileSync(path.join(zipped.dir, 'redistributable_bin', 'osx', 'libsteam_api.dylib'), 'utf8')).toBe('dylib');
    const folder = ensureSteamSdk(ctx, findSteamSdk(options(dir, { flagPath: path.join(dir, 'folder') }))!);
    expect(folder.dir).toBe(path.join(dir, 'folder'));
  });
});
