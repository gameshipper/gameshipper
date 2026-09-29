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

  it.skipIf(process.platform === 'win32')('never stages an SDK through a link with another name', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'vendor/steamworks_sdk_165.zip': 'zip' });
    fs.symlinkSync(path.join(dir, 'vendor', 'steamworks_sdk_165.zip'), path.join(dir, 'data.bin'));
    const config = parseConfig({ name: 'x', version: '1.0.0' }).data!;
    const { stageDir } = await stageGame(testCtx(dir), config);
    expect(fs.existsSync(path.join(stageDir, 'data.bin'))).toBe(false);
  });
});
