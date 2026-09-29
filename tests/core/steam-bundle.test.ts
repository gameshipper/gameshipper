import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles } from '../../src/core/fsutil.js';
import { bundleSteam } from '../../src/core/steam/bundle.js';
import { installedKoffiNative } from '../../src/core/steam/natives.js';
import type { SteamSdk } from '../../src/core/steam/sdk.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

function fakeSdk(targets: SteamSdk['targets'] = ['windows', 'mac', 'linux']): SteamSdk {
  const dir = makeTmpDir('gs-sdk-');
  writeFiles(dir, {
    'redistributable_bin/win64/steam_api64.dll': 'dll',
    'redistributable_bin/win64/steam_api64.lib': 'lib',
    'redistributable_bin/osx/libsteam_api.dylib': 'dylib',
    'redistributable_bin/linux64/libsteam_api.so': 'so',
    'steamworksexample/steam_appid.txt': '480',
  });
  return { dir, version: '1.65', targets, found: { kind: 'project', path: dir, format: 'dir', version: '1.65', targets, root: dir } };
}

/** Stand-ins for the per-OS koffi packages, so tests never download. */
function fakeNatives(): (id: string) => string {
  const root = makeTmpDir('gs-natives-');
  return (id) => {
    const dir = path.join(root, id);
    writeFiles(dir, { 'package.json': `{"name":"@koromix/koffi-${id}"}`, [`${id.replace('-', '_')}/koffi.node`]: 'native', 'README.md': '' });
    return dir;
  };
}

describe('bundleSteam', () => {
  it('adds nothing without an SDK', async () => {
    const appDir = makeTmpDir();
    expect(await bundleSteam(testCtx(appDir), appDir, null, [{ platform: 'darwin', arch: 'universal' }])).toEqual({ included: false, targets: [], warnings: [] });
    expect(fs.existsSync(path.join(appDir, 'node_modules'))).toBe(false);
  });

  it('copies the bridge, koffi, each target native and each target SDK library', async () => {
    const appDir = makeTmpDir();
    const natives = [
      { platform: 'darwin', arch: 'universal' },
      { platform: 'win32', arch: 'x64' },
    ];
    const r = await bundleSteam(testCtx(appDir), appDir, fakeSdk(), natives, { installed: fakeNatives() });
    expect(r).toEqual({ included: true, targets: ['mac', 'windows'], warnings: [] });
    const files = listFiles(appDir);
    for (const f of [
      'node_modules/steamworks-ffi-node/package.json',
      'node_modules/steamworks-ffi-node/dist/index.js',
      'node_modules/steamworks-ffi-node/prebuilds/darwin-arm64/steam-overlay.node',
      'node_modules/koffi/package.json',
      'node_modules/koffi/index.cjs',
      'node_modules/koffi/src/koffi/src/static.cjs',
      'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
      'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
      'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
      'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib',
      'steamworks_sdk/redistributable_bin/win64/steam_api64.dll',
    ]) {
      expect(files, f).toContain(f);
    }
    expect(files.filter((f) => /\.(md|d\.ts|map|lib|cc|S|asm)$/.test(f) || /steam_appid\.txt$/.test(f))).toEqual([]);
    expect(files.some((f) => f.startsWith('node_modules/koffi/vendor/') || f.startsWith('node_modules/koffi/doc/'))).toBe(false);
    expect(files).not.toContain('steamworks_sdk/redistributable_bin/linux64/libsteam_api.so');
  });

  it('warns when the SDK lacks a target library and skips that target', async () => {
    const appDir = makeTmpDir();
    const r = await bundleSteam(testCtx(appDir), appDir, fakeSdk(['mac']), [{ platform: 'linux', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }], {
      installed: fakeNatives(),
    });
    expect(r.targets).toEqual(['mac']);
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_SDK_MISSING']);
    expect(r.warnings[0].message).toContain('linux64/libsteam_api.so');
  });

  it('warns once per target without its library', async () => {
    const appDir = makeTmpDir();
    const natives = [
      { platform: 'linux', arch: 'x64' },
      { platform: 'linux', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' },
    ];
    const r = await bundleSteam(testCtx(appDir), appDir, fakeSdk(['mac']), natives, { installed: fakeNatives() });
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_SDK_MISSING']);
  });

  it('turns an unsupported computer into a warning, without Steam', async () => {
    const appDir = makeTmpDir();
    const r = await bundleSteam(testCtx(appDir), appDir, fakeSdk(), [{ platform: 'linux', arch: 'riscv64' }], { installed: () => null });
    expect(r.included).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_UNSUPPORTED_PLATFORM']);
  });

  it('never uses an npm-installed koffi for a CPU Steam has no libraries for (arm64 Linux and Windows)', async () => {
    for (const platform of ['linux', 'win32']) {
      const appDir = makeTmpDir();
      const r = await bundleSteam(testCtx(appDir), appDir, fakeSdk(), [{ platform, arch: 'arm64' }], { installed: fakeNatives() });
      expect(r, platform).toMatchObject({ included: false, warnings: [expect.objectContaining({ code: 'STEAM_UNSUPPORTED_PLATFORM' })] });
      expect(fs.existsSync(path.join(appDir, 'node_modules')), platform).toBe(false);
    }
  });

  it('produces a bridge that loads in Node on this computer', async () => {
    const appDir = makeTmpDir();
    const host = { platform: process.platform, arch: process.arch };
    await bundleSteam(testCtx(appDir), appDir, fakeSdk(), [host], { installed: installedKoffiNative });
    const script = `const m = require(${JSON.stringify(path.join(appDir, 'node_modules', 'steamworks-ffi-node'))}); console.log(typeof m.default.getInstance);`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('function');
  });
});
