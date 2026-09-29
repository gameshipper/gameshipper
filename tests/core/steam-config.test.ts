import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { stageGame } from '../../src/core/prepare/stage.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('steam config', () => {
  it('defaults steam.sdk to null and steam.overlay to auto', () => {
    expect(parseConfig({ name: 'x', version: '1.0.0' }).data!.steam).toEqual({
      appId: 480,
      depots: { windows: null, mac: null, linux: null },
      sdk: null,
      overlay: 'auto',
    });
  });

  it('accepts an SDK path and an overlay mode, and rejects unknown modes', () => {
    const good = parseConfig({ name: 'x', version: '1.0.0', steam: { sdk: '.sdk/steamworks_sdk_165.zip', overlay: 'repaint' } });
    expect(good.data!.steam).toMatchObject({ sdk: '.sdk/steamworks_sdk_165.zip', overlay: 'repaint' });
    const bad = parseConfig({ name: 'x', version: '1.0.0', steam: { overlay: 'sometimes' } });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toContain('steam.overlay');
  });
});

describe('stageGame', () => {
  it('never stages a Steamworks SDK or plugin code', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '',
      'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib': 'lib',
      'vendor/Steamworks_SDK_165.zip': 'zip',
      'plugins/echo.mjs': 'export default {}',
      'plugins/levels.json': '{}',
      'tools/big/index.mjs': '',
    });
    const config = parseConfig({ name: 'x', version: '1.0.0', plugins: ['plugins/echo.mjs', 'tools/big'] }).data!;
    const { stageDir } = await stageGame(testCtx(dir), config);
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    expect(exists('index.html')).toBe(true);
    expect(exists('plugins/levels.json')).toBe(true);
    for (const skipped of ['steamworks_sdk', 'vendor/Steamworks_SDK_165.zip', 'plugins/echo.mjs', 'tools/big']) {
      expect(exists(skipped), skipped).toBe(false);
    }
  });

  it('never stages a folder holding an unpacked SDK, whatever its name', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '',
      'third_party/readme.txt': '',
      'third_party/valve/redistributable_bin/osx/libsteam_api.dylib': 'lib',
      'third_party/valve/public/steam/steam_api.h': '',
      'redistributable_bin/linux64/libsteam_api.so': 'so',
    });
    const { stageDir } = await stageGame(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0' }).data!);
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    expect(exists('third_party/readme.txt')).toBe(true);
    for (const skipped of ['third_party/valve', 'redistributable_bin']) expect(exists(skipped), skipped).toBe(false);
  });

  it('never stages the SDK a build uses, whatever it is called, even through a link', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'vendor/valve.zip': 'zip', 'vendor/folder/lib.dylib': 'lib', 'vendor/keep.txt': '' });
    if (process.platform !== 'win32') fs.symlinkSync(path.join(dir, 'vendor', 'valve.zip'), path.join(dir, 'data.bin'));
    const exclude = [path.join(dir, 'vendor', 'valve.zip'), path.join(dir, 'vendor', 'folder')];
    const { stageDir } = await stageGame(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0' }).data!, { exclude });
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    expect(exists('vendor/keep.txt')).toBe(true);
    for (const skipped of ['vendor/valve.zip', 'vendor/folder', 'data.bin']) expect(exists(skipped), skipped).toBe(false);
  });

  it('never stages the SDK a build uses when its path is written in another letter case (case-insensitive disks)', async (ctx) => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'vendor/valve.zip': 'zip' });
    const otherCase = path.join(dir, 'Vendor', 'VALVE.zip');
    if (!fs.existsSync(otherCase)) ctx.skip('this disk is case-sensitive');
    const { stageDir } = await stageGame(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0' }).data!, { exclude: [otherCase] });
    expect(fs.existsSync(path.join(stageDir, 'vendor', 'valve.zip'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('never stages an SDK through a link with another name', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'vendor/steamworks_sdk_165.zip': 'zip' });
    fs.symlinkSync(path.join(dir, 'vendor', 'steamworks_sdk_165.zip'), path.join(dir, 'data.bin'));
    const config = parseConfig({ name: 'x', version: '1.0.0' }).data!;
    const { stageDir } = await stageGame(testCtx(dir), config);
    expect(fs.existsSync(path.join(stageDir, 'data.bin'))).toBe(false);
  });
});
